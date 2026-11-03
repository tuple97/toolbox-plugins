/** Agent 账号管理：多来源账号的导入、余量查询、切换与签到。 */

// ------------------------------------------------------------ 来源配置

var SOURCES = [
  {
    id: 'codebuddy',
    label: 'CodeBuddy',
    api: 'https://www.codebuddy.ai',
    capabilities: { usage: true, checkin: true },
  },
  {
    id: 'codebuddy-cn',
    label: 'CodeBuddy（国内）',
    api: 'https://www.codebuddy.cn',
    capabilities: { usage: true, checkin: true },
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    api: 'https://copilot.tencent.com',
    capabilities: { usage: true, checkin: true },
  },
]

/** 扩展动作：界面按 source 渲染，runAction 统一分发 */
var ACTIONS = [
  {
    id: 'quota',
    label: '刷新余量',
    scope: 'account',
    sources: ['codebuddy', 'codebuddy-cn', 'workbuddy'],
  },
  {
    id: 'checkin',
    label: '签到',
    scope: 'account',
    sources: ['codebuddy', 'codebuddy-cn', 'workbuddy'],
  },
  {
    id: 'checkin-all',
    label: '一键签到',
    scope: 'source',
    sources: ['codebuddy', 'codebuddy-cn', 'workbuddy'],
  },
]

/** 计费接口的套餐码白名单（与官方客户端保持一致） */
var PACKAGE_CODES = [
  'TCACA_code_008_cfWoLwvjU4',
  'TCACA_code_009_0XmEQc2xOf',
  'TCACA_code_038_OhvqZtiPKr',
  'TCACA_code_007_nzdH5h4Nl0',
  'TCACA_code_028_NtpWi0jzXs',
  'TCACA_code_029_6wCGEWquYy',
  'TCACA_code_030_BjSt89qTvr',
]

// ------------------------------------------------------------ 存储

var KEY_ACCOUNTS = 'accounts'
var KEY_CURRENT = 'current'

function readJSON(key, fallback) {
  try {
    var raw = toolbox.storage.get(key)
    if (!raw) {
      return fallback
    }
    var value = JSON.parse(raw)
    return (value === null || value === undefined) ? fallback : value
  }
  catch (e) {
    return fallback
  }
}

function writeJSON(key, value) {
  toolbox.storage.set(key, JSON.stringify(value))
}

function loadAccounts() {
  var list = readJSON(KEY_ACCOUNTS, [])
  return Object.prototype.toString.call(list) === '[object Array]' ? list : []
}

function saveAccounts(list) {
  writeJSON(KEY_ACCOUNTS, list)
}

function loadCurrent() {
  var map = readJSON(KEY_CURRENT, {})
  return (map && typeof map === 'object') ? map : {}
}

function saveCurrent(map) {
  writeJSON(KEY_CURRENT, map)
}

// ------------------------------------------------------------ 工具

function sourceOf(id) {
  for (var i = 0; i < SOURCES.length; i++) {
    if (SOURCES[i].id === id) {
      return SOURCES[i]
    }
  }
  return null
}

function newId() {
  return 'acc_' + String(new Date().getTime()) + '_' + String(Math.floor(Math.random() * 100000))
}

function nowISO() {
  return new Date().toISOString()
}

function trim(text) {
  return String(text === null || text === undefined ? '' : text).replace(/^\s+|\s+$/g, '')
}

/** 从一段文本里猜一个可读名字：优先邮箱，其次 token 前缀 */
function nameOf(entry, token) {
  if (entry.email) {
    return String(entry.email)
  }
  if (entry.name) {
    return String(entry.name)
  }
  if (entry.nickname) {
    return String(entry.nickname)
  }
  return '账号 ' + token.slice(0, 6)
}

