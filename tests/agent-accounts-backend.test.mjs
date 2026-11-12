#!/usr/bin/env node
/**
 * agent-accounts 后端的行为回归测试。
 *
 * 为什么单独写一份、不用测试框架：
 *   插件后端跑在宿主的 goja 里，仓库里没有 JS 测试设施；
 *   这份脚本只依赖 Node 内置模块，`node backend/behavior.test.mjs` 就能跑，
 *   用假的 toolbox 对象喂各种服务端响应，锁住几个已经踩过的坑。
 *
 * 已锁定的问题（都是真实发生过的）：
 *   1. 「今天已签到」是 HTTP 400 + code 10001，不能报成失败；
 *   2. 签到状态字段是 today_checked_in，不是 state / checked；
 *   3. 任何账号都能直接签到，不必先设为当前；一键签到覆盖该来源全部账号；
 *   4. 一键签到里已签过的账号不再重复请求，个别失败不影响其余；
 *   5. 余量接口 200 但业务码非 0 时要报错，不能静默显示成余量 0；
 *   6. 服务端返回 HTML（网关层）时不能把整页 HTML 甩给用户。
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'plugins', 'agent-accounts', 'backend', 'index.js')

/** 起一个独立的「插件环境」，responses 按调用顺序依次返回 */
function createPlugin(responses, seed = {}) {
  const handlers = {}
  const store = { ...seed }
  const files = seed.__files || {}
  const dirs = seed.__dirs || {}
  const calls = []
  /** 完整请求地址：需要看清打到哪个主机（Windsurf 的 apiServerUrl 会变） */
  const urls = []
  /** 完整请求（含 headers / body）：需要校验身份头与请求体 */
  const requests = []
  let index = 0

  const toolbox = {
    plugin: { id: 'com.toolbox.agent-accounts', version: 'test', appVersion: '0.1.1' },
    handler: (name, fn) => {
      handlers[name] = fn
    },
    log: () => {},
    storage: {
      get: key => store[key] ?? '',
      set: (key, value) => {
        store[key] = value
      },
      all: () => ({ ...store }),
    },
    events: { emit: () => {} },
    // 本地回调服务：测试里直接拿到 handler，模拟浏览器回调
    server: {
      onRequest: (fn) => {
        handlers.__server = fn
      },
      start: () => {},
      stop: () => {},
    },
    // 随机与客户端登录态：测试注入假实现
    crypto: seed.__crypto || undefined,
    agentAuth: seed.__agentAuth || undefined,
    // 文件系统：测试用 seed.__files / seed.__dirs 注入，读写都走这里
    fs: {
      readText: path => files[path] || '',
      exists: path => Object.prototype.hasOwnProperty.call(files, path),
      list: path => dirs[path] || [],
      writeAs: (path, _name, content) => {
        files[path] = content
        return path
      },
    },
    http: {
      request: (req) => {
        calls.push(req.url.replace(/^https:\/\/[^/]+/, ''))
        urls.push(req.url)
        requests.push({ url: req.url, headers: req.headers || {}, body: req.body })
        const next = responses[index++ % responses.length]
        if (next.threw) {
          throw new Error(next.threw)
        }
        return { status: next.status, headers: {}, body: next.body, truncated: false }
      },
    },
  }

  const context = vm.createContext({
    toolbox,
    console,
    JSON,
    Date,
    Math,
    String,
    Number,
    Object,
    Array,
    RegExp,
    Error,
    isNaN,
    parseInt,
    encodeURIComponent,
  })
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), context, { filename: 'backend/index.js' })
  return { handlers, store, calls, urls, requests, files }
}

/** 调用 handler；出错时把消息返回而不是抛出（大部分用例就是要看错误文案） */
function callHandler(handlers, name, arg) {
  try {
    return { ok: true, value: handlers[name](arg) }
  }
  catch (error) {
    return { ok: false, error: error.message }
  }
}

const ACCOUNT = {
  id: 'acc_1',
  source: 'codebuddy-cn',
  name: 'tester@example.com',
  token: 'token-value',
  addedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  quota: null,
  checkin: null,
}

const SEED = {
  accounts: JSON.stringify([ACCOUNT]),
  current: JSON.stringify({ 'codebuddy-cn': ACCOUNT.id }),
}

/** 真实接口里的签到状态响应（2026-11 实测） */
const STATUS_CHECKED = {
  status: 200,
  body: JSON.stringify({
    code: 0,
    msg: 'OK',
    data: {
      active: true,
      today_checked_in: true,
      streak_days: 18,
      daily_credit: 100,
      today_credit: 100,
    },
  }),
}

const STATUS_UNCHECKED = {
  status: 200,
  body: JSON.stringify({
    code: 0,
    msg: 'OK',
    data: { active: true, today_checked_in: false, streak_days: 17 },
  }),
}

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

// ---- 1 & 2：今天已签到（HTTP 400 + code 10001）必须被识别为「已签过」
test('已签到（400 + code 10001）应视为成功而非失败', () => {
  // 状态接口直接说「今天签过」，因此不该再发签到请求
  const { handlers, calls } = createPlugin([STATUS_CHECKED], SEED)
  const result = callHandler(handlers, 'runAction', {
    action: 'checkin',
    source: 'codebuddy-cn',
    ids: [ACCOUNT.id],
  })
  assert.equal(result.ok, true)
  const item = result.value.results[0]
  assert.equal(item.ok, true, '已签到不该报失败')
  assert.equal(item.already, true)
  assert.equal(calls.length, 1, '只应查询一次状态，不应再打签到接口')
})

test('状态查询没读出结果时，签到接口的 400/10001 也要识别为已签过', () => {
  const { handlers } = createPlugin([
    // 状态接口返回了但字段不认识 → unknown，继续尝试签到
    { status: 200, body: JSON.stringify({ code: 0, data: {} }) },
    // 签到接口：真实服务端用 400 表达「今天已签到」
    { status: 400, body: JSON.stringify({ code: 10001, msg: '今天已签到，请明天再来' }) },
  ], SEED)
  const result = callHandler(handlers, 'runAction', {
    action: 'checkin',
    source: 'codebuddy-cn',
    ids: [ACCOUNT.id],
  })
  const item = result.value.results[0]
  assert.equal(item.ok, true, `「今天已签到」不该报失败: ${JSON.stringify(item)}`)
  assert.equal(item.already, true)
  assert.match(item.message, /今天已签到/)
})

test('today_checked_in 字段必须能被解析（真实字段名）', () => {
  // 已签到：状态接口给出 today_checked_in=true
  const checked = createPlugin([STATUS_CHECKED], SEED)
  const r1 = callHandler(checked.handlers, 'runAction', { action: 'checkin', source: 'codebuddy-cn', ids: [ACCOUNT.id] })
  assert.equal(r1.value.results[0].already, true)

  // 未签到：状态为 false，则必须真的去签到
  const unchecked = createPlugin([STATUS_UNCHECKED, { status: 200, body: JSON.stringify({ code: 0, msg: '签到成功' }) }], SEED)
  const r2 = callHandler(unchecked.handlers, 'runAction', { action: 'checkin', source: 'codebuddy-cn', ids: [ACCOUNT.id] })
  assert.equal(r2.value.results[0].ok, true)
  assert.equal(r2.value.results[0].already, false)
})

test('连续天数以服务端 streak_days 为准', () => {
  const { handlers } = createPlugin([STATUS_CHECKED], SEED)
  const result = callHandler(handlers, 'runAction', { action: 'checkin', source: 'codebuddy-cn', ids: [ACCOUNT.id] })
  const account = result.value.state.accounts[0]
  assert.equal(account.checkin.streak, 18, '应用服务端的 streak_days，而不是本地自增')
})

// ---- 3 & 4：任何账号都能直接签，一键签到覆盖该来源全部账号
test('非当前账号也能直接签到（不再要求先设为当前）', () => {
  const seed = {
    accounts: JSON.stringify([ACCOUNT, { ...ACCOUNT, id: 'acc_2' }]),
    current: JSON.stringify({ 'codebuddy-cn': ACCOUNT.id }),
  }
  // acc_2 不是当前账号，但签到接口认的是它自己的 token
  const { handlers, calls } = createPlugin([STATUS_UNCHECKED, { status: 200, body: JSON.stringify({ code: 0, msg: '签到成功' }) }], seed)
  const result = callHandler(handlers, 'runAction', {
    action: 'checkin',
    source: 'codebuddy-cn',
    ids: ['acc_2'],
  })
  assert.equal(result.value.results.length, 1, '应处理这一个账号')
  assert.equal(result.value.results[0].ok, true, `非当前账号应可签到: ${JSON.stringify(result.value.results[0])}`)
  assert.ok(calls.length >= 1, '应实际发出请求')
})

test('一键签到覆盖所有来源下的账号（不带来源参数）', () => {
  const seed = {
    accounts: JSON.stringify([ACCOUNT, { ...ACCOUNT, id: 'acc_2' }, { ...ACCOUNT, id: 'acc_3' }]),
    current: JSON.stringify({ 'codebuddy-cn': ACCOUNT.id }),
  }
  const { handlers, calls } = createPlugin([STATUS_UNCHECKED, { status: 200, body: JSON.stringify({ code: 0, msg: '签到成功' }) }], seed)
  const result = callHandler(handlers, 'runAction', { action: 'checkin-all' })
  assert.equal(result.value.results.length, 3, '三个账号都应被处理')
  assert.ok(result.value.results.every(item => item.ok), '全部应成功')
  assert.equal(calls.length, 6, '每个账号：先查状态 1 次 + 再签到 1 次')
})

test('一键签到只签「声明了签到能力」的来源', () => {
  const cursor = accountOf('cursor', 'cur-token')
  const seed = {
    accounts: JSON.stringify([ACCOUNT, cursor]),
    current: JSON.stringify({ 'codebuddy-cn': ACCOUNT.id }),
  }
  const { handlers, calls } = createPlugin([STATUS_UNCHECKED, { status: 200, body: JSON.stringify({ code: 0, msg: '签到成功' }) }], seed)
  const result = callHandler(handlers, 'runAction', { action: 'checkin-all' })
  assert.equal(result.value.results.length, 1, 'Cursor 不支持签到，不该出现在结果里')
  assert.equal(result.value.results[0].id, ACCOUNT.id)
  assert.equal(calls.length, 2)
})

