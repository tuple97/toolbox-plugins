/**
 * Agent 账号管理：多来源账号的导入、余量查询、切换与签到。
 *
 * 设计成「来源配置表 + 通用能力」：
 *   新增一个来源 = 往 SOURCES 里加一条（域名、能力开关、扩展动作），
 *   不需要改导入/查询/切换的主流程。
 *
 * 扩展点：
 *   - state.actions 把「当前来源可做的动作」交给界面渲染；
 *   - runAction({ action, ids, source }) 是统一入口，
 *     其它插件也可以通过 runtime.exports 调用它（见清单 exports）。
 *
 * 只用 ES5 语法：后端跑在 goja 里，没有模块系统与 Node API。
 */

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
  { id: 'quota', label: '刷新余量', scope: 'account', sources: ['codebuddy', 'codebuddy-cn', 'workbuddy'] },
  { id: 'checkin', label: '签到', scope: 'account', sources: ['codebuddy', 'codebuddy-cn', 'workbuddy'] },
  { id: 'checkin-all', label: '一键签到', scope: 'source', sources: ['codebuddy', 'codebuddy-cn', 'workbuddy'] },
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

/**
 * 解析导入文本，支持三种写法混用：
 *   1. 每行一个 accessToken
 *   2. 每行 email:token
 *   3. 一段 JSON（对象或数组），字段取 accessToken / access_token / token / email
 */
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
  var resp = requestJSON('POST', source.api + '/v2/billing/meter/get-user-resource', token, {
    PageNumber: 1,
    PageSize: 200,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    OnlyValidPeriod: true,
    PackageCodes: PACKAGE_CODES,
    NeedInUsage: true,
  })

  if (resp.status === 401 || resp.status === 403) {
    throw new Error('登录态已失效，请重新导入 token')
  }
  if (resp.status !== 200) {
    throw new Error('接口返回 ' + resp.status)
  }

  var accounts = findAccounts(parseBody(resp))
  var remain = 0
  var total = 0
  var cycleEnd = ''
  for (var i = 0; i < accounts.length; i++) {
    var pack = accounts[i] || {}
    // 周期制以 Cycle* 为准：Capacity* 会把下月未到期的额度算进来，导致虚高
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

function checkinStateOf(payload) {
  if (!payload) {
    return 'unknown'
  }
  var data = payload.data || payload.Data || payload
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

function checkinStatus(source, token) {
  var paths = ['/v2/billing/meter/checkin-activity-status', '/v2/billing/meter/checkin-status']
  var lastError = ''
  for (var i = 0; i < paths.length; i++) {
    try {
      var resp = requestJSON('POST', source.api + paths[i], token, {})
      if (resp.status === 200) {
        return checkinStateOf(parseBody(resp))
      }
      lastError = '接口返回 ' + resp.status
    }
    catch (e) {
      lastError = String(e && e.message ? e.message : e)
    }
  }
  throw new Error(lastError || '无法获取签到状态')
}

function performCheckin(source, token) {
  var resp = requestJSON('POST', source.api + '/v2/billing/meter/daily-checkin', token, {})
  var payload = parseBody(resp)

  if (resp.status === 401 || resp.status === 403) {
    throw new Error('登录态已失效，请重新导入 token')
  }
  if (resp.status !== 200) {
    throw new Error('签到接口返回 ' + resp.status)
  }

  var code = payload ? numberOr(payload.code || (payload.data && payload.data.code), 0) : 0
  // 10001 = 今天已经签过，不是失败
  if (code === 10001) {
    return { state: 'claimed', message: '今天已经签到过了' }
  }
  var message = ''
  if (payload) {
    message = payload.msg || payload.message || (payload.data && (payload.data.msg || payload.data.message)) || ''
  }
  return { state: 'claimed', message: message || '签到成功' }
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

function runCheckin(account, source) {
  var state = checkinStatus(source, account.token)
  if (state === 'claimed') {
    account.checkin = {
      state: 'claimed',
      message: '今天已经签到过了',
      lastAt: nowISO(),
      streak: (account.checkin && account.checkin.streak) || 0,
    }
    account.updatedAt = nowISO()
    return { ok: true, message: account.checkin.message }
  }
  var result = performCheckin(source, account.token)
  account.checkin = {
    state: result.state,
    message: result.message,
    lastAt: nowISO(),
    streak: ((account.checkin && account.checkin.streak) || 0) + 1,
  }
  account.updatedAt = nowISO()
  return { ok: true, message: result.message }
}

/**
 * 统一动作入口。
 *
 * ids 为空时表示「该来源下的全部账号」（一键签到就是这么用的）。
 */
function runAction(input) {
  var action = trim(input && input.action)
  var sourceId = trim(input && input.source)
  var ids = (input && input.ids) || []
  var results = []

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
      else if (action === 'checkin' || action === 'checkin-all') {
        results.push({ id: account.id, ok: true, message: runCheckin(account, source).message })
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