/** 解析导入文本：每行 token、email:token 或 JSON（对象/数组），支持三种写法混用 */
function parseImportText(text) {
  var out = []
  var trimmed = trim(text)
  if (!trimmed) {
    return out
  }

  if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
    try {
      var parsed = JSON.parse(trimmed)
      var list = Object.prototype.toString.call(parsed) === '[object Array]' ? parsed : [parsed]
      for (var i = 0; i < list.length; i++) {
        var item = list[i] || {}
        var token = item.accessToken || item.access_token || item.token || item.access_token_value || ''
        if (trim(token)) {
          out.push({ token: trim(token), email: trim(item.email), name: trim(item.name || item.nickname) })
        }
      }
      if (out.length > 0) {
        return out
      }
    }
    catch (e) {
      // 不是合法 JSON，退回到逐行解析
    }
  }

  var lines = trimmed.split(/\r?\n/)
  for (var j = 0; j < lines.length; j++) {
    var line = trim(lines[j])
    if (!line || line.charAt(0) === '#') {
      continue
    }
    // email:token —— 冒号必须出现在 @ 之后，否则是把 token 里的冒号当成分隔符
    var at = line.indexOf('@')
    var colon = line.indexOf(':', at + 1)
    if (at > 0 && colon > at) {
      var email = trim(line.slice(0, colon))
      var rest = trim(line.slice(colon + 1))
      if (rest) {
        out.push({ token: rest, email: email, name: '' })
        continue
      }
    }
    out.push({ token: line, email: '', name: '' })
  }
  return out
}

function authHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'x-client-platform': 'web',
  }
}

/** 把服务端的错误响应揉成一句可读的话 */
function describeHTTPError(what, resp) {
  var body = parseBody(resp)
  var message = ''
  if (body && typeof body === 'object') {
    message = trim(
      body.msg
      || body.message
      || (body.data && (body.data.msg || body.data.message))
      || body.error
      || body.error_description
      || '',
    )
  }

  var status = resp.status
  var code = body && body.code !== undefined && body.code !== null ? body.code : ''
  // 技术细节（状态码 / 业务码 / 原文片段）只进日志
  toolbox.log('[' + what + '] HTTP ' + status
    + (code !== '' ? ' code=' + code : '')
    + '；响应：' + String(resp.body || '').slice(0, 160))

  if (!message) {
    var raw = String(resp.body || '')
    // 网关/代理返回的 HTML 页：不把整页塞进提示
    if (/^\\s*</.test(raw)) {
      message = '服务端拒绝了请求，多为登录态或网络白名单问题，请重新导入账号'
    }
    else if (raw) {
      message = trim(raw.slice(0, 80))
    }
  }
  // 面向用户只留一句话：服务端给的原因（没有就给通用提示）
  return new Error(message || (what + '失败，请稍后重试'))
}

/** 发一个 JSON 请求；非 2xx 一律抛出带服务端原因的异常 */
function requestOK(method, url, token, body, what) {
  var resp = requestJSON(method, url, token, body)
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('登录态已失效，请重新导入账号')
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw describeHTTPError(what, resp)
  }
  return resp
}

function requestJSON(method, url, token, body) {
  var payload = {
    method: method,
    url: url,
    headers: authHeaders(token),
  }
  if (body !== undefined && body !== null) {
    payload.body = JSON.stringify(body)
  }
  return toolbox.http.request(payload)
}

function parseBody(resp) {
  try {
    return JSON.parse(resp.body)
  }
  catch (e) {
    return null
  }
}

/** 在若干层壳里找 Accounts 数组（不同版本接口层级不一致） */
function findAccounts(payload) {
  if (!payload) {
    return []
  }
  var candidates = [
    payload.data && payload.data.Response && payload.data.Response.Data && payload.data.Response.Data.Accounts,
    payload.Response && payload.Response.Data && payload.Response.Data.Accounts,
    payload.Data && payload.Data.Accounts,
    payload.data && payload.data.Accounts,
    payload.Accounts,
  ]
  for (var i = 0; i < candidates.length; i++) {
    if (Object.prototype.toString.call(candidates[i]) === '[object Array]') {
      return candidates[i]
    }
  }
  return []
}

function numberOr(value, fallback) {
  var num = Number(value)
  return isNaN(num) ? fallback : num
}

// ------------------------------------------------------------ 余量

