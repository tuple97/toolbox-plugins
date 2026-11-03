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
  const calls = []
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
    // 本地扫描不在本测试范围内：给空实现即可
    fs: { readText: () => '', exists: () => false, list: () => [] },
    http: {
      request: (req) => {
        calls.push(req.url.replace(/^https:\/\/[^/]+/, ''))
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
  return { handlers, store, calls }
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

test('一键签到覆盖该来源下所有账号', () => {
  const seed = {
    accounts: JSON.stringify([ACCOUNT, { ...ACCOUNT, id: 'acc_2' }, { ...ACCOUNT, id: 'acc_3' }]),
    current: JSON.stringify({ 'codebuddy-cn': ACCOUNT.id }),
  }
  const { handlers, calls } = createPlugin([STATUS_UNCHECKED, { status: 200, body: JSON.stringify({ code: 0, msg: '签到成功' }) }], seed)
  const result = callHandler(handlers, 'runAction', { action: 'checkin-all', source: 'codebuddy-cn' })
  assert.equal(result.value.results.length, 3, '三个账号都应被处理')
  assert.ok(result.value.results.every(item => item.ok), '全部应成功')
  assert.equal(calls.length, 6, '每个账号：先查状态 1 次 + 再签到 1 次')
})

test('一键签到会跳过今天已签过的账号，不重复请求', () => {
  const seed = {
    accounts: JSON.stringify([ACCOUNT, { ...ACCOUNT, id: 'acc_2' }]),
    current: JSON.stringify({ 'codebuddy-cn': ACCOUNT.id }),
  }
  // 两个账号的状态接口都说「今天签过」
  const { handlers, calls } = createPlugin([STATUS_CHECKED], seed)
  const result = callHandler(handlers, 'runAction', { action: 'checkin-all', source: 'codebuddy-cn' })
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
  const result = callHandler(handlers, 'runAction', { action: 'checkin-all', source: 'codebuddy-cn' })
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