test('一键签到会跳过今天已签过的账号，不重复请求', () => {
  const seed = {
    accounts: JSON.stringify([ACCOUNT, { ...ACCOUNT, id: 'acc_2' }]),
    current: JSON.stringify({ 'codebuddy-cn': ACCOUNT.id }),
  }
  // 两个账号的状态接口都说「今天签过」
  const { handlers, calls } = createPlugin([STATUS_CHECKED], seed)
  const result = callHandler(handlers, 'runAction', { action: 'checkin-all' })
  assert.equal(result.value.results.length, 2)
  assert.ok(result.value.results.every(item => item.ok && item.already), '两个都应回报已签过')
  assert.equal(calls.length, 2, '已签过的只查状态，不再打签到接口')
})

test('一键签到中个别账号失败不影响其余', () => {
  const seed = {
    accounts: JSON.stringify([ACCOUNT, { ...ACCOUNT, id: 'acc_2' }]),
    current: JSON.stringify({ 'codebuddy-cn': ACCOUNT.id }),
  }
  const { handlers } = createPlugin([
    // 第 1 个账号：状态查询 200 未签，然后签到成功
    STATUS_UNCHECKED,
    { status: 200, body: JSON.stringify({ code: 0, msg: '签到成功' }) },
    // 第 2 个账号：状态查询直接 401
    { status: 401, body: '<html>401 Authorization Required</html>' },
  ], seed)
  const result = callHandler(handlers, 'runAction', { action: 'checkin-all' })
  assert.equal(result.value.results.length, 2)
  assert.equal(result.value.results[0].ok, true, '第一个应成功')
  assert.equal(result.value.results[1].ok, false, '第二个应失败')
  assert.match(result.value.results[1].error, /登录态已失效/)
})

// ---- 5：余量接口的业务码
test('余量接口 200 但业务码非 0 时必须报错', () => {
  const { handlers } = createPlugin([
    { status: 200, body: JSON.stringify({ code: 40100, msg: '账号无权限访问计费信息' }) },
  ], SEED)
  const result = callHandler(handlers, 'runAction', { action: 'quota', source: 'codebuddy-cn', ids: [ACCOUNT.id] })
  const item = result.value.results[0]
  assert.equal(item.ok, false)
  assert.match(item.error, /账号无权限访问计费信息/)
})

test('余量正常时应能解析出套餐列表', () => {
  const { handlers } = createPlugin([{
    status: 200,
    body: JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [{
              CycleCapacityRemainPrecise: 500,
              CycleCapacitySizePrecise: 500,
              CycleEndTime: '2026-11-30 23:59:59',
            }],
          },
        },
      },
    }),
  }], SEED)
  const result = callHandler(handlers, 'runAction', { action: 'quota', source: 'codebuddy-cn', ids: [ACCOUNT.id] })
  const item = result.value.results[0]
  assert.equal(item.ok, true)
  assert.equal(item.quota.remain, 500)
  assert.equal(item.quota.packages, 1)
})

// ---- 6：网关层 HTML 不能整页甩给用户
test('网关返回 HTML 401 时提示要可读，不带整页 HTML', () => {
  const { handlers } = createPlugin([
    { status: 401, body: '<html><head><title>401 Authorization Required</title></head><body>openresty</body></html>' },
  ], SEED)
  const result = callHandler(handlers, 'runAction', { action: 'checkin', source: 'codebuddy-cn', ids: [ACCOUNT.id] })
  const item = result.value.results[0]
  assert.equal(item.ok, false)
  assert.match(item.error, /登录态已失效/)
  assert.doesNotMatch(item.error, /<html>|openresty/, '不该把整页 HTML 塞进提示')
})

// ---- 附加：签到成功的文案要带上服务端原话
test('签到成功应回显服务端消息', () => {
  const { handlers } = createPlugin([
    STATUS_UNCHECKED,
    { status: 200, body: JSON.stringify({ code: 0, msg: '签到成功，获得 100 积分' }) },
  ], SEED)
  const result = callHandler(handlers, 'runAction', { action: 'checkin', source: 'codebuddy-cn', ids: [ACCOUNT.id] })
  assert.match(result.value.results[0].message, /获得 100 积分/)
})

// ---- 账号显示名（7. 卡片名字必须是账号标识，绝不能是 token 内容）

test('导入纯 token 时不能把 token 当显示名', () => {
  const { handlers } = createPlugin([], {})
  const result = callHandler(handlers, 'import', {
    source: 'codebuddy-cn',
    text: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',
  })
  assert.equal(result.ok, true)
  const account = result.value.state.accounts[0]
  assert.equal(account.name.includes('eyJhbG'), false)
  assert.equal(account.name.includes('signature'), false)
})