function queryQuota(source, token) {
  var resp = requestOK('POST', source.api + '/v2/billing/meter/get-user-resource', token, {
    PageNumber: 1,
    PageSize: 200,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    OnlyValidPeriod: true,
    PackageCodes: PACKAGE_CODES,
    NeedInUsage: true,
  }, '余量查询')

  var payload = parseBody(resp)
  // HTTP 200 也可能是业务失败：只有 code 为 0/200 才算成功
  var code = payload && payload.code !== undefined && payload.code !== null ? payload.code : 0
  if (String(code) !== '0' && String(code) !== '200') {
    var message = trim(payload && (payload.msg || payload.message)) || '服务端返回 code=' + code
    throw new Error('余量查询失败：' + message)
  }

  var accounts = findAccounts(payload)
  var remain = 0
  var total = 0
  var cycleEnd = ''
  for (var i = 0; i < accounts.length; i++) {
    var pack = accounts[i] || {}
    // 周期制以 Cycle* 为准，避免把未到期额度算进来
    var packRemain = numberOr(pack.CycleCapacityRemainPrecise, numberOr(pack.CapacityRemainPrecise, 0))
    var packSize = numberOr(pack.CycleCapacitySizePrecise, numberOr(pack.CapacitySizePrecise, 0))
    remain += packRemain
    if (packRemain > 0) {
      total += packSize
    }
    if (pack.CycleEndTime && pack.CycleEndTime > cycleEnd) {
      cycleEnd = pack.CycleEndTime
    }
  }

  return {
    remain: Math.round(remain * 100) / 100,
    total: Math.round(total * 100) / 100,
    cycleEnd: cycleEnd,
    packages: accounts.length,
    updatedAt: nowISO(),
  }
}

// ------------------------------------------------------------ 签到

/** 解析签到状态：返回 claimed / unclaimed / unknown */
function checkinStateOf(payload) {
  if (!payload) {
    return 'unknown'
  }
  var data = payload.data || payload.Data || payload

  // 1) 主字段 today_checked_in（大小写两种写法都认）
  var todayChecked = data.today_checked_in
  if (todayChecked === undefined || todayChecked === null) {
    todayChecked = data.TodayCheckedIn
  }
  if (todayChecked === true || todayChecked === 1 || todayChecked === 'true') {
    return 'claimed'
  }
  if (todayChecked === false || todayChecked === 0 || todayChecked === 'false') {
    return 'unclaimed'
  }

  // 2) 兼容旧字段
  var state = data.state || data.State || data.status || ''
  var text = String(state).toLowerCase()
  if (text === 'claimed' || text === 'checked' || text === 'done' || text === '1') {
    return 'claimed'
  }
  if (text === 'unclaimed' || text === '0' || text === 'false') {
    return 'unclaimed'
  }
  if (data.checked === true || data.Claimed === true) {
    return 'claimed'
  }
  if (data.checked === false) {
    return 'unclaimed'
  }
  return 'unknown'
}

/** 从状态响应里取连续天数（真实字段 streak_days） */
function checkinStreakOf(payload) {
  if (!payload) {
    return 0
  }
  var data = payload.data || payload.Data || payload
  var days = data.streak_days
  if (days === undefined || days === null) {
    days = data.StreakDays
  }
  return numberOr(days, 0)
}

/** 查询签到状态，返回 { state, streak, payload }；两条路径逐个试 */
function checkinStatus(source, token) {
  var paths = ['/v2/billing/meter/checkin-activity-status', '/v2/billing/meter/checkin-status']
  var lastError = ''
  for (var i = 0; i < paths.length; i++) {
    try {
      var resp = requestJSON('POST', source.api + paths[i], token, {})
      if (resp.status === 200) {
        var payload = parseBody(resp)
        var code = payload && payload.code !== undefined && payload.code !== null ? payload.code : 0
        // 业务失败（非 0）不能当成「还没签到」，否则会把失败误判成可签
        if (String(code) !== '0' && String(code) !== '200') {
          lastError = trim(payload && (payload.msg || payload.message)) || 'code=' + code
          continue
        }
        return {
          state: checkinStateOf(payload),
          streak: checkinStreakOf(payload),
          payload: payload,
        }
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new Error('登录态已失效，请重新导入账号')
      }
      lastError = describeHTTPError('签到状态查询', resp).message
    }
    catch (e) {
      if (e && e.message && e.message.indexOf('登录态已失效') >= 0) {
        throw e
      }
      lastError = String(e && e.message ? e.message : e)
    }
  }
  throw new Error(lastError || '无法获取签到状态')
}

/** 执行签到；code 10001 或提示已签到都视为「今天已签过」 */
function performCheckin(source, token) {
  var resp = requestJSON('POST', source.api + '/v2/billing/meter/daily-checkin', token, {})
  var payload = parseBody(resp)
  var code = payload ? numberOr(payload.code, numberOr(payload.data && payload.data.code, 0)) : 0
  var reply = trim(payload ? (payload.msg || payload.message || (payload.data && (payload.data.msg || payload.data.message))) : '')

  // 10001 = 今天已经签过：不是失败，但也不能算「刚刚签到成功」
  if (code === 10001 || /已签到|已经签到|重复签/.test(reply)) {
    return { state: 'claimed', message: reply || '今天已经签到过了', already: true }
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new Error('登录态已失效，请重新导入账号')
  }
  if (String(code) !== '0' && String(code) !== '200') {
    // 有业务说明就以它为准；具体 code 只进日志
    toolbox.log('[签到] HTTP ' + resp.status + ' code=' + code + '；消息：' + reply)
    throw new Error(reply || '签到失败，请稍后重试')
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw describeHTTPError('签到', resp)
  }

  return { state: 'claimed', message: reply || '签到成功', already: false }
}

/** 给单个账号签到：先查状态，已签过的直接返回 */
function runCheckin(account, source) {
  var status = checkinStatus(source, account.token)
  var streakFromServer = status.streak || 0
  if (status.state === 'claimed') {
    // 服务端已明确「今天签过」，不再发签到请求
    account.checkin = {
      state: 'claimed',
      message: '今天已经签到过了',
      lastAt: account.checkin && account.checkin.lastAt ? account.checkin.lastAt : nowISO(),
      streak: streakFromServer || (account.checkin && account.checkin.streak) || 0,
    }
    account.updatedAt = nowISO()
    return { ok: true, message: account.checkin.message, already: true }
  }

  var result = performCheckin(source, account.token)
  var streakBase = streakFromServer || (account.checkin && account.checkin.streak) || 0
  account.checkin = {
    state: result.state,
    message: result.message,
    lastAt: nowISO(),
    // 服务端给了天数就以服务端为准，否则本地累加
    streak: result.already ? streakBase : (streakFromServer || streakBase + 1),
  }
  account.updatedAt = nowISO()
  return { ok: true, message: result.message, already: result.already }
}

// ------------------------------------------------------------ 账号操作

function findAccount(list, id) {
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      return list[i]
    }
  }
  return null
}

function publicView(account, currentMap, index) {
  var view = {
    id: account.id,
    source: account.source,
    name: account.name,
    addedAt: account.addedAt,
    updatedAt: account.updatedAt,
    quota: account.quota || null,
    checkin: account.checkin || null,
    current: currentMap[account.source] === account.id,
    index: index,
  }
  return view
}

function stateSnapshot() {
  var list = loadAccounts()
  var currentMap = loadCurrent()
  var accounts = []
  for (var i = 0; i < list.length; i++) {
    accounts.push(publicView(list[i], currentMap, i))
  }
  return {
    sources: SOURCES,
    actions: ACTIONS,
    accounts: accounts,
    current: currentMap,
  }
}

// ------------------------------------------------------------ 扩展动作

function runQuota(account, source) {
  var quota = queryQuota(source, account.token)
  account.quota = quota
  account.updatedAt = nowISO()
  return { ok: true, quota: quota }
}