test('token 是 JWT 时从 payload 里取邮箱作为名字', () => {
  const payload = Buffer
    .from(JSON.stringify({ email: 'tester@example.com' }))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`
  const { handlers } = createPlugin([], {})
  const result = callHandler(handlers, 'import', { source: 'codebuddy-cn', text: jwt })
  assert.equal(result.ok, true)
  assert.equal(result.value.state.accounts[0].name, 'tester@example.com')
})

test('旧版本用 token 前缀命名的账号，加载时会被纠正', () => {
  const legacy = { ...ACCOUNT, name: '账号 abcdef', token: 'opaque-token-value' }
  const { handlers } = createPlugin([], {
    accounts: JSON.stringify([legacy]),
    current: '{}',
  })
  const result = callHandler(handlers, 'state')
  assert.equal(result.ok, true)
  const account = result.value.accounts[0]
  assert.notEqual(account.name, '账号 abcdef')
  assert.equal(account.name.includes('abcdef'), false)
})

// ---- IDEA 登录态（会话结构与存储格式）

const IDEA_FILE = '%APPDATA%\\JetBrains\\IntelliJIdea2024.1\\options\\secret-storage.xml'
const IDEA_KEY = 'Tencent-Cloud.coding-copilot.new.accessToken'
const IDEA_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1aWQxMjMifQ.sig'

/** 拼一份 secret-storage.xml（value 按 XML 属性转义） */
function ideaXml(sessionJson) {
  const escaped = String(sessionJson)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split('\'').join('&apos;')
  return `<component name="SecretStorage"><Scores><Entry key="${IDEA_KEY}" value="${escaped}" /></Scores></component>`
}

/** 从写回后的 XML 里取出会话 JSON */
function readIdeaSession(xml) {
  const marker = `key="${IDEA_KEY}"`
  const at = xml.indexOf(marker)
  const valueAt = xml.indexOf('value="', at)
  const start = valueAt + 'value="'.length
  const end = xml.indexOf('"', start)
  return JSON.parse(xml.slice(start, end)
    .split('&quot;').join('"')
    .split('&apos;').join('\'')
    .split('&lt;').join('<')
    .split('&gt;').join('>')
    .split('&amp;').join('&'))
}

test('扫描 IDEA 登录态时剥离 uid 前缀', () => {
  const { handlers } = createPlugin([], {
    __dirs: { '%APPDATA%\\JetBrains': ['IntelliJIdea2024.1'] },
    __files: {
      [IDEA_FILE]: ideaXml(JSON.stringify({
        token: `uid123+${IDEA_JWT}`,
        accessToken: `uid123+${IDEA_JWT}`,
        auth: { accessToken: IDEA_JWT },
      })),
    },
  })
  const result = callHandler(handlers, 'scanLocalAuth')
  assert.equal(result.ok, true)
  assert.equal(result.value.accounts.length, 1)
  assert.equal(result.value.accounts[0].token, IDEA_JWT)
  assert.equal(result.value.accounts[0].key, IDEA_KEY)
})

test('写入 IDEA 登录态时保留原会话字段并补齐结构', () => {
  const existing = JSON.stringify({
    token: 'old+oldjwt',
    accessToken: 'old+oldjwt',
    auth: { accessToken: 'oldjwt', refreshToken: 'refresh-keep' },
    account: { uid: 'uid999', nickname: '旧账号', customField: 'keep-me' },
    someOther: 'keep-me-too',
  })
  const account = { ...ACCOUNT, token: IDEA_JWT }
  const { handlers, files } = createPlugin([], {
    accounts: JSON.stringify([account]),
    __dirs: { '%APPDATA%\\JetBrains': ['IntelliJIdea2024.1'] },
    __files: { [IDEA_FILE]: ideaXml(existing) },
  })

  const result = callHandler(handlers, 'applyAccount', {
    id: account.id,
    targets: [{ file: IDEA_FILE, key: IDEA_KEY }],
  })
  assert.equal(result.ok, true)

  const session = readIdeaSession(files[IDEA_FILE])
  // token / accessToken 必须带 uid 前缀，auth 里是纯 jwt
  assert.equal(session.accessToken, `uid999+${IDEA_JWT}`)
  assert.equal(session.token, `uid999+${IDEA_JWT}`)
  assert.equal(session.auth.accessToken, IDEA_JWT)
  // 原有字段一个都不能丢
  assert.equal(session.auth.refreshToken, 'refresh-keep')
  assert.equal(session.account.customField, 'keep-me')
  assert.equal(session.someOther, 'keep-me-too')
  assert.equal(session.account.uid, 'uid999')
})

test('IDEA 里当前登录的账号会被标记出来', () => {
  const account = { ...ACCOUNT, token: IDEA_JWT }
  const { handlers } = createPlugin([], {
    accounts: JSON.stringify([account]),
    __dirs: { '%APPDATA%\\JetBrains': ['IntelliJIdea2024.1'] },
    __files: {
      [IDEA_FILE]: ideaXml(JSON.stringify({ auth: { accessToken: IDEA_JWT } })),
    },
  })
  const result = callHandler(handlers, 'state')
  assert.equal(result.ok, true)
  assert.equal(result.value.accounts[0].ideaCurrent, true)
})

// ---- VSCode 系登录态（加密与 SQL 在宿主侧，插件只拿明文）

test('扫描会带上 VSCode 系的登录态位置', () => {
  const { handlers } = createPlugin([], {
    __agentAuth: {
      list: () => [{ id: 'codebuddy-vscode', label: 'CodeBuddy（VSCode）', kind: 'vscode' }],
      read: () => IDEA_JWT,
      write: () => 'CodeBuddy（VSCode）',
    },
  })
  const result = callHandler(handlers, 'scanLocalAuth')
  assert.equal(result.ok, true)
  assert.equal(result.value.accounts.length, 1)
  assert.equal(result.value.accounts[0].kind, 'vscode')
  assert.equal(result.value.accounts[0].id, 'codebuddy-vscode')
  assert.equal(result.value.accounts[0].token, IDEA_JWT)
})

test('扫描结果带上位置所属产品，供界面按产品过滤', () => {
  const { handlers } = createPlugin([], {
    __agentAuth: {
      list: () => [
        { id: 'codebuddy-vscode', label: 'VSCode', product: 'codebuddy', kind: 'vscode' },
        { id: 'qoder', label: 'Qoder', product: 'qoder', kind: 'vscode' },
      ],
      read: id => (id === 'qoder' ? 'qoder-token' : 'codebuddy-token'),
      write: () => '',
    },
  })

  const result = callHandler(handlers, 'scanLocalAuth')
  const cb = result.value.accounts.find(item => item.id === 'codebuddy-vscode')
  const qoder = result.value.accounts.find(item => item.id === 'qoder')
  assert.equal(cb.product, 'codebuddy')
  assert.equal(qoder.product, 'qoder')
  // 位置名用宿主应用名，不再带产品前缀
  assert.equal(cb.channel, 'VSCode')
})

test('应用到登录态位置时拒绝其他产品的位置', () => {
  const writes = []
  const { handlers } = createPlugin([], {
    accounts: JSON.stringify([ACCOUNT]),
    __agentAuth: {
      list: () => [],
      read: () => '',
      write: (id) => {
        writes.push(id)
        return id
      },
    },
  })

  const result = callHandler(handlers, 'applyAccount', {
    id: ACCOUNT.id,
    targets: [
      { kind: 'vscode', id: 'qoder', product: 'qoder', channel: 'Qoder' },
      { kind: 'vscode', id: 'codebuddy-cn-vscode', product: 'codebuddy-cn', channel: 'CodeBuddy CN' },
    ],
  })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(writes, ['codebuddy-cn-vscode'], '只写同产品的位置')
  assert.equal(result.value.results[0].ok, false)
  assert.match(result.value.results[0].error, /其他产品/)
})

test('写入 VSCode 位置时调宿主接口，不再走文件读写', () => {
  const writes = []
  const account = { ...ACCOUNT, token: IDEA_JWT }
  const { handlers } = createPlugin([], {
    accounts: JSON.stringify([account]),
    __agentAuth: {
      list: () => [],
      read: () => '',
      write: (id, token) => {
        writes.push({ id, token })
        return 'CodeBuddy（VSCode）'
      },
    },
  })

  const result = callHandler(handlers, 'applyAccount', {
    id: account.id,
    targets: [{ kind: 'vscode', id: 'codebuddy-vscode', channel: 'CodeBuddy（VSCode）' }],
  })
  assert.equal(result.ok, true)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].id, 'codebuddy-vscode')
  assert.equal(writes[0].token, IDEA_JWT)
  // 写入成功后要记进 targets，卡片上才能看出绑过哪些位置
  const saved = result.value.state.accounts[0].targets
  assert.equal(saved.length, 1)
  assert.equal(saved[0].kind, 'vscode')
  assert.equal(saved[0].id, 'codebuddy-vscode')
})

// ---- Windsurf 配额（没有独立端点，配额是刷新链路的附带结果）

const WINDSURF_ACCOUNT = {
  id: 'acc_windsurf',
  source: 'windsurf',
  name: 'wf@example.com',
  token: 'sk-ws-01-abcdef',
  addedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  quota: null,
  checkin: null,
}

const WINDSURF_FIREBASE = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig'

function windsurfSeed(account = WINDSURF_ACCOUNT) {
  return { accounts: JSON.stringify([account]), current: '{}' }
}

/** GetUserStatus 的真实形态：额度在 userStatus.planStatus 里 */
const WINDSURF_STATUS = {
  status: 200,
  body: JSON.stringify({
    userStatus: {
      name: 'wf',
      planStatus: {
        planName: 'Pro',
        availablePromptCredits: '1200',
        usedPromptCredits: 300,
        availableFlowCredits: 60,
        usedFlowCredits: 40,
        planEnd: { seconds: 1798761600 },
      },
    },
  }),
}

test('Windsurf 配额：apiKey 直接查用户状态，prompt 与 flow 额度相加', () => {
  const { handlers, calls, urls } = createPlugin([WINDSURF_STATUS], windsurfSeed())
  const result = callHandler(handlers, 'runAction', {
    action: 'quota',
    source: 'windsurf',
    ids: [WINDSURF_ACCOUNT.id],
  })
  const item = result.value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  // 剩余 = 1200 + 60，总量 = 1500 + 100
  assert.equal(item.quota.remain, 1260)
  assert.equal(item.quota.total, 1600)
  assert.equal(item.quota.packages, 1)
  assert.match(item.quota.cycleEnd, /^2\d{3}-\d{2}-\d{2}T/)
  assert.ok(item.quota.updatedAt)
  assert.equal(calls.length, 1, '只有 apiKey 时不该再换 Firebase 凭据')
  assert.match(calls[0], /\/GetUserStatus$/)
  // 没有客户端登录态时打到官方默认服务端
  assert.match(urls[0], /^https:\/\/server\.codeium\.com\//)
})

test('Windsurf 配额：Firebase token 先换 apiKey，再用套餐详情补齐', () => {
  const account = { ...WINDSURF_ACCOUNT, token: WINDSURF_FIREBASE }
  const { handlers, calls, urls } = createPlugin([
    // RegisterUser：换 apiKey，同时给出真实服务端地址
    {
      status: 200,
      body: JSON.stringify({ apiKey: 'sk-ws-01-new', apiServerUrl: 'https://server.self-serve.windsurf.com' }),
    },
    // GetOneTimeAuthToken
    { status: 200, body: JSON.stringify({ authToken: 'one-time' }) },
    // GetUserStatus：快照里没有额度
    { status: 200, body: JSON.stringify({ userStatus: { planStatus: { planName: 'Pro' } } }) },
    // GetPlanStatus：额度在这里
    {
      status: 200,
      body: JSON.stringify({
        planStatus: { availablePromptCredits: 10, usedPromptCredits: 0, availableFlowCredits: 5, usedFlowCredits: 5 },
      }),
    },
  ], windsurfSeed(account))

  const result = callHandler(handlers, 'runAction', {
    action: 'quota',
    source: 'windsurf',
    ids: [account.id],
  })
  const item = result.value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 15)
  assert.equal(item.quota.total, 20)
  assert.equal(calls.length, 4, '注册 → 换 authToken → 用户状态 → 套餐详情')
  assert.match(calls[0], /RegisterUser$/)
  assert.match(calls[1], /GetOneTimeAuthToken$/)
  // 服务端地址以 RegisterUser 返回的为准
  assert.match(urls[2], /^https:\/\/server\.self-serve\.windsurf\.com\//)
  assert.match(calls[3], /GetPlanStatus$/)
})

test('Windsurf 配额：套餐详情失败时仍能用用户状态里的快照', () => {
  const account = { ...WINDSURF_ACCOUNT, token: WINDSURF_FIREBASE }
  const { handlers } = createPlugin([
    { status: 200, body: JSON.stringify({ apiKey: 'sk-ws-01-new' }) },
    { status: 200, body: JSON.stringify({ authToken: 'one-time' }) },
    WINDSURF_STATUS,
    { status: 500, body: '<html>500 Internal Server Error</html>' },
  ], windsurfSeed(account))

  const result = callHandler(handlers, 'runAction', {
    action: 'quota',
    source: 'windsurf',
    ids: [account.id],
  })
  const item = result.value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 1260)
})

test('Windsurf 配额：扁平快照的 completions / chat 也认', () => {
  const { handlers } = createPlugin([{
    status: 200,
    body: JSON.stringify({ userStatus: { planStatus: { completions: 100, chat: 20 } } }),
  }], windsurfSeed())
  const result = callHandler(handlers, 'runAction', {
    action: 'quota',
    source: 'windsurf',
    ids: [WINDSURF_ACCOUNT.id],
  })
  const item = result.value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 120)
  assert.equal(item.quota.total, 120)
})

test('Windsurf 配额：快照里没有额度字段时明确报错，并保留旧配额', () => {
  const account = {
    ...WINDSURF_ACCOUNT,
    quota: { remain: 500, total: 500, cycleEnd: '', packages: 1, updatedAt: '2026-11-01T00:00:00.000Z' },
  }
  const { handlers } = createPlugin([{
    status: 200,
    body: JSON.stringify({ userStatus: { planStatus: { planName: 'Free' } } }),
  }], windsurfSeed(account))

  const result = callHandler(handlers, 'runAction', {
    action: 'quota',
    source: 'windsurf',
    ids: [account.id],
  })
  const item = result.value.results[0]
  assert.equal(item.ok, false)
  assert.match(item.error, /配额快照/)
  // 失败不清空已有配额
  assert.equal(result.value.state.accounts[0].quota.remain, 500)
})

test('Windsurf 配额：认不出的凭据要提示重新登录，不瞎发请求', () => {
  const account = { ...WINDSURF_ACCOUNT, token: 'devin-session-token$abc' }
  const { handlers, calls } = createPlugin([], windsurfSeed(account))
  const result = callHandler(handlers, 'runAction', {
    action: 'quota',
    source: 'windsurf',
    ids: [account.id],
  })
  const item = result.value.results[0]
  assert.equal(item.ok, false)
  assert.match(item.error, /无法识别的 Windsurf 凭据/)
  assert.equal(calls.length, 0)
})

// ---- 浏览器登录骨架（PKCE / 轮询 / 回调）

/** 确定性随机源：全 0，便于比对 PKCE challenge */
const ZERO_RANDOM = { randomBytes: n => new Array(n).fill(0) }

function accountOf(source, token, meta = {}) {
  return {
    id: 'acc_' + source,
    source: source,
    name: source,
    token: token,
    meta: meta,
    addedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    quota: null,
    checkin: null,
  }
}

test('Cursor 网页登录：授权链接里的 challenge 是 verifier 的 S256', () => {
  const { handlers } = createPlugin([], { __crypto: ZERO_RANDOM })
  const start = callHandler(handlers, 'oauthStart', { source: 'cursor' })
  assert.equal(start.ok, true, start.error)
  const challenge = /challenge=([^&]+)/.exec(start.value.authUrl)[1]
  // verifier = base64url(32 个 0 字节)，和插件里的算法对齐
  const verifier = Buffer.alloc(32).toString('base64url')
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url')
  assert.equal(decodeURIComponent(challenge), expected)
})

test('Cursor 网页登录：404 表示等待，拿到 token 后结束', () => {
  const { handlers } = createPlugin([
    { status: 404, body: '{}' },
    {
      status: 200,
      body: JSON.stringify({ accessToken: 'cursor-token', refreshToken: 'cursor-refresh', authId: 'me@example.com' }),
    },
  ], {})

  assert.equal(callHandler(handlers, 'oauthStart', { source: 'cursor' }).ok, true)
  const first = callHandler(handlers, 'oauthPoll')
  assert.equal(first.value.done, false)
  const second = callHandler(handlers, 'oauthPoll')
  assert.equal(second.value.done, true, second.error)
  assert.equal(second.value.token, 'cursor-token')
  assert.equal(second.value.email, 'me@example.com')
})

test('Qoder 网页登录：轮询到 token 后取账号信息，余量回落到远程接口', () => {
  const { handlers } = createPlugin([
    { status: 404, body: '{}' },
    { status: 200, body: JSON.stringify({ token: 'qoder-token', refresh_token: 'qoder-refresh', user_id: 'u1' }) },
    { status: 200, body: JSON.stringify({ email: 'q@example.com', name: 'Qoder 用户' }) },
    { status: 200, body: JSON.stringify({ used: 2, total: 20 }) },
  ], {})

  callHandler(handlers, 'oauthStart', { source: 'qoder' })
  assert.equal(callHandler(handlers, 'oauthPoll').value.done, false)
  const done = callHandler(handlers, 'oauthPoll')
  assert.equal(done.value.done, true, done.error)
  assert.equal(done.value.token, 'qoder-token')
  assert.equal(done.value.email, 'q@example.com')
  // 本地没有用量快照时用 token 查远程
  assert.equal(done.value.quota.remain, 18)
})

test('GitHub Copilot 网页登录：回调 code 换 token 并取账号与余量', () => {
  const { handlers } = createPlugin([
    { status: 200, body: JSON.stringify({ access_token: 'gh-token', token_type: 'bearer' }) },
    { status: 200, body: JSON.stringify({ login: 'octocat', name: 'Octo', email: 'octo@example.com' }) },
    {
      status: 200,
      body: JSON.stringify({
        quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 120 } },
        quota_reset_date: '2026-12-01',
      }),
    },
  ], {})

  const start = callHandler(handlers, 'oauthStart', { source: 'github-copilot' })
  assert.equal(start.ok, true, start.error)
  const state = decodeURIComponent(/state=([^&]+)/.exec(start.value.authUrl)[1])
  const nonce = decodeURIComponent(/nonce=([^&]+)/.exec(state)[1])

  const callback = handlers.__server({
    path: '/callback',
    query: `code=abc&nonce=${encodeURIComponent(nonce)}&state=${encodeURIComponent(state)}`,
  })
  assert.equal(callback.status, 200)

  const done = callHandler(handlers, 'oauthPoll')
  assert.equal(done.value.done, true, done.error)
  assert.equal(done.value.token, 'gh-token')
  assert.equal(done.value.name, 'Octo')
  assert.equal(done.value.quota.remain, 120)
})

test('Kiro 网页登录：回调 code 换 token 后立刻能查用量', () => {
  const { handlers } = createPlugin([
    { status: 200, body: JSON.stringify({ accessToken: 'kiro-at', refreshToken: 'kiro-rt' }) },
    {
      status: 200,
      body: JSON.stringify({
        usageBreakdownList: [{ type: 'credit', usageLimitWithPrecision: 50, currentUsageWithPrecision: 10 }],
      }),
    },
  ], {})

  const start = callHandler(handlers, 'oauthStart', { source: 'kiro' })
  assert.equal(start.ok, true, start.error)
  const state = decodeURIComponent(/state=([^&]+)/.exec(start.value.authUrl)[1])
  handlers.__server({ path: '/oauth/callback', query: `code=kiro-code&state=${encodeURIComponent(state)}` })

  const done = callHandler(handlers, 'oauthPoll')
  assert.equal(done.value.done, true, done.error)
  assert.equal(done.value.token, 'kiro-at')
  assert.equal(done.value.quota.remain, 40)
})

test('Antigravity 网页登录：Google 换 token 后查项目与配额', () => {
  const { handlers } = createPlugin([
    { status: 200, body: JSON.stringify({ access_token: 'ag-at', refresh_token: 'ag-rt' }) },
    { status: 200, body: JSON.stringify({ email: 'ag@example.com', name: 'AG' }) },
    { status: 200, body: JSON.stringify({ cloudaicompanionProject: 'proj-ag' }) },
    {
      status: 200,
      body: JSON.stringify({ groups: [{ buckets: [{ bucketId: 'gemini:5h', remainingFraction: 0.4 }] }] }),
    },
  ], {})

  const start = callHandler(handlers, 'oauthStart', { source: 'antigravity' })
  assert.equal(start.ok, true, start.error)
  const state = decodeURIComponent(/state=([^&]+)/.exec(start.value.authUrl)[1])
  handlers.__server({ path: '/oauth-callback', query: `code=ag-code&state=${encodeURIComponent(state)}` })

  const done = callHandler(handlers, 'oauthPoll')
  assert.equal(done.value.done, true, done.error)
  assert.equal(done.value.token, 'ag-at')
  assert.equal(done.value.email, 'ag@example.com')
  assert.equal(done.value.meta.refreshToken, 'ag-rt')
  assert.equal(done.value.quota.remain, 40)
  assert.equal(done.value.quota.unit, 'percent')
})

test('Kiro 用量：Bearer 直查，region 从 profileArn 解，赠送额度也算进去', () => {
  const account = accountOf('kiro', 'kiro-token', {
    profileArn: 'arn:aws:codewhisperer:eu-central-1:123:profile/ABC',
  })
  const { handlers, urls } = createPlugin([{
    status: 200,
    body: JSON.stringify({
      nextDateReset: 1772323200,
      subscriptionInfo: { subscriptionTitle: 'KIRO PRO' },
      usageBreakdownList: [{
        type: 'credit',
        usageLimitWithPrecision: 1000,
        currentUsageWithPrecision: 250,
        freeTrialInfo: { usageLimitWithPrecision: 500, currentUsageWithPrecision: 100 },
      }],
    }),
  }], { accounts: JSON.stringify([account]) })

  const result = callHandler(handlers, 'runAction', { action: 'quota', source: 'kiro', ids: [account.id] })
  const item = result.value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.total, 1500)
  assert.equal(item.quota.remain, 1150)
  assert.match(urls[0], /^https:\/\/q\.eu-central-1\.amazonaws\.com\/getUsageLimits/)
  assert.match(urls[0], /profileArn=arn%3A/)
})

test('Antigravity 用量：取最紧张的桶，按百分数返回', () => {
  const account = accountOf('antigravity', 'ag-token', { projectId: 'proj-1' })
  const { handlers } = createPlugin([{
    status: 200,
    body: JSON.stringify({
      groups: [{
        buckets: [
          { bucketId: 'gemini:5h', remainingFraction: 0.62, resetTime: '2026-11-09T12:00:00Z' },
          { bucketId: 'claude:5h', remainingFraction: 0.18, resetTime: '2026-11-09T10:00:00Z' },
        ],
      }],
    }),
  }], { accounts: JSON.stringify([account]) })

  const result = callHandler(handlers, 'runAction', { action: 'quota', source: 'antigravity', ids: [account.id] })
  const item = result.value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 18)
  assert.equal(item.quota.unit, 'percent')
  assert.equal(item.quota.packages, 2)
  assert.equal(item.quota.cycleEnd, '2026-11-09T10:00:00Z')
})

test('Trae 用量：按权益包累加，请求打到账号自己的 loginHost', () => {
  const account = accountOf('trae', 'trae-token', { loginHost: 'https://grow-normal.trae.ai' })
  const { handlers, urls } = createPlugin([{
    status: 200,
    body: JSON.stringify({
      Result: {
        user_entitlement_pack_list: [{
          basic_usage_limit: 100,
          basic_usage_amount: 40,
          bonus_usage_limit: 20,
          bonus_usage_amount: 5,
        }],
      },
    }),
  }], { accounts: JSON.stringify([account]) })

  const result = callHandler(handlers, 'runAction', { action: 'quota', source: 'trae', ids: [account.id] })
  const item = result.value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.total, 120)
  assert.equal(item.quota.remain, 75)
  // 余量固定在业务域名上，与账号记住的 loginHost 无关（loginHost 只用于登录/续期）
  assert.match(urls[0], /^https:\/\/api\.trae\.ai\/trae\/api\/v2\/pay\/ide_user_ent_usage$/)
})

test('扫描本地登录态：Codex 从 auth.json 读 access token', () => {
  const codexFile = '%USERPROFILE%\\.codex\\auth.json'
  const { handlers } = createPlugin([], {
    __files: {
      [codexFile]: JSON.stringify({ tokens: { access_token: 'codex-token', id_token: '' } }),
    },
  })
  const result = callHandler(handlers, 'scanLocalAuth')
  assert.equal(result.ok, true)
  const codex = result.value.accounts.find(item => item.kind === 'codex')
  assert.ok(codex, '应该扫到 Codex')
  assert.equal(codex.token, 'codex-token')
})

test('扫描本地登录态：Zed 走宿主接口，标记成只读形态', () => {
  const { handlers } = createPlugin([], {
    __agentAuth: {
      list: () => [{ id: 'zed', label: 'Zed', product: 'zed', kind: 'zed' }],
      read: () => 'zed-token',
      write: () => {
        throw new Error('Zed 不该被写入')
      },
    },
  })
  const result = callHandler(handlers, 'scanLocalAuth')
  const zed = result.value.accounts.find(item => item.kind === 'zed')
  assert.ok(zed, '应该扫到 Zed')
  assert.equal(zed.token, 'zed-token')
})

test('网页登录拿到的 refreshToken 会随导入落到账号上', () => {
  const { handlers, store } = createPlugin([{
    status: 200,
    body: JSON.stringify({ accessToken: 'cursor-token', refreshToken: 'cursor-refresh', authId: 'me@example.com' }),
  }], {})

  callHandler(handlers, 'oauthStart', { source: 'cursor' })
  assert.equal(callHandler(handlers, 'oauthPoll').value.done, true)
  const imported = callHandler(handlers, 'import', { source: 'cursor', text: 'cursor-token' })
  assert.equal(imported.ok, true, imported.error)
  const saved = JSON.parse(store.accounts)[0]
  assert.equal(saved.meta.refreshToken, 'cursor-refresh')
})

// ---- CodeBuddy 系（对齐参考实现的修复）

/** 一份空的 get-user-resource 响应 */
const QUOTA_EMPTY = { status: 200, body: JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }) }

test('余量：失效的资源包不计入剩余（Status=3 / 扣费已截止）', () => {
  const { handlers } = createPlugin([{
    status: 200,
    body: JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              { CycleCapacityRemainPrecise: 120, CycleCapacitySizePrecise: 200, CycleEndTime: '2026-12-01 00:00:00', Status: 0 },
              // 已过期：服务端仍返回、剩余也可能非 0，但不能算进余量
              { CycleCapacityRemainPrecise: 500, CycleCapacitySizePrecise: 500, Status: 3 },
              // 扣费截止已过：同样是死额度
              { CycleCapacityRemainPrecise: 80, CycleCapacitySizePrecise: 100, DeductionEndTime: Date.now() - 1000 },
            ],
          },
        },
      },
    }),
  }], SEED)

  const result = callHandler(handlers, 'runAction', { action: 'quota', source: 'codebuddy-cn', ids: [ACCOUNT.id] })
  const item = result.value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 120, '失效包的 580 不能算进来')
  assert.equal(item.quota.total, 200)
  assert.equal(item.quota.packages, 3, 'packages 是服务端返回的包数')
})

test('余量：CodeBuddy 系请求带 X-Domain / X-Product / X-Product-Code / UA', () => {
  const { handlers, requests } = createPlugin([QUOTA_EMPTY], SEED)
  callHandler(handlers, 'runAction', { action: 'quota', source: 'codebuddy-cn', ids: [ACCOUNT.id] })

  const headers = requests[0].headers
  assert.equal(headers['X-Domain'], 'www.codebuddy.cn')
  assert.equal(headers['X-Product'], 'SaaS')
  assert.equal(headers['X-Product-Code'], 'codebuddy')
  assert.match(headers['User-Agent'], /^CodeBuddyIDE\//)
  assert.equal(headers['x-client-platform'], undefined, 'IDE 形态不再带 web 标识')
})

test('余量：企业账号带 X-Enterprise-Id / X-Tenant-Id / X-User-Id', () => {
  const account = { ...ACCOUNT, meta: { userId: 'uid-1', enterpriseId: 'ent-9' } }
  const { handlers, requests } = createPlugin([QUOTA_EMPTY], {
    accounts: JSON.stringify([account]),
    current: '{}',
  })
  callHandler(handlers, 'runAction', { action: 'quota', source: 'codebuddy-cn', ids: [account.id] })

  const headers = requests[0].headers
  assert.equal(headers['X-User-Id'], 'uid-1')
  assert.equal(headers['X-Enterprise-Id'], 'ent-9')
  assert.equal(headers['X-Tenant-Id'], 'ent-9')
})

test('签到：1002 / 1003 要按原因提示，不能笼统报「签到失败」', () => {
  const noQualification = createPlugin([
    STATUS_UNCHECKED,
    { status: 200, body: JSON.stringify({ code: 1002, msg: '' }) },
  ], SEED)
  const r1 = callHandler(noQualification.handlers, 'runAction', { action: 'checkin', source: 'codebuddy-cn', ids: [ACCOUNT.id] })
  assert.equal(r1.value.results[0].ok, false)
  assert.match(r1.value.results[0].error, /没有签到资格/)

  const ended = createPlugin([
    STATUS_UNCHECKED,
    { status: 200, body: JSON.stringify({ code: 1003, msg: '' }) },
  ], SEED)
  const r2 = callHandler(ended.handlers, 'runAction', { action: 'checkin', source: 'codebuddy-cn', ids: [ACCOUNT.id] })
  assert.equal(r2.value.results[0].ok, false)
  assert.match(r2.value.results[0].error, /活动已结束/)
})

test('签到：1001 也是「今天已签过」', () => {
  const { handlers } = createPlugin([
    { status: 200, body: JSON.stringify({ code: 0, data: { active: true, today_checked_in: false } }) },
    { status: 400, body: JSON.stringify({ code: 1001, msg: '' }) },
  ], SEED)
  const result = callHandler(handlers, 'runAction', { action: 'checkin', source: 'codebuddy-cn', ids: [ACCOUNT.id] })
  const item = result.value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.already, true)
})

test('签到：活动未开启时不打签到接口', () => {
  const { handlers, calls } = createPlugin([{
    status: 200,
    body: JSON.stringify({ code: 0, data: { active: false, today_checked_in: false } }),
  }], SEED)
  const result = callHandler(handlers, 'runAction', { action: 'checkin', source: 'codebuddy-cn', ids: [ACCOUNT.id] })
  const item = result.value.results[0]
  assert.equal(item.ok, false)
  assert.match(item.error, /未开启/)
  assert.equal(calls.length, 1, '只查状态，不再发签到请求')
})

test('登录：CodeBuddy 轮询拿到 token 后补查账号信息并保留续期凭据', () => {
  const payload = Buffer.from(JSON.stringify({ iat: 1_760_000_000, sub: 'uid-jwt' })).toString('base64url')
  const token = `header.${payload}.sig`
  const { handlers, requests, store } = createPlugin([
    { status: 200, body: JSON.stringify({ code: 0, data: { state: 'st-1', authUrl: 'https://www.codebuddy.cn/login/?state=st-1' } }) },
    { status: 200, body: JSON.stringify({ code: 0, data: { accessToken: token, refreshToken: 'rt-1', expiresIn: 3600 } }) },
    { status: 200, body: JSON.stringify({ code: 0, data: { uid: 'uid-1', nickname: '小明', enterpriseId: 'ent-9', type: 'enterprise' } }) },
    QUOTA_EMPTY,
  ], {})

  const start = callHandler(handlers, 'oauthStart', { source: 'codebuddy-cn' })
  assert.equal(start.ok, true, start.error)
  assert.match(requests[0].url, /\/v2\/plugin\/auth\/state\?platform=ide$/)
  assert.equal(requests[0].headers['X-Domain'], 'www.codebuddy.cn')

  const poll = callHandler(handlers, 'oauthPoll')
  assert.equal(poll.ok, true, poll.error)
  assert.equal(poll.value.done, true)
  assert.equal(poll.value.name, '小明', '昵称来自 login/account')
  assert.match(requests[1].url, /\/v2\/plugin\/auth\/token\?state=st-1$/)
  assert.match(requests[2].url, /\/v2\/plugin\/login\/account\?state=st-1$/)
  assert.equal(requests[2].headers['X-No-User-Id'], 'true', '取账号信息的请求要声明「不带用户上下文」')

  callHandler(handlers, 'import', { source: 'codebuddy-cn', text: poll.value.token })
  const saved = JSON.parse(store.accounts)[0]
  assert.equal(saved.meta.refreshToken, 'rt-1')
  assert.equal(saved.meta.userId, 'uid-1')
  assert.equal(saved.meta.enterpriseId, 'ent-9')
  assert.equal(saved.meta.accountType, 'enterprise')
  assert.equal(saved.meta.expiresAt, 1_760_000_000_000 + 3_600_000, 'expiresIn 以 JWT iat 为基准换算')
})

test('登录：11217 表示 token 未就绪，继续等待', () => {
  const { handlers } = createPlugin([
    { status: 200, body: JSON.stringify({ code: 0, data: { state: 'st-1', authUrl: 'https://www.codebuddy.cn/login/' } }) },
    { status: 200, body: JSON.stringify({ code: 11217, msg: 'token not ready' }) },
  ], {})

  callHandler(handlers, 'oauthStart', { source: 'codebuddy-cn' })
  const poll = callHandler(handlers, 'oauthPoll')
  assert.equal(poll.ok, true, poll.error)
  assert.equal(poll.value.done, false)
})

test('续期：余量 401 时用 refresh_token 续期并自动重试', () => {
  const account = { ...ACCOUNT, meta: { refreshToken: 'rt-1', userId: 'uid-1' } }
  const { handlers, requests, store } = createPlugin([
    { status: 401, body: '<html>401 Authorization Required</html>' },
    { status: 200, body: JSON.stringify({ code: 0, data: { accessToken: 'fresh-token', refreshToken: 'rt-2', expiresIn: 3600 } }) },
    { status: 200, body: JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [{ CycleCapacityRemainPrecise: 10, CycleCapacitySizePrecise: 20 }] } } } }) },
  ], { accounts: JSON.stringify([account]), current: '{}' })

  const result = callHandler(handlers, 'runAction', { action: 'quota', source: 'codebuddy-cn', ids: [account.id] })
  const item = result.value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 10)

  assert.match(requests[1].url, /\/v2\/plugin\/auth\/token\/refresh$/)
  assert.equal(requests[1].headers['X-Refresh-Token'], 'rt-1')
  assert.equal(requests[1].headers['X-Auth-Refresh-Source'], 'ide-main')
  assert.equal(requests[2].headers['Authorization'], 'Bearer fresh-token', '重试要用新 token')

  const saved = JSON.parse(store.accounts)[0]
  assert.equal(saved.token, 'token-value', 'account.token 代表账号身份，不能被续期改掉')
  assert.equal(saved.meta.accessToken, 'fresh-token', '新 token 存在 meta 里')
  assert.equal(saved.meta.refreshToken, 'rt-2', '轮换后的 refresh_token 也要落库')
})

test('续期：没有 refresh_token 时 401 仍报登录态失效，且不白打续期请求', () => {
  const { handlers, calls } = createPlugin([{ status: 401, body: '<html>401</html>' }], SEED)
  const result = callHandler(handlers, 'runAction', { action: 'quota', source: 'codebuddy-cn', ids: [ACCOUNT.id] })
  assert.equal(result.value.results[0].ok, false)
  assert.match(result.value.results[0].error, /登录态已失效/)
  assert.equal(calls.length, 1)
})

// ---- 新接入渠道（gemini / minimax / cline / accio）

test('Gemini 用量：取最紧张的窗口，按百分比返回', () => {
  const account = accountOf('gemini', 'g-token', { projectId: 'proj-1' })
  const { handlers, requests } = createPlugin([{
    status: 200,
    body: JSON.stringify({
      groups: [{
        buckets: [
          { bucketId: 'gemini-5h', remainingFraction: 0.82, resetTime: '2026-11-09T12:00:00Z' },
          { bucketId: 'gemini-weekly', remainingFraction: 0.41, resetTime: '2026-11-15T00:00:00Z' },
        ],
      }],
    }),
  }], { accounts: JSON.stringify([account]) })

  const result = callHandler(handlers, 'runAction', { action: 'quota', source: 'gemini', ids: [account.id] })
  const item = result.value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 41)
  assert.equal(item.quota.total, 100)
  assert.equal(item.quota.unit, 'percent')
  assert.equal(item.quota.packages, 2)
  assert.equal(item.quota.cycleEnd, '2026-11-09T12:00:00Z', '取最早的重置时刻')
  assert.match(requests[0].url, /v1internal:retrieveUserQuotaSummary$/)
  assert.deepEqual(JSON.parse(requests[0].body), { project: 'proj-1' }, '配额必须带 project')
})

test('MiniMax 用量：details 剩余求和，base_resp 非 0 要报错', () => {
  const account = accountOf('minimax', 'mm-token')
  const ok = createPlugin([{
    status: 200,
    body: JSON.stringify({
      details: [
        { remaining_amount: '800.00', granted_amount: '800.00', expire_at_ms: 1793203200000 },
        { remaining_amount: '120.50', granted_amount: '200.00' },
      ],
      total_count: 2,
      base_resp: { status_code: 0 },
    }),
  }], { accounts: JSON.stringify([account]) })
  const item = callHandler(ok.handlers, 'runAction', { action: 'quota', source: 'minimax', ids: [account.id] }).value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 920.5)
  assert.equal(item.quota.total, 1000)
  assert.equal(item.quota.packages, 2)
  assert.equal(item.quota.cycleEnd, new Date(1793203200000).toISOString())

  const bad = createPlugin([{
    status: 200,
    body: JSON.stringify({ details: [], base_resp: { status_code: 1004, status_msg: '登录已失效' } }),
  }], { accounts: JSON.stringify([account]) })
  const failed = callHandler(bad.handlers, 'runAction', { action: 'quota', source: 'minimax', ids: [account.id] }).value.results[0]
  assert.equal(failed.ok, false)
  assert.match(failed.error, /登录已失效/)
})

test('MiniMax 网页登录：设备码 pending 后拿到 token', () => {
  const { handlers, requests } = createPlugin([
    {
      status: 200,
      body: JSON.stringify({
        device_code: 'dc-1',
        user_code: 'ABCD',
        verification_uri: 'https://agent.minimax.cn/device',
        verification_uri_complete: 'https://agent.minimax.cn/device?user_code=ABCD',
        expires_in: 300,
        interval: 1,
      }),
    },
    { status: 200, body: JSON.stringify({ status: 'pending' }) },
    { status: 200, body: JSON.stringify({ access_token: 'mmoat_x', refresh_token: 'rt-1', expires_in: 3600, scope: 'agent.default' }) },
  ], {})

  const start = callHandler(handlers, 'oauthStart', { source: 'minimax' })
  assert.equal(start.ok, true, start.error)
  assert.equal(start.value.userCode, 'ABCD')
  assert.match(start.value.authUrl, /user_code=ABCD/)

  assert.equal(callHandler(handlers, 'oauthPoll').value.done, false, '200 + status=pending 要当「继续等」')
  const done = callHandler(handlers, 'oauthPoll').value
  assert.equal(done.done, true)
  assert.equal(done.token, 'mmoat_x')
  assert.match(requests[0].body, /client_id=mcode-public/)
})

test('Cline 用量：按已用百分比换算剩余，取最紧张窗口', () => {
  const account = accountOf('cline', 'workos:jwt')
  const { handlers, requests } = createPlugin([{
    status: 200,
    body: JSON.stringify({
      success: true,
      data: {
        limits: [
          { type: 'five_hour', percentUsed: 10, resetsAt: '2026-11-09T15:41:02.244817775Z' },
          { type: 'weekly', percentUsed: 45, resetsAt: '' },
        ],
      },
    }),
  }], { accounts: JSON.stringify([account]) })

  const item = callHandler(handlers, 'runAction', { action: 'quota', source: 'cline', ids: [account.id] }).value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 55)
  assert.equal(item.quota.total, 100)
  assert.equal(item.quota.unit, 'percent')
  assert.equal(item.quota.packages, 2)
  assert.match(requests[0].url, /users\/me\/plan\/usage-limits$/)
  assert.equal(requests[0].headers['Authorization'], 'Bearer workos:jwt', 'workos: 前缀不能剥')
})

test('Accio 用量：顶层 remaining 优先，桶总量求和', () => {
  const account = accountOf('accio', 'accio-token')
  const { handlers, requests } = createPlugin([{
    status: 200,
    body: JSON.stringify({
      success: true,
      data: {
        remaining: 320,
        entitlement: {
          daily: { total: 300, used: 100, remaining: 200 },
          monthly: { total: 500, used: 380, remaining: 120 },
        },
      },
    }),
  }], { accounts: JSON.stringify([account]) })

  const item = callHandler(handlers, 'runAction', { action: 'quota', source: 'accio', ids: [account.id] }).value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 320)
  assert.equal(item.quota.total, 800)
  assert.equal(item.quota.packages, 2)
  assert.match(requests[0].url, /currentSubscription\?accessToken=accio-token$/, 'token 必须放 query')
})

test('LobsterAI 用量：同组面值推断总额，过期包不计入', () => {
  const account = accountOf('lobsterai', 'lb-token')
  const { handlers } = createPlugin([{
    status: 200,
    body: JSON.stringify({
      code: 0,
      data: {
        totalCreditsRemaining: 292.73,
        creditItems: [
          { label: '每日登录奖励', creditsRemaining: 92.73, expiresAt: '2099-01-01T00:00:00' },
          { label: '每日登录奖励', creditsRemaining: 100, expiresAt: '2099-01-02T00:00:00' },
          { label: '每日登录奖励', creditsRemaining: 100, expiresAt: '2020-01-01T00:00:00' },
        ],
      },
    }),
  }], { accounts: JSON.stringify([account]) })

  const item = callHandler(handlers, 'runAction', { action: 'quota', source: 'lobsterai', ids: [account.id] }).value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 192.73, '过期的那 100 不能算')
  assert.equal(item.quota.total, 200, '面值取同组最大值 100')
  assert.equal(item.quota.packages, 2)
  // expiresAt 是「不带时区」的服务端本地时间，按本地时区解析后再转 ISO
  assert.equal(item.quota.cycleEnd, new Date(Date.parse('2099-01-01T00:00:00')).toISOString())
})

test('LobsterAI 网页登录：回调 authCode 换 token，uuid/keyfrom 落库', () => {
  const { handlers, requests, store } = createPlugin([
    { status: 200, body: JSON.stringify({ code: 0, data: { value: { version: '2026.11.1' } } }) },
    { status: 200, body: JSON.stringify({ code: 0, data: { accessToken: 'lb-access', refreshToken: 'lb-refresh', expiresIn: 3600 } }) },
  ], {})

  const start = callHandler(handlers, 'oauthStart', { source: 'lobsterai' })
  assert.equal(start.ok, true, start.error)
  assert.match(start.value.authUrl, /^https:\/\/lobsterai\.youdao\.com\/portal#\/login\?/)
  assert.match(start.value.authUrl, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A18765%2Fauth%2Fcallback/)
  const state = /[?&]state=([^&]+)/.exec(start.value.authUrl)[1]

  // 模拟浏览器回调
  handlers.__server({ path: '/auth/callback', query: 'code=ac-1&state=' + state })
  const done = callHandler(handlers, 'oauthPoll').value
  assert.equal(done.done, true)
  assert.equal(done.token, 'lb-access')

  const exchange = JSON.parse(requests[1].body)
  assert.equal(exchange.authCode, 'ac-1')
  assert.equal(exchange.version, '2026.11.1', '版本号用动态拉到的真值')
  assert.equal(exchange.uuid.length, 36)
  assert.ok(exchange.firstKeyfrom)

  callHandler(handlers, 'import', { source: 'lobsterai', text: done.token })
  const saved = JSON.parse(store.accounts)[0]
  assert.equal(saved.meta.refreshToken, 'lb-refresh')
  assert.equal(saved.meta.version, '2026.11.1')
  assert.ok(saved.meta.uuid, '续期要用的安装 uuid 必须落库')
})

test('Raccoon 用量：available_points 是余额，分池只用于明细计数', () => {
  const account = accountOf('raccoon', 'rc-token')
  const { handlers } = createPlugin([{
    status: 200,
    body: JSON.stringify({
      code: 0,
      data: { available_points: 5200, reward_points: 3000, daily_points: 200, monthly_points: 0, topup_points: 2000 },
    }),
  }], { accounts: JSON.stringify([account]) })

  const item = callHandler(handlers, 'runAction', { action: 'quota', source: 'raccoon', ids: [account.id] }).value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 5200)
  assert.equal(item.quota.packages, 3, 'monthly_points 为 0 不计入')
})

test('Raccoon 扫码登录：本地生成 code，轮询到 success 取 token', () => {
  const { handlers, requests } = createPlugin([
    { status: 200, body: JSON.stringify({ code: 0, data: { status: 'pending' } }) },
    { status: 200, body: JSON.stringify({ code: 0, data: { status: 'success', access_token: 'rc-access', refresh_token: 'rc-refresh' } }) },
  ], {})

  const start = callHandler(handlers, 'oauthStart', { source: 'raccoon' })
  assert.equal(start.ok, true, start.error)
  const code = /[?&]code=([0-9a-f]{32})/.exec(start.value.authUrl)[1]
  assert.match(start.value.authUrl, /^https:\/\/xiaohuanxiong\.com\/login\/mp\?/)

  assert.equal(callHandler(handlers, 'oauthPoll').value.done, false)
  const done = callHandler(handlers, 'oauthPoll').value
  assert.equal(done.done, true)
  assert.equal(done.token, 'rc-access')
  assert.equal(JSON.parse(requests[1].body).qrcode_code, code, '轮询要带同一个本地 code')
})

test('Loomy 用量：两个积分池合计，认证头是 token 而不是 Bearer', () => {
  const account = accountOf('loomy', 'sess-1')
  const { handlers, requests } = createPlugin([{
    status: 200,
    body: JSON.stringify({ code: '000000', data: { balance: 3000, dailyBalance: 500, availableBalance: 3500 } }),
  }], { accounts: JSON.stringify([account]) })

  const item = callHandler(handlers, 'runAction', { action: 'quota', source: 'loomy', ids: [account.id] }).value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 3500)
  assert.equal(item.quota.packages, 2)
  assert.equal(requests[0].headers['token'], 'sess-1')
  assert.equal(requests[0].headers['Authorization'], undefined, 'Loomy 业务端点不认 Bearer')
})

test('Loomy 微信扫码登录：长轮询拿 code，账号接口 MD5 + HMAC-SHA1 签名正确', () => {
  const { handlers, requests } = createPlugin([
    { status: 200, body: '<html><img class="js_qrcode_img" src="/connect/qrcode/uuid-123"/></html>' },
    { status: 200, body: "window.wx_errcode=408;window.wx_code='';" },
    { status: 200, body: "window.wx_errcode=405;window.wx_code='wx-code-1';" },
    { status: 200, body: JSON.stringify({ code: '000000', data: { bind: 1, rcode: 'rc-1', nickname: '小明' } }) },
    { status: 200, body: JSON.stringify({ code: '000000', data: { session: 'sess-123', userid: 'u-1' } }) },
  ], {})

  const start = callHandler(handlers, 'oauthStart', { source: 'loomy' })
  assert.equal(start.ok, true, start.error)
  assert.match(start.value.authUrl, /^https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect\?/)
  assert.equal(callHandler(handlers, 'oauthPoll').value.done, false, '408 是待扫码')
  const done = callHandler(handlers, 'oauthPoll').value
  assert.equal(done.done, true)
  assert.equal(done.token, 'sess-123')
  assert.equal(done.name, '小明')

  // 逐字节复核签名：Content-MD5 与 HMAC-SHA1 都要和 Node 的 crypto 一致
  const exchange = requests[3]
  assert.match(exchange.url, /\/login\/thirdAccount\/bind\/auth$/)
  const body = exchange.body
  const md5 = crypto.createHash('md5').update(body, 'utf8').digest('base64')
  assert.equal(exchange.headers['Content-MD5'], md5)
  const stringToSign = [
    'POST', '/login/thirdAccount/bind/auth', '', md5, 'application/json',
    exchange.headers['Date'], exchange.headers['Nonce'], '', '',
  ].join('\n')
  const signature = crypto.createHmac('sha1', 'zsak6eadrbawz683wf5r3m2snrwj868r')
    .update(stringToSign, 'utf8').digest('base64')
  assert.equal(exchange.headers['Authorization'], `account 2thryby66wxi53sk:${signature}`)

  const payload = JSON.parse(body)
  assert.equal(payload.param.tcode.code, 'wx-code-1')
  assert.equal(payload.base.appid, 'GM3LOOMY')
})

// ---- Trae 国际版 / 国内版

/** 现行的权益包响应（额度在 entitlement_base_info.quota 里） */
function traeUsageBody(packs) {
  return {
    status: 200,
    body: JSON.stringify({
      user_entitlement_pack_list: packs.map(item => ({
        entitlement_base_info: { quota: { credits_limit: item.limit }, display_desc: item.name || '每月登录赠送' },
        usage: { credits_amount: item.used || 0 },
        ...(item.expire ? { expire_time: item.expire } : {}),
      })),
    }),
  }
}

test('Trae CN 用量：打业务域名 api.trae.cn，身份头是 Cloud-IDE-JWT', () => {
  const account = accountOf('trae-cn', 'cn-token', { userId: 'uid-9' })
  const { handlers, urls, requests } = createPlugin([
    traeUsageBody([
      { limit: 500, used: 120, expire: 1790783999 },
      { limit: 150, used: 0, expire: 1793380000 },
    ]),
  ], { accounts: JSON.stringify([account]) })

  const item = callHandler(handlers, 'runAction', { action: 'quota', source: 'trae-cn', ids: [account.id] }).value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 530)
  assert.equal(item.quota.total, 650)
  assert.equal(item.quota.packages, 2)
  assert.equal(item.quota.cycleEnd, new Date(1790783999 * 1000).toISOString(), 'expire_time 是秒级时间戳')

  assert.match(urls[0], /^https:\/\/api\.trae\.cn\/trae\/api\/v2\/pay\/ide_user_ent_usage$/)
  const headers = requests[0].headers
  assert.equal(headers['Authorization'], 'Cloud-IDE-JWT cn-token', '这些端点不认 Bearer')
  assert.equal(headers['Package-Type'], 'stable_cn')
  assert.match(headers['X-Device-Id'], /^\d{15}$/, '设备号是由 uid 派生的 15 位数字')
  assert.equal(headers['X-Market-User-Id'].length, 36)
  assert.equal(headers['Vscode-Sessionid'].length, 64)
  assert.deepEqual(JSON.parse(requests[0].body), { require_usage: true, req_source: 2 })
})

test('Trae CN 用量：国内站 401 时回落 api.trae.ai', () => {
  const account = accountOf('trae-cn', 'intl-token', { userId: 'uid-9' })
  const { handlers, urls } = createPlugin([
    { status: 401, body: '{"code":401}' },
    traeUsageBody([{ limit: 10, used: 1 }]),
  ], { accounts: JSON.stringify([account]) })

  const item = callHandler(handlers, 'runAction', { action: 'quota', source: 'trae-cn', ids: [account.id] }).value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 9)
  assert.match(urls[0], /^https:\/\/api\.trae\.cn\//)
  assert.match(urls[1], /^https:\/\/api\.trae\.ai\//)
})

test('Trae CN 续期：两个区域都 401 时用 refreshToken 换新 token 并重试', () => {
  const account = accountOf('trae-cn', 'cn-token', {
    userId: 'uid-9',
    refreshToken: 'rt-1',
    loginHost: 'https://www.trae.cn',
  })
  const { handlers, requests, store } = createPlugin([
    { status: 401, body: '{}' },
    { status: 401, body: '{}' },
    { status: 200, body: JSON.stringify({ accessToken: 'new-at', refreshToken: 'rt-2' }) },
    traeUsageBody([{ limit: 100, used: 40 }]),
  ], { accounts: JSON.stringify([account]) })

  const item = callHandler(handlers, 'runAction', { action: 'quota', source: 'trae-cn', ids: [account.id] }).value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.quota.remain, 60)

  assert.match(requests[2].url, /\/cloudide\/api\/v3\/trae\/oauth\/ExchangeToken$/)
  assert.equal(JSON.parse(requests[2].body).RefreshToken, 'rt-1')
  assert.equal(requests[3].headers['Authorization'], 'Cloud-IDE-JWT new-at', '重试要用新 token')

  const saved = JSON.parse(store.accounts)[0]
  assert.equal(saved.token, 'cn-token', 'account.token 是账号身份，不能被续期改掉')
  assert.equal(saved.meta.accessToken, 'new-at')
  assert.equal(saved.meta.refreshToken, 'rt-2')
})

test('Trae 签到：查状态 → 领取 → 补查状态拿积分', () => {
  const account = accountOf('trae-cn', 'cn-token', { userId: 'uid-9' })
  const { handlers, calls, store } = createPlugin([
    { status: 200, body: JSON.stringify({ code: 0, enable: true, checked_in: false, credits: 0, streak_days: 3 }) },
    { status: 200, body: JSON.stringify({ code: 0, message: 'success' }) },
    { status: 200, body: JSON.stringify({ code: 0, enable: true, checked_in: true, credits: 150, streak_days: 4 }) },
  ], { accounts: JSON.stringify([account]) })

  const result = callHandler(handlers, 'runAction', { action: 'checkin', source: 'trae-cn', ids: [account.id] })
  const item = result.value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.match(item.message, /150/)
  assert.deepEqual(calls, [
    '/trae/api/v2/ug/checkin_credits/status',
    '/trae/api/v2/ug/checkin_credits/claim',
    '/trae/api/v2/ug/checkin_credits/status',
  ])
  const saved = JSON.parse(store.accounts)[0]
  assert.equal(saved.checkin.state, 'claimed')
  assert.equal(saved.checkin.streak, 4)
})

test('Trae 签到：今天已签过就不再发领取请求', () => {
  const account = accountOf('trae-cn', 'cn-token', { userId: 'uid-9' })
  const { handlers, calls } = createPlugin([
    { status: 200, body: JSON.stringify({ code: 0, enable: true, checked_in: true, credits: 150, streak_days: 5 }) },
  ], { accounts: JSON.stringify([account]) })

  const item = callHandler(handlers, 'runAction', { action: 'checkin', source: 'trae-cn', ids: [account.id] }).value.results[0]
  assert.equal(item.ok, true, JSON.stringify(item))
  assert.equal(item.already, true)
  assert.equal(calls.length, 1, '只查状态')
})

test('Trae 签到：活动未开启时给原因且不发领取请求', () => {
  const account = accountOf('trae-cn', 'cn-token', { userId: 'uid-9' })
  const { handlers, calls } = createPlugin([
    { status: 200, body: JSON.stringify({ code: 0, enable: false, checked_in: false }) },
  ], { accounts: JSON.stringify([account]) })

  const item = callHandler(handlers, 'runAction', { action: 'checkin', source: 'trae-cn', ids: [account.id] }).value.results[0]
  assert.equal(item.ok, false)
  assert.match(item.error, /未开启/)
  assert.equal(calls.length, 1)
})

test('Trae 签到：9074 要提示「人数过多」而不是笼统失败', () => {
  const account = accountOf('trae-cn', 'cn-token', { userId: 'uid-9' })
  const { handlers } = createPlugin([
    { status: 200, body: JSON.stringify({ code: 0, enable: true, checked_in: false }) },
    { status: 200, body: JSON.stringify({ code: 9074, message: '' }) },
  ], { accounts: JSON.stringify([account]) })

  const item = callHandler(handlers, 'runAction', { action: 'checkin', source: 'trae-cn', ids: [account.id] }).value.results[0]
  assert.equal(item.ok, false)
  assert.match(item.error, /人数过多/)
})

test('Trae 来源要声明签到能力并挂到签到动作上', () => {
  const { handlers } = createPlugin([], {})
  const state = callHandler(handlers, 'state').value
  const cn = state.sources.find(item => item.id === 'trae-cn')
  assert.equal(cn.capabilities.checkin, true, '前端按这个字段显示签到按钮')
  const checkin = state.actions.find(item => item.id === 'checkin')
  assert.ok(checkin.sources.includes('trae-cn'))
  assert.ok(checkin.sources.includes('trae'))
})

test('Trae CN 网页登录：先问国内站要登录域名，授权页与回调都用 CN 参数', () => {
  const { handlers, urls } = createPlugin([
    { status: 200, body: JSON.stringify({ loginhost: 'https://www.trae.cn' }) },
  ], {})

  const start = callHandler(handlers, 'oauthStart', { source: 'trae-cn' })
  assert.equal(start.ok, true, start.error)
  assert.match(urls[0], /^https:\/\/www\.trae\.cn\/cloudide\/api\/v3\/trae\/GetLoginGuidance$/)
  assert.match(start.value.authUrl, /^https:\/\/www\.trae\.cn\/authorization\?/)
  // CN 的 client_id / 版本号与国际版不同：用错会让登录页直接「网络错误」
  assert.match(start.value.authUrl, /client_id=en1oxy7wnw8j9n/)
  assert.match(start.value.authUrl, /plugin_version=2\.3\.62834/)
  assert.match(start.value.authUrl, /x_app_version=0\.1\.52/)
  // CN 登录页只认 127.0.0.1:18080 的回调
  assert.match(start.value.authUrl, /auth_callback_url=http%3A%2F%2F127\.0\.0\.1%3A18080%2Fauthorize/)
})

test('Trae 国际版网页登录仍用国际参数与默认回调端口', () => {
  const { handlers } = createPlugin([
    { status: 200, body: JSON.stringify({ loginhost: 'https://www.trae.ai' }) },
  ], {})

  const start = callHandler(handlers, 'oauthStart', { source: 'trae' })
  assert.equal(start.ok, true, start.error)
  assert.match(start.value.authUrl, /^https:\/\/www\.trae\.ai\/authorization\?/)
  assert.match(start.value.authUrl, /client_id=ono9krqynydwx5/)
  assert.match(start.value.authUrl, /plugin_version=local/)
  assert.match(start.value.authUrl, /auth_callback_url=http%3A%2F%2Flocalhost%3A18765%2Fauthorize/)
})

test('Trae CN 回调：老流程直传 refreshToken，能换到 token 并落 meta', () => {
  const { handlers, requests, store } = createPlugin([
    { status: 200, body: JSON.stringify({ loginhost: 'https://www.trae.cn' }) },
    { status: 200, body: JSON.stringify({ accessToken: 'at-1', refreshToken: 'rt-2' }) },
    { status: 200, body: JSON.stringify({ email: 'a@b.com', nickname: '张三' }) },
  ], {})

  const start = callHandler(handlers, 'oauthStart', { source: 'trae-cn' })
  assert.equal(start.ok, true, start.error)

  // 真实回调形态：?refreshToken=...&userInfo={...}&userJwt={...}
  const userInfo = encodeURIComponent(JSON.stringify({
    UserID: 'uid-1234',
    ScreenName: '小明',
    TenantID: 'tenant-9',
  }))
  handlers.__server({ path: '/authorize', query: 'refreshToken=rt-1&userInfo=' + userInfo })

  const done = callHandler(handlers, 'oauthPoll').value
  assert.equal(done.done, true, JSON.stringify(done))
  assert.equal(done.token, 'at-1')
  assert.equal(done.name, '张三')

  const exchange = JSON.parse(requests[1].body)
  assert.equal(exchange.RefreshToken, 'rt-1')
  assert.equal(exchange.ClientID, 'en1oxy7wnw8j9n', 'CN 交换要用 CN client_id')

  callHandler(handlers, 'import', { source: 'trae-cn', text: done.token })
  const saved = JSON.parse(store.accounts)[0]
  assert.equal(saved.meta.refreshToken, 'rt-2')
  assert.equal(saved.meta.loginHost, 'https://www.trae.cn')
  assert.equal(saved.meta.userId, 'uid-1234', 'uid 来自回调的 userInfo.UserID')
  assert.equal(saved.meta.enterpriseId, 'tenant-9', '回调字段名是 TenantID')
})

test('Trae CN 回调：只带 authCodeInfo 时按授权码换 token（PKCE 形态）', () => {
  const { handlers, requests } = createPlugin([
    { status: 200, body: JSON.stringify({ loginhost: 'https://www.trae.cn' }) },
    { status: 200, body: JSON.stringify({ accessToken: 'at-2' }) },
    { status: 200, body: JSON.stringify({ email: 'x@y.com' }) },
  ], {})

  callHandler(handlers, 'oauthStart', { source: 'trae-cn' })
  const authCodeInfo = encodeURIComponent(JSON.stringify({ code: 'ac-1' }))
  handlers.__server({ path: '/authorize', query: 'authCodeInfo=' + authCodeInfo })

  const done = callHandler(handlers, 'oauthPoll').value
  assert.equal(done.done, true, JSON.stringify(done))
  assert.equal(done.token, 'at-2')
  const exchange = JSON.parse(requests[1].body)
  assert.equal(exchange.AuthCode, 'ac-1')
  assert.equal(requests[1].url, 'https://www.trae.cn/trae/api/v3/oauth/ExchangeToken')
})

test('Trae CN 回调：完全没有凭据时报错并列出收到的参数名', () => {
  const { handlers } = createPlugin([
    { status: 200, body: JSON.stringify({ loginhost: 'https://www.trae.cn' }) },
  ], {})

  callHandler(handlers, 'oauthStart', { source: 'trae-cn' })
  handlers.__server({ path: '/authorize', query: 'state=abc' })

  const poll = callHandler(handlers, 'oauthPoll')
  assert.equal(poll.ok, false)
  assert.match(poll.error, /收到的参数/)
  assert.match(poll.error, /state/)
})

test('Trae 授权页不再带 code_challenge（避免被引导到 PKCE 分支）', () => {
  const { handlers } = createPlugin([
    { status: 200, body: JSON.stringify({ loginhost: 'https://www.trae.cn' }) },
  ], {})
  const start = callHandler(handlers, 'oauthStart', { source: 'trae-cn' })
  assert.equal(start.ok, true, start.error)
  assert.equal(/code_challenge/.test(start.value.authUrl), false)
  assert.match(start.value.authUrl, /auth_type=local/)
})

test('扫描 Trae CN 的登录态时带上来源，导入后落到 trae-cn', () => {
  const file = '%APPDATA%\\Trae CN\\User\\globalStorage\\storage.json'
  const storage = JSON.stringify({
    'iCubeAuthInfo://icube-cloud-auth': { accessToken: 'cn-token', email: 'cn@example.com' },
  })
  const intlFile = '%APPDATA%\\Trae\\User\\globalStorage\\storage.json'
  const intlStorage = JSON.stringify({
    'iCubeAuthInfo://icube-cloud-auth': { accessToken: 'intl-token', email: 'intl@example.com' },
  })
  const { handlers } = createPlugin([], {
    __files: { [file]: storage, [intlFile]: intlStorage },
  })

  const scan = callHandler(handlers, 'scanLocalAuth').value
  const cn = scan.accounts.find(item => item.token === 'cn-token')
  const intl = scan.accounts.find(item => item.token === 'intl-token')
  assert.equal(cn.source, 'trae-cn')
  assert.equal(cn.channel, 'Trae CN')
  assert.equal(cn.product, 'trae-cn', '位置要带产品，界面据此过滤')
  assert.equal(intl.source, 'trae')
  assert.equal(intl.product, 'trae')
})

// ---- 运行
let passed = 0
const failures = []
for (const { name, fn } of tests) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  }
  catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}`)
  }
}

console.log(`\n${passed}/${tests.length} 通过`)
if (failures.length > 0) {
  for (const { name, error } of failures) {
    console.error(`\n[失败] ${name}\n  ${error.message}`)
  }
  process.exit(1)
}