/** 统一动作入口；ids 为空表示该来源下全部账号 */
function runAction(input) {
  var action = trim(input && input.action)
  var sourceId = trim(input && input.source)
  var ids = (input && input.ids) || []
  var results = []

  // 兼容旧动作名：checkin-all 与 checkin 的语义已合并为「批量签该来源全部」
  if (action === 'checkin-all') {
    action = 'checkin'
  }

  var list = loadAccounts()

  for (var i = 0; i < list.length; i++) {
    var account = list[i]
    if (sourceId && account.source !== sourceId) {
      continue
    }
    if (ids.length > 0 && ids.indexOf(account.id) === -1) {
      continue
    }
    var source = sourceOf(account.source)
    if (!source) {
      results.push({ id: account.id, ok: false, error: '未知来源: ' + account.source })
      continue
    }
    try {
      if (action === 'quota') {
        results.push({ id: account.id, ok: true, quota: runQuota(account, source).quota })
      }
      else if (action === 'checkin') {
        var checkin = runCheckin(account, source)
        if (!checkin.ok) {
          results.push({ id: account.id, ok: false, error: checkin.error })
        }
        else {
          results.push({
            id: account.id,
            ok: true,
            message: checkin.message,
            already: checkin.already,
          })
        }
      }
      else {
        results.push({ id: account.id, ok: false, error: '未知动作: ' + action })
      }
    }
    catch (e) {
      results.push({ id: account.id, ok: false, error: String(e && e.message ? e.message : e) })
    }
  }

  saveAccounts(list)
  return { action: action, results: results, state: stateSnapshot() }
}

// ------------------------------------------------------------ handler

toolbox.handler('state', function () {
  return stateSnapshot()
})

toolbox.handler('import', function (input) {
  var sourceId = trim(input && input.source)
  var source = sourceOf(sourceId)
  if (!source) {
    throw new Error('请先选择账号来源')
  }

  var entries = parseImportText(input && input.text)
  if (entries.length === 0) {
    throw new Error('没有解析到任何 token')
  }

  var list = loadAccounts()
  var known = {}
  for (var i = 0; i < list.length; i++) {
    known[list[i].source + '\n' + list[i].token] = true
  }

  var added = 0
  var skipped = 0
  for (var j = 0; j < entries.length; j++) {
    var entry = entries[j]
    var key = sourceId + '\n' + entry.token
    if (known[key]) {
      skipped++
      continue
    }
    known[key] = true
    list.push({
      id: newId(),
      source: sourceId,
      name: nameOf(entry, entry.token),
      token: entry.token,
      addedAt: nowISO(),
      updatedAt: nowISO(),
      quota: null,
      checkin: null,
    })
    added++
  }
  saveAccounts(list)

  toolbox.events.emit('accounts-changed', { added: added, skipped: skipped })
  return { added: added, skipped: skipped, state: stateSnapshot() }
})

toolbox.handler('remove', function (input) {
  var id = trim(input && input.id)
  var list = loadAccounts()
  var next = []
  var removed = null
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      removed = list[i]
    }
    else {
      next.push(list[i])
    }
  }
  if (!removed) {
    throw new Error('账号不存在')
  }
  saveAccounts(next)

  var currentMap = loadCurrent()
  if (currentMap[removed.source] === id) {
    delete currentMap[removed.source]
    saveCurrent(currentMap)
  }
  return stateSnapshot()
})

toolbox.handler('rename', function (input) {
  var id = trim(input && input.id)
  var list = loadAccounts()
  var account = findAccount(list, id)
  if (!account) {
    throw new Error('账号不存在')
  }
  account.name = trim(input && input.name) || account.name
  account.updatedAt = nowISO()
  saveAccounts(list)
  return stateSnapshot()
})

toolbox.handler('setCurrent', function (input) {
  var sourceId = trim(input && input.source)
  var id = trim(input && input.id)
  var list = loadAccounts()
  var account = findAccount(list, id)
  if (!account || account.source !== sourceId) {
    throw new Error('该来源下没有这个账号')
  }

  var currentMap = loadCurrent()
  if (currentMap[sourceId] === id) {
    delete currentMap[sourceId]
  }
  else {
    currentMap[sourceId] = id
  }
  saveCurrent(currentMap)
  return stateSnapshot()
})

toolbox.handler('runAction', function (input) {
  return runAction(input)
})

toolbox.handler('reveal', function (input) {
  var list = loadAccounts()
  var account = findAccount(list, trim(input && input.id))
  if (!account) {
    throw new Error('账号不存在')
  }
  // 只回传后四位，避免明文 token 长期停在界面上
  var token = String(account.token)
  return { token: token, masked: token.length > 8 ? token.slice(0, 4) + '…' + token.slice(-4) : '…' }
})

// ------------------------------------------------------------ 网页登录
// 网页登录：state + 轮询，由前端定时器驱动

/** 安全取对象：响应里的 data 可能不是对象 */
function objectOf(value) {
  if (value && typeof value === 'object') {
    return value
  }
  return {}
}

var LOGIN_TTL_MS = 10 * 60 * 1000
var pendingLogin = null

/** 登录相关请求统一带这几个头，表示匿名请求 */
var ANON_HEADERS = {
  'X-No-Authorization': 'true',
  'X-No-User-Id': 'true',
  'X-No-Enterprise-Id': 'true',
  'X-No-Department-Info': 'true',
  'Content-Type': 'application/json',
}

/** UUID v4：只用于 loginSessionId / loginId，随机即可 */
function newSessionId() {
  var hex = '0123456789abcdef'
  var out = ''
  for (var i = 0; i < 32; i++) {
    out += hex.charAt(Math.floor(Math.random() * 16))
  }
  return out.slice(0, 8) + '-' + out.slice(8, 12) + '-4' + out.slice(13, 16) +
    '-8' + out.slice(17, 20) + '-' + out.slice(20, 32)
}

function readBody(resp, what) {
  if (resp.status < 200 || resp.status >= 300) {
    throw describeHTTPError(what, resp)
  }
  try {
    return JSON.parse(resp.body)
  }
  catch (e) {
  // 网关 HTML 页不提示原文，只记日志
    toolbox.log('[' + what + '] 响应不是 JSON：' + String(resp.body).slice(0, 120))
    throw new Error(what + '失败，请稍后重试')
  }
}

/** 发起网页登录：取一次 state 与授权页地址 */
toolbox.handler('oauthStart', function (input) {
  var sourceId = trim(input && input.source)
  var source = sourceOf(sourceId)
  if (!source) {
    throw new Error('请先选择账号来源')
  }

  var resp = toolbox.http.request({
    method: 'POST',
    url: source.api + '/v2/plugin/auth/state?platform=ide',
    headers: ANON_HEADERS,
    body: '{}',
  })
  var body = objectOf(readBody(resp, 'auth/state'))
  var data = objectOf(body.data)
  var state = trim(data.state)
  var authUrl = trim(data.authUrl || data.auth_url || data.url)
  if (state === '' || authUrl === '') {
    throw new Error('登录接口没有返回 state / authUrl')
  }

  pendingLogin = {
    loginId: newSessionId(),
    sourceId: sourceId,
    state: state,
    authUrl: authUrl,
    expiresAt: Date.now() + LOGIN_TTL_MS,
  }

  return {
    loginId: pendingLogin.loginId,
    authUrl: authUrl + (authUrl.indexOf('?') >= 0 ? '&' : '?') +
      'loginSessionId=' + newSessionId(),
    expiresIn: Math.floor(LOGIN_TTL_MS / 1000),
    intervalMs: 1500,
  }
})

/** 轮询一次登录结果；done=false 表示还没完成 */
toolbox.handler('oauthPoll', function () {
  if (!pendingLogin) {
    throw new Error('没有进行中的登录，请重新发起')
  }
  if (Date.now() > pendingLogin.expiresAt) {
    pendingLogin = null
    throw new Error('登录已超时，请重新发起')
  }

  var source = sourceOf(pendingLogin.sourceId)
  if (!source) {
    throw new Error('登录来源已失效，请重新发起')
  }

  var resp = toolbox.http.request({
    method: 'GET',
    url: source.api + '/v2/plugin/auth/token?state=' + encodeURIComponent(pendingLogin.state),
    headers: ANON_HEADERS,
  })
  var body = objectOf(readBody(resp, 'auth/token'))
  var code = Number(body.code)
  var msg = trim(body.msg || body.message)

  // 非 0/200 时区分「继续等待」与「终局失败」
  if (code !== 0 && code !== 200) {
    if (isTransientLoginCode(code, msg)) {
      return { done: false }
    }
    pendingLogin = null
    toolbox.log('[oauthPoll] 登录失败 code=' + code + '；消息：' + msg)
    throw new Error(msg || '登录失败，请重新发起')
  }

  var data = objectOf(body.data)
  var token = trim(data.accessToken || data.access_token)
  if (token === '') {
    return { done: false }
  }

  var result = {
    done: true,
    token: token,
    email: trim(data.email || data.mail),
    name: trim(data.nickname || data.name),
  }
  pendingLogin = null
  return result
})

/** 判断登录轮询的非 0 业务码是否属于「继续等待」 */
function isTransientLoginCode(code, msg) {
  // 已知的「等待中」文案
  if (/未登录|未完成|等待|处理中|pending|not.?login|not.?authorized/i.test(msg)) {
    return true
  }
  // 明确的终局错误
  if (/失效|过期|不存在|拒绝|denied|invalid|expired/i.test(msg)) {
    return false
  }
  return true
}

/** 取消进行中的登录（用户关掉登录弹窗时调） */
toolbox.handler('oauthCancel', function () {
  pendingLogin = null
  return { ok: true }
})

// ------------------------------------------------------------ 本地登录态扫描

/** 各家写在 secret-storage.xml 里的键名（与 IDEA 插件一致） */
var AUTH_KEYS = [
  'Tencent-Cloud.coding-copilot.new.accessToken',
  'Tencent-Cloud.coding-copilot.accessToken',
  'planning-genie.new.accessTokencn',
  'planning-genie.new.accessToken',
]

/** XML 属性是转义过的，先还原再当 JSON 解析 */
function unescapeXml(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** 从一个 secret-storage.xml 里取出 accessToken */
function tokensFromSecretStorage(xml, channel) {
  var out = []
  var re = /<Entry\s+key="([^"]+)"\s+value="([^"]*)"/g
  var match = re.exec(xml)
  while (match !== null) {
    var key = match[1]
    if (AUTH_KEYS.indexOf(key) < 0 && key.indexOf('accessToken') < 0) {
      match = re.exec(xml)
      continue
    }
    var raw = unescapeXml(match[2])
    var token = ''
    try {
      var parsed = JSON.parse(raw)
      token = trim(parsed.accessToken || (parsed.auth && parsed.auth.accessToken))
    }
    catch (e) {
      token = trim(raw)
    }
    if (token.length > 20) {
      out.push({ token: token, channel: channel })
    }
    match = re.exec(xml)
  }
  return out
}

/** 扫描本机 JetBrains 系的登录态，按 token 去重 */
toolbox.handler('scanLocalAuth', function () {
  var results = []
  var seen = {}
  var skipped = []

  var roots = ['%APPDATA%\\JetBrains', '%LOCALAPPDATA%\\JetBrains']
  for (var r = 0; r < roots.length; r++) {
    var root = roots[r]
    var dirs = []
    try {
      dirs = toolbox.fs.list(root) || []
    }
    catch (e) {
      dirs = []
    }
    for (var i = 0; i < dirs.length; i++) {
      var file = root + '\\' + dirs[i] + '\\options\\secret-storage.xml'
      if (!toolbox.fs.exists(file)) {
        continue
      }
      try {
        var xml = toolbox.fs.readText(file)
        var found = tokensFromSecretStorage(xml, 'IDEA · ' + dirs[i])
        for (var j = 0; j < found.length; j++) {
          if (seen[found[j].token]) {
            continue
          }
          seen[found[j].token] = true
          results.push({
            token: found[j].token,
            channel: found[j].channel,
            file: file,
          })
        }
      }
      catch (e) {
        // 读不了的目录直接跳过，不影响其它渠道
      }
    }
  }

  skipped.push('VSCode / CodeBuddy IDE（SQLite）、WorkBuddy（SQLite）')
  return { accounts: results, pending: skipped }
})
