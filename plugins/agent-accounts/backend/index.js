/** Agent 账号管理：多来源账号的导入、余量查询、切换与签到。 */

// ------------------------------------------------------------ 来源配置

var SOURCES = [
  {
    id: 'codebuddy',
    label: 'CodeBuddy',
    api: 'https://www.codebuddy.ai',
    capabilities: { usage: true, checkin: true, oauth: true },
  },
  {
    id: 'codebuddy-cn',
    label: 'CodeBuddy CN',
    api: 'https://www.codebuddy.cn',
    capabilities: { usage: true, checkin: true, oauth: true },
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    api: 'https://copilot.tencent.com',
    capabilities: { usage: true, checkin: true, oauth: true },
  },
  {
    // Cursor 只查用量，没有签到概念；网页登录走 loginDeepControl + 轮询
    id: 'cursor',
    label: 'Cursor',
    api: 'https://cursor.com',
    capabilities: { usage: true, checkin: false, oauth: true },
  },
  {
    // 配额没有独立端点：要走账号刷新链路（Firebase → RegisterUser → GetUserStatus）
    id: 'windsurf',
    label: 'Windsurf',
    api: '',
    capabilities: { usage: true, checkin: false, oauth: true },
  },
  {
    // 用量优先从本地 secret storage 读，拿不到再用登录 token 查远程
    id: 'qoder',
    label: 'Qoder',
    api: '',
    capabilities: { usage: true, checkin: false, oauth: true },
  },
  {
    // 用量走 GitHub 自己的接口（quota_snapshots），没有签到概念
    id: 'github-copilot',
    label: 'GitHub Copilot',
    api: 'https://api.github.com',
    capabilities: { usage: true, checkin: false, oauth: true },
  },
  {
    // 用量走 AWS runtime 的 getUsageLimits，region 从 profileArn 解
    id: 'kiro',
    label: 'Kiro',
    api: '',
    capabilities: { usage: true, checkin: false, oauth: true },
  },
  {
    // 用量走 cloudcode-pa 的 retrieveUserQuotaSummary（按模型桶给剩余百分比）
    id: 'antigravity',
    label: 'Antigravity',
    api: '',
    capabilities: { usage: true, checkin: false, oauth: true },
  },
  {
    // 配额只有「窗口剩余比例」（5 小时窗 + 周窗），接口在 sandbox 端点；
    // 凭据只存在插件自己的 storage 里，没有可写回的本地登录态
    id: 'gemini',
    label: 'Gemini (Cloud Code)',
    api: 'https://daily-cloudcode-pa.sandbox.googleapis.com',
    capabilities: { usage: true, checkin: false, oauth: true, targets: false, switch: false },
  },
  {
    // 设备码 + PKCE；轮询用 200 + status=pending 表达「还在等」，不是标准的 400
    id: 'minimax',
    label: 'MiniMax Code',
    api: 'https://agent.minimax.cn',
    capabilities: { usage: true, checkin: false, oauth: true, targets: false, switch: false },
  },
  {
    // 设备码轮询（WorkOS）→ 再用 WorkOS 令牌换 Cline 自己的令牌。
    // 访问令牌必须保留 `workos:` 前缀，剥掉即 401
    id: 'cline',
    label: 'Cline',
    api: 'https://api.cline.bot',
    capabilities: { usage: true, checkin: false, oauth: true, targets: false, switch: false },
  },
  {
    // 标准 PKCE 公开客户端（无 client_secret），回调落本地 loopback
    id: 'accio',
    label: 'Accio (阿里)',
    api: 'https://phoenix-gw.alibaba.com',
    capabilities: { usage: true, checkin: false, oauth: true, targets: false, switch: false },
  },
  {
    // 本地回调 + authCode 换 token；exchange 要带安装 uuid 与两个 keyfrom 时间戳
    id: 'lobsterai',
    label: 'LobsterAI (有道)',
    api: 'https://lobsterai-server.youdao.com',
    capabilities: { usage: true, checkin: false, oauth: true, targets: false, switch: false },
  },
  {
    // 微信扫码：code 由本地生成，官方登录页 /login/mp 是公开页面，直接打开即可
    id: 'raccoon',
    label: 'Raccoon (商汤)',
    api: 'https://xiaohuanxiong.com',
    capabilities: { usage: true, checkin: false, oauth: true, targets: false, switch: false },
  },
  {
    // 微信扫码（code 由长轮询拿）+ 讯飞账号 HMAC-SHA1 签名；无 refresh，14 天后要重登
    id: 'loomy',
    label: 'Loomy (讯飞)',
    api: 'https://loomyad.xunfei.cn',
    capabilities: { usage: true, checkin: false, oauth: true, targets: false, switch: false },
  },
  {
    // Trae 国际版：登录态在 storage.json，登录打 www.trae.ai；
    // 余量与签到打业务域名 api.trae.ai（走 Cloud-IDE-JWT 身份头）
    id: 'trae',
    label: 'Trae',
    api: 'https://api.trae.ai',
    capabilities: { usage: true, checkin: true, oauth: true },
  },
  {
    // Trae 国内版：同一套 storage.json 结构，登录打 www.trae.cn，
    // 余量与签到打 api.trae.cn
    id: 'trae-cn',
    label: 'Trae CN',
    api: 'https://api.trae.cn',
    capabilities: { usage: true, checkin: true, oauth: true },
  },
  {
    // Codex 的登录态在 ~/.codex/auth.json，只有 token，没有配额端点
    id: 'codex',
    label: 'Codex',
    api: '',
    capabilities: { usage: false, checkin: false, oauth: false },
  },
  {
    // Zed 的登录态在自有 SQLite 的 kv_store 里，只读
    id: 'zed',
    label: 'Zed',
    api: '',
    capabilities: { usage: false, checkin: false, oauth: false },
  },
]

/** 扩展动作：界面按 source 渲染，runAction 统一分发 */
var ACTIONS = [
  {
    id: 'quota',
    label: '刷新余量',
    scope: 'account',
    sources: [
      'codebuddy', 'codebuddy-cn', 'workbuddy', 'windsurf',
      'github-copilot', 'cursor', 'qoder', 'kiro', 'antigravity', 'gemini', 'minimax', 'cline', 'accio',
      'lobsterai', 'raccoon', 'loomy', 'trae', 'trae-cn',
    ],
  },
  {
    id: 'checkin',
    label: '签到',
    scope: 'account',
    sources: ['codebuddy', 'codebuddy-cn', 'workbuddy', 'trae', 'trae-cn'],
  },
  {
    id: 'checkin-all',
    label: '一键签到',
    scope: 'source',
    sources: ['codebuddy', 'codebuddy-cn', 'workbuddy', 'trae', 'trae-cn'],
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

/**
 * CodeBuddy 系（codebuddy / codebuddy-cn / workbuddy）的身份标识。
 *
 * 对齐官方客户端在控制面请求里带的一组头：
 *   X-Domain       本次请求属于哪个站点（必须是请求主机的裸域名）
 *   X-Product      部署类型，SaaS 两站共用
 *   X-Product-Code 区分产品（codebuddy / workbuddy）
 *   User-Agent     客户端形态，缺了会以宿主默认 UA 发出去
 * 企业账号另需 X-Enterprise-Id / X-Tenant-Id，个人账号带 X-User-Id —— 见 buddyHeaders。
 */
var BUDDY_IDENTITY = {
  codebuddy: {
    domain: 'www.codebuddy.ai',
    productCode: 'codebuddy',
    userAgent: 'CodeBuddyIDE/1.106.1',
  },
  'codebuddy-cn': {
    domain: 'www.codebuddy.cn',
    productCode: 'codebuddy',
    userAgent: 'CodeBuddyIDE/1.106.1',
  },
  // WorkBuddy 走腾讯国内网关，UA 用国内客户端形态（没有 WorkBuddy AI 段）
  workbuddy: {
    domain: 'copilot.tencent.com',
    productCode: 'workbuddy',
    userAgent: 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2',
  },
}

/** 取来源的 CodeBuddy 身份配置；非 CodeBuddy 系返回 null */
function buddyIdentity(source) {
  return (source && BUDDY_IDENTITY[source.id]) || null
}

/** 部署类型：CodeBuddy 与 WorkBuddy 共用（随产品变化的只有 X-Product-Code） */
var BUDDY_DEPLOYMENT_TYPE = 'SaaS'
/** 续期请求的来源标识，与 IDE 一致 */
var BUDDY_REFRESH_SOURCE = 'ide-main'
/** token 尚未就绪：登录轮询里继续等（与 IDE 的 11217 对齐） */
var CODE_TOKEN_NOT_READY = 11217

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

/** 旧版本把 token 前 6 位当名字存下来，这里一次性纠正 */
var LEGACY_TOKEN_NAME = /^账号\s+[A-Za-z0-9_-]{4,10}$/

function loadAccounts() {
  var list = readJSON(KEY_ACCOUNTS, [])
  var next = Object.prototype.toString.call(list) === '[object Array]' ? list : []
  var changed = false
  for (var i = 0; i < next.length; i++) {
    var account = next[i]
    if (!account || !LEGACY_TOKEN_NAME.test(String(account.name || ''))) {
      continue
    }
    var fixed = claimsLabel(account.token)
    if (!fixed) {
      var source = sourceOf(account.source)
      fixed = (source ? source.label : '账号') + ' ' + String(i + 1)
    }
    account.name = fixed
    changed = true
  }
  if (changed) {
    saveAccounts(next)
  }
  return next
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

/** goja 环境没有 atob，这里手写一份 base64 解码 */
var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64Decode(input) {
  var text = String(input || '').replace(/[^A-Za-z0-9+/]/g, '')
  if (!text) {
    return ''
  }
  var out = ''
  var buffer = 0
  var bits = 0
  for (var i = 0; i < text.length; i++) {
    var idx = B64_CHARS.indexOf(text.charAt(i))
    if (idx < 0) {
      continue
    }
    buffer = (buffer << 6) | idx
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((buffer >> bits) & 0xFF)
    }
  }
  return out
}

/** 解出 JWT 的 payload（不校验签名，纯本地解析） */
function jwtClaims(token) {
  var parts = String(token || '').split('.')
  if (parts.length < 2) {
    return null
  }
  var payload = ''
  try {
    payload = base64Decode(parts[1])
  }
  catch (e) {
    return null
  }
  if (!payload) {
    return null
  }
  try {
    var claims = JSON.parse(payload)
    return (claims && typeof claims === 'object') ? claims : null
  }
  catch (e) {
    return null
  }
}

/** 从 JWT payload 读可读标识（不联网、不校验签名，纯展示用途） */
function claimsLabel(token) {
  var claims = jwtClaims(token)
  if (!claims) {
    return ''
  }
  var candidates = [
    claims.email,
    claims.preferred_username,
    claims.nickname,
    claims.name,
    claims.user_name,
  ]
  for (var i = 0; i < candidates.length; i++) {
    var mail = trim(candidates[i])
    if (mail && mail.indexOf('@') >= 0) {
      return mail
    }
  }
  for (var j = 0; j < candidates.length; j++) {
    var text = trim(candidates[j])
    if (text && text.length <= 32) {
      return text
    }
  }
  return ''
}

/** 从 JWT 里取用户 id：IDEA 会话的 token / accessToken 需要它做前缀 */
function claimsUid(token) {
  var claims = jwtClaims(token)
  if (!claims) {
    return ''
  }
  var candidates = [claims.uid, claims.userId, claims.user_id, claims.sub, claims.id]
  for (var i = 0; i < candidates.length; i++) {
    var value = trim(candidates[i])
    if (value) {
      return value
    }
  }
  return ''
}

/**
 * 账号卡片上的显示名。
 * 顺序：邮箱 → 名称 → 昵称 → token 里的 JWT 声明。
 * 都取不到时返回空串，由调用方用「来源 + 序号」兜底。
 * 任何情况下都不回显 token 内容。
 */
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
  return claimsLabel(token)
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

/**
 * CodeBuddy 系的控制面请求头（余量 / 签到 / 续期 / 登录账号信息）。
 *
 * 与 authHeaders 的区别：这一族接口按「IDE 客户端」的身份校验，除 Bearer 外
 * 还要 X-Domain / X-Product / X-Product-Code / UA；企业账号缺
 * X-Enterprise-Id + X-Tenant-Id 会查不到计费数据，个人账号则带 X-User-Id。
 * 非 CodeBuddy 来源退回 authHeaders，行为不变。
 *
 * options.noUserId / noEnterpriseId：登录流程里的请求要显式声明「不带」这两个
 * 身份头（对应 IDE 的 X-No-User-Id / X-No-Enterprise-Id: true），由服务端
 * 按「不带用户上下文」处理。
 */
function buddyHeaders(source, token, account, options) {
  var identity = buddyIdentity(source)
  if (!identity) {
    return authHeaders(token)
  }
  var opts = options || {}
  var meta = objectOf(account && account.meta)
  var headers = {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'X-Domain': identity.domain,
    'X-Product': BUDDY_DEPLOYMENT_TYPE,
    'X-Product-Code': identity.productCode,
    'User-Agent': identity.userAgent,
  }
  if (opts.noUserId) {
    headers['X-No-User-Id'] = 'true'
  }
  else {
    var userId = trim(meta.userId) || claimsUid(token)
    if (userId) {
      headers['X-User-Id'] = userId
    }
  }
  if (opts.noEnterpriseId) {
    headers['X-No-Enterprise-Id'] = 'true'
  }
  else {
    var enterpriseId = trim(meta.enterpriseId)
    if (enterpriseId) {
      headers['X-Enterprise-Id'] = enterpriseId
      headers['X-Tenant-Id'] = enterpriseId
    }
  }
  return headers
}

/** 匿名请求头（登录用）：在 ANON_HEADERS 基础上补 CodeBuddy 的站点与 UA 标识 */
function anonHeadersOf(source) {
  var identity = buddyIdentity(source)
  var headers = {}
  for (var key in ANON_HEADERS) {
    headers[key] = ANON_HEADERS[key]
  }
  if (identity) {
    headers['X-Domain'] = identity.domain
    headers['User-Agent'] = identity.userAgent
  }
  return headers
}

/**
 * 401/403 统一成带标记的错误。
 *
 * 标记的用途只有一个：让 runQuota / runCheckin 认出「这条凭据还能用
 * refresh_token 续期」，续期成功后原样重试一次；其余错误立即上报。
 */
function authExpiredError() {
  var error = new Error('登录态已失效，请重新导入账号')
  error.authExpired = true
  return error
}

/** 错误是否属于「凭据过期」这一类（可尝试续期） */
function isAuthExpired(error) {
  return Boolean(error && error.authExpired)
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
function requestOK(method, url, token, body, what, headers) {
  var resp = requestJSON(method, url, token, body, headers)
  if (resp.status === 401 || resp.status === 403) {
    throw authExpiredError()
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw describeHTTPError(what, resp)
  }
  return resp
}

/** headers 省略时用通用鉴权头；CodeBuddy 系传入 buddyHeaders 覆盖 */
function requestJSON(method, url, token, body, headers) {
  var payload = {
    method: method,
    url: url,
    headers: headers || authHeaders(token),
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

function queryQuota(source, account) {
  var token = trim(account && account.token)

  // 这几家的用量都不在 CodeBuddy 系的接口上
  if (source.id === 'github-copilot') {
    return queryCopilotQuota(token)
  }
  if (source.id === 'cursor') {
    return queryCursorQuota(token)
  }
  if (source.id === 'qoder') {
    return queryQoderQuota(account)
  }
  if (source.id === 'windsurf') {
    return queryWindsurfQuota(token)
  }
  if (source.id === 'kiro') {
    return queryKiroQuota(account)
  }
  if (source.id === 'antigravity') {
    return queryAntigravityQuota(account)
  }
  if (source.id === 'gemini') {
    return queryGeminiQuota(account)
  }
  if (source.id === 'minimax') {
    return queryMinimaxQuota(account)
  }
  if (source.id === 'cline') {
    return queryClineQuota(account)
  }
  if (source.id === 'accio') {
    return queryAccioQuota(account)
  }
  if (source.id === 'lobsterai') {
    return queryLobsteraiQuota(account)
  }
  if (source.id === 'raccoon') {
    return queryRaccoonQuota(account)
  }
  if (source.id === 'loomy') {
    return queryLoomyQuota(account)
  }
  if (source.id === 'trae' || source.id === 'trae-cn') {
    return queryTraeQuota(account, source)
  }

  // CodeBuddy 系：续期过的话用 meta 里的新 token（account.token 保留原身份）
  var requestToken = buddyAccessTokenOf(account) || token
  var resp = requestOK('POST', source.api + '/v2/billing/meter/get-user-resource', requestToken, {
    PageNumber: 1,
    PageSize: 200,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    OnlyValidPeriod: true,
    PackageCodes: PACKAGE_CODES,
    NeedInUsage: true,
  }, '余量查询', buddyHeaders(source, requestToken, account))

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
    // 失效包不计入余量：请求体里 Status 明确要了 0 和 3，其中 3 就是已过期；
    // 它们的 CycleCapacityRemain 可能仍非 0，算进去会让数字虚高（实测差 500）。
    if (!buddyPackageActive(pack)) {
      continue
    }
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

/**
 * 资源包是否仍然可用。
 *
 * 三条判据都来自实测的 get-user-resource 响应（对齐官方 IDE 与参考实现）：
 *   Status = 3         服务端标记的「已过期」
 *   ExpiredTime 已过   包自身的失效时间（有效包里它通常是空串）
 *   DeductionEndTime   扣费截止时间（毫秒），过了就再也扣不到
 * 未知取值一律当成有效 —— 宁可多显示一个额度，也不要把能用的额度藏起来。
 */
function buddyPackageActive(pack) {
  if (numberOr(pack.Status, 0) === 3) {
    return false
  }
  var expiredTime = trim(pack.ExpiredTime)
  if (expiredTime) {
    var expiredAt = Date.parse(expiredTime.replace(' ', 'T'))
    if (!isNaN(expiredAt) && Date.now() >= expiredAt) {
      return false
    }
  }
  var deductionEndTime = numberOr(pack.DeductionEndTime, 0)
  return !(deductionEndTime > 0 && Date.now() >= deductionEndTime)
}

/**
 * GitHub Copilot 用量。
 *
 * `copilot_internal/user` 直接返回套餐与配额快照：
 * quota_snapshots.premium_interactions 里的 entitlement / remaining 就是总量与剩余。
 * 鉴权用 GitHub 的 access token，不是 copilot token。
 */
function queryCopilotQuota(token) {
  var resp = toolbox.http.request({
    method: 'GET',
    url: 'https://api.github.com/copilot_internal/user',
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/json',
      'X-GitHub-Api-Version': '2025-04-01',
      'User-Agent': 'toolbox-agent-accounts',
    },
  })
  var body = objectOf(readBody(resp, 'Copilot 用量'))
  var snapshots = objectOf(body.quota_snapshots)
  var premium = objectOf(snapshots.premium_interactions)
  var total = numberOr(premium.entitlement, 0)
  var remain = numberOr(premium.remaining, 0)

  return {
    remain: Math.round(remain * 100) / 100,
    total: Math.round(total * 100) / 100,
    cycleEnd: trim(body.quota_reset_date),
    packages: total > 0 ? 1 : 0,
    updatedAt: nowISO(),
  }
}

/** 从 Cursor 的 accessToken（JWT）里取 WorkOS 用户 ID */
function workosUserIdOf(token) {
  var claims = jwtClaims(token)
  if (!claims) {
    return ''
  }
  var candidates = [claims.sub, claims.userId, claims.user_id, claims.id]
  for (var i = 0; i < candidates.length; i++) {
    var value = trim(candidates[i])
    if (value) {
      return value
    }
  }
  return ''
}

/**
 * Cursor 用量。
 *
 * 鉴权靠会话 cookie：`WorkosCursorSessionToken=<userId>%3A%3A<token>`，
 * userId 从 JWT 的 sub 取（`%3A%3A` 是 `::` 的 URL 编码）。
 *
 * 各家套餐返回的字段不统一，这里按「总量 / 已用」两个语义做多字段兜底，
 * 一个都没命中就明确报错，不猜一个数字糊弄过去。
 */
function queryCursorQuota(token) {
  var userId = workosUserIdOf(token)
  if (!userId) {
    throw new Error('无法从 Token 解析用户 ID，请重新导入该账号')
  }

  var resp = toolbox.http.request({
    method: 'GET',
    url: 'https://cursor.com/api/usage-summary',
    headers: {
      'Cookie': 'WorkosCursorSessionToken=' + userId + '%3A%3A' + token,
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
  })
  var body = objectOf(readBody(resp, 'Cursor 用量'))

  // 常见形态：limit / usage 对象里带 total 与 used
  var bucket = objectOf(body.limit || body.usage || body.quota || {})
  var total = numberOr(bucket.total, numberOr(body.limitTotal, numberOr(body.total, 0)))
  var used = numberOr(bucket.used, numberOr(body.limitUsed, numberOr(body.used, 0)))
  if (total <= 0 && used <= 0) {
    throw new Error('Cursor 未返回可识别的配额字段，可能是套餐不支持查询')
  }

  return {
    remain: Math.round(Math.max(0, total - used) * 100) / 100,
    total: Math.round(total * 100) / 100,
    cycleEnd: trim(body.billingCycleEnd || body.resetDate),
    packages: 1,
    updatedAt: nowISO(),
  }
}

/**
 * 在对象里按字段名递归找数值。
 * 各客户端的用量快照层级不固定，逐层搜比写死路径更耐版本变化。
 */
function numberByKeysDeep(value, keys, depth) {
  var level = depth || 0
  if (!value || typeof value !== 'object' || level > 4) {
    return null
  }
  var k
  for (k in value) {
    if (keys.indexOf(String(k).toLowerCase()) < 0) {
      continue
    }
    var direct = Number(value[k])
    if (isFinite(direct)) {
      return direct
    }
  }
  for (k in value) {
    var found = numberByKeysDeep(value[k], keys, level + 1)
    if (found !== null) {
      return found
    }
  }
  return null
}

/**
 * Qoder 用量。
 *
 * 优先读客户端写的用量快照（secret://aicoding.auth.creditUsage）；
 * 只有网页登录、本机没装客户端时，才退回远程 `/api/v2/quota/usage`。
 */
function queryQoderQuota(account) {
  var raw = ''
  try {
    if (toolbox.agentAuth && typeof toolbox.agentAuth.readSecret === 'function') {
      raw = toolbox.agentAuth.readSecret('qoder', 'secret://aicoding.auth.creditUsage')
    }
  }
  catch (e) {
    toolbox.log('[qoder] 本地用量快照不可用：' + (e && e.message ? e.message : String(e)))
  }

  if (trim(raw)) {
    var body = null
    try {
      body = JSON.parse(raw)
    }
    catch (e) {
      throw new Error('Qoder 用量数据不是合法 JSON')
    }
    if (!body || typeof body !== 'object') {
      throw new Error('Qoder 用量数据为空')
    }
    return qoderQuotaOf(body, '')
  }

  var token = trim(account && account.token)
  if (!token) {
    throw new Error('Qoder 既没有本地用量快照，也没有可用于查询的登录凭据')
  }
  var remote = requestJSONOK('GET', 'https://openapi.qoder.sh/api/v2/quota/usage', {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/json',
  }, null, 'Qoder 余量查询')
  return qoderQuotaOf(remote, trim(remote.resetTime || remote.reset_time))
}

/** 把 Qoder 的用量对象翻成统一口径 */
function qoderQuotaOf(body, cycleEnd) {
  var total = numberByKeysDeep(body, ['total', 'quota', 'limit', 'credits_total', 'credittotal'])
  var remain = numberByKeysDeep(body, ['remaining', 'remain', 'left', 'credits_remaining'])
  var used = numberByKeysDeep(body, ['used', 'usage', 'consumed', 'credits_used'])
  if (remain === null && total !== null && used !== null) {
    remain = Math.max(0, total - used)
  }
  if (total === null && remain === null && used === null) {
    throw new Error('Qoder 用量里没有可识别的数值字段')
  }

  var safeTotal = total === null ? (remain !== null && used !== null ? remain + used : 0) : total
  var safeRemain = remain === null ? Math.max(0, safeTotal - (used || 0)) : remain

  return {
    remain: Math.round(safeRemain * 100) / 100,
    total: Math.round(safeTotal * 100) / 100,
    cycleEnd: trim(cycleEnd),
    packages: safeTotal > 0 ? 1 : 0,
    updatedAt: nowISO(),
  }
}

// ------------------------------------------------------------ Windsurf

/**
 * Windsurf 没有独立的配额端点，配额是账号刷新链路的附带产物。
 *
 * 链路（对照 cockpit-tools 的 refresh_account_token_once）：
 *   Firebase idToken → RegisterUser（register.windsurf.com）换 apiKey + apiServerUrl
 *   → GetUserStatus(apiKey) 拿 userStatus.planStatus
 *   → 有 authToken 时再补一次 GetPlanStatus（字段更全）
 * 快照里带额度字段才算拿到配额，一份都没有就报错，不猜数字。
 */
var WINDSURF_REGISTER_URL = 'https://register.windsurf.com'
var WINDSURF_DEFAULT_API_SERVER = 'https://server.codeium.com'
var WINDSURF_SEATS_PATH = '/exa.seat_management_pb.SeatManagementService/'
/** 客户端把 apiServerUrl 存在 secret storage 里，self-serve 账号与默认值不同 */
var WINDSURF_API_SERVER_KEY =
  'secret://{"extensionId":"codeium.windsurf","key":"windsurf_auth.apiServerUrl"}'

/** 读客户端记录的服务端地址；没装客户端或没登录时回落官方默认值 */
function windsurfApiServerUrl() {
  var fallback = WINDSURF_DEFAULT_API_SERVER
  if (!toolbox.agentAuth || typeof toolbox.agentAuth.readSecret !== 'function') {
    return fallback
  }
  var text = ''
  try {
    text = trim(toolbox.agentAuth.readSecret('windsurf', WINDSURF_API_SERVER_KEY))
  }
  catch (e) {
    // 没登录过就是读不到，用默认地址继续
    return fallback
  }
  if (!text) {
    return fallback
  }
  // 有的版本存成 JSON 字符串（带引号）
  if (text.charAt(0) === '"') {
    try {
      text = trim(JSON.parse(text))
    }
    catch (e) {
      return fallback
    }
  }
  if (!/^https?:\/\//.test(text)) {
    return fallback
  }
  return text.replace(/\/+$/, '')
}

/** 在对象里按多个候选键取字符串 */
function pickText(obj, keys) {
  var source = objectOf(obj)
  for (var i = 0; i < keys.length; i++) {
    var value = source[keys[i]]
    if (typeof value === 'string' && trim(value)) {
      return trim(value)
    }
    if (typeof value === 'number' && isFinite(value)) {
      return String(value)
    }
  }
  return ''
}

/** 按候选键取数值；取不到返回 null（0 是合法额度，不能当缺失） */
function pickNumber(obj, keys) {
  var source = objectOf(obj)
  for (var i = 0; i < keys.length; i++) {
    var value = source[keys[i]]
    if (value === null || value === undefined || value === '') {
      continue
    }
    var num = Number(value)
    if (isFinite(num)) {
      return num
    }
  }
  return null
}

/** proto Timestamp 可能是秒数、字符串秒数或 { seconds } */
function protoSecondsOf(value) {
  if (value === null || value === undefined || value === '') {
    return 0
  }
  if (typeof value === 'object') {
    return protoSecondsOf(value.seconds)
  }
  var num = Number(value)
  return isFinite(num) && num > 0 ? num : 0
}

/** 调一次 seat management 接口；非 2xx 一律抛出带原因的异常 */
function windsurfSeat(baseUrl, method, body, what) {
  var base = trim(baseUrl).replace(/\/+$/, '')
  var resp = toolbox.http.request({
    method: 'POST',
    url: base + WINDSURF_SEATS_PATH + method,
    headers: {
      'User-Agent': 'toolbox-agent-accounts',
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  })
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('Windsurf 登录态已失效，请重新登录或重新导入账号')
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw describeHTTPError('Windsurf ' + method, resp)
  }
  var payload = parseBody(resp)
  if (!payload || typeof payload !== 'object') {
    throw new Error('Windsurf ' + method + ' 返回的不是 JSON')
  }
  return payload
}

/** Firebase idToken 换 apiKey：客户端每次启动都走这步，key 已存在就返回原有的 */
function windsurfRegister(firebaseToken) {
  var payload = windsurfSeat(WINDSURF_REGISTER_URL, 'RegisterUser', {
    firebase_id_token: firebaseToken,
  }, '账号注册')
  var apiKey = pickText(payload, ['apiKey', 'api_key'])
  if (!apiKey) {
    throw new Error('Windsurf 没有返回 apiKey，请重新登录后再试')
  }
  return {
    apiKey: apiKey,
    apiServerUrl: pickText(payload, ['apiServerUrl', 'api_server_url']) || windsurfApiServerUrl(),
  }
}

/** 一次性 authToken：只用于 GetPlanStatus，换不到不影响 apiKey 主链路 */
function windsurfOneTimeToken(apiServerUrl, firebaseToken) {
  var payload = windsurfSeat(apiServerUrl, 'GetOneTimeAuthToken', {
    firebaseIdToken: firebaseToken,
  }, '凭据换取')
  return pickText(payload, ['authToken', 'auth_token'])
}

/** 用 apiKey 拉用户状态：userStatus.planStatus 里带额度快照 */
function windsurfUserStatus(apiServerUrl, apiKey) {
  var stamp = String(new Date().getTime())
  return windsurfSeat(apiServerUrl, 'GetUserStatus', {
    metadata: {
      apiKey: apiKey,
      ideName: 'Windsurf',
      // 服务端会校验这几个字段，按官方扩展的写法给值
      ideVersion: '1.0.0',
      extensionName: 'codeium.windsurf',
      extensionVersion: '1.0.0',
      locale: 'zh-CN',
      os: 'windows',
      disableTelemetry: false,
      sessionId: 'toolbox-' + stamp,
      requestId: stamp,
    },
  }, '用户状态查询')
}

/** 用 authToken 拉套餐详情：字段比 userStatus 里的快照全 */
function windsurfPlanStatus(apiServerUrl, authToken) {
  return windsurfSeat(apiServerUrl, 'GetPlanStatus', {
    authToken: authToken,
    includeTopUpStatus: true,
  }, '套餐状态查询')
}

/**
 * planStatus → 插件统一的 { remain, total }。
 *
 * prompt 是补全额度、flow 是对话额度，两块相加才是整个套餐；
 * 扁平快照里的 completions / chat 直接就是剩余量，一并认。
 */
function windsurfQuotaOf(planStatus) {
  var plan = objectOf(planStatus)
  var remainPrompt = pickNumber(plan, ['availablePromptCredits', 'available_prompt_credits', 'completions'])
  var usedPrompt = pickNumber(plan, ['usedPromptCredits', 'used_prompt_credits'])
  var remainFlow = pickNumber(plan, ['availableFlowCredits', 'available_flow_credits', 'chat'])
  var usedFlow = pickNumber(plan, ['usedFlowCredits', 'used_flow_credits'])
  if (remainPrompt === null && usedPrompt === null && remainFlow === null && usedFlow === null) {
    return null
  }

  var remain = (remainPrompt || 0) + (remainFlow || 0)
  var total = (remainPrompt || 0) + (usedPrompt || 0) + (remainFlow || 0) + (usedFlow || 0)
  var resetAt = protoSecondsOf(plan.planEnd)
  if (resetAt <= 0) {
    resetAt = protoSecondsOf(plan.plan_end)
  }

  return {
    remain: Math.round(remain * 100) / 100,
    total: Math.round(total * 100) / 100,
    cycleEnd: resetAt > 0 ? new Date(resetAt * 1000).toISOString() : '',
    packages: total > 0 ? 1 : 0,
  }
}

/**
 * Windsurf 配额。
 *
 * 凭据有两种：客户端存的是 apiKey（sk-ws-… / cog_…），网页登录拿到的是
 * Firebase idToken（eyJ…）。后者必须先换 apiKey，两步都是刷新链路的固定环节。
 */
function queryWindsurfQuota(token) {
  var secret = trim(token)
  if (!secret) {
    throw new Error('缺少 Windsurf 凭据，请重新登录或重新导入账号')
  }

  var apiServerUrl = windsurfApiServerUrl()
  var apiKey = ''
  var oneTimeToken = ''

  if (secret.indexOf('eyJ') === 0) {
    var register = windsurfRegister(secret)
    apiKey = register.apiKey
    apiServerUrl = register.apiServerUrl
    try {
      oneTimeToken = windsurfOneTimeToken(apiServerUrl, secret)
    }
    catch (e) {
      toolbox.log('[windsurf] 换取 authToken 失败：' + (e && e.message ? e.message : String(e)))
    }
  }
  else if (secret.indexOf('sk-ws-') === 0 || secret.indexOf('cog_') === 0) {
    apiKey = secret
  }
  else {
    throw new Error('无法识别的 Windsurf 凭据，请重新登录或粘贴 API Key')
  }

  var statusPayload = windsurfUserStatus(apiServerUrl, apiKey)
  var userStatus = objectOf(statusPayload.userStatus)

  // 优先套餐详情，其次顶层的 planStatus，最后 userStatus 里的快照；
  // 三份字段名一致，取第一份能读出额度的
  var quota = null
  if (oneTimeToken) {
    try {
      quota = windsurfQuotaOf(objectOf(windsurfPlanStatus(apiServerUrl, oneTimeToken)).planStatus)
    }
    catch (e) {
      toolbox.log('[windsurf] 套餐详情查询失败：' + (e && e.message ? e.message : String(e)))
    }
  }
  if (!quota) {
    quota = windsurfQuotaOf(objectOf(statusPayload.planStatus))
  }
  if (!quota) {
    quota = windsurfQuotaOf(objectOf(userStatus.planStatus))
  }
  if (!quota) {
    throw new Error('Windsurf 没有返回可识别的配额快照，可能是套餐不支持查询')
  }

  quota.updatedAt = nowISO()
  return quota
}

// ------------------------------------------------------------ 通用请求

/** 发一次请求并按 JSON 解析；401/403 统一归为登录态失效 */
function requestJSONOK(method, url, headers, body, what) {
  var payload = { method: method, url: url, headers: headers || {} }
  if (body !== undefined && body !== null) {
    payload.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  var resp = toolbox.http.request(payload)
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(what + '失败：登录态已失效，请重新登录或重新导入账号')
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw describeHTTPError(what, resp)
  }
  var parsed = parseBody(resp)
  if (parsed === null) {
    throw new Error(what + '失败，请稍后重试')
  }
  return parsed
}

/** 在对象（可含数组）里按字段名递归找字符串 */
function deepPickText(value, keys, depth) {
  var level = depth || 0
  if (!value || typeof value !== 'object' || level > 4) {
    return ''
  }
  var k
  for (k in value) {
    if (keys.indexOf(String(k).toLowerCase()) < 0) {
      continue
    }
    var direct = value[k]
    if (typeof direct === 'string' && trim(direct)) {
      return trim(direct)
    }
  }
  for (k in value) {
    var found = deepPickText(value[k], keys, level + 1)
    if (found) {
      return found
    }
  }
  return ''
}

/** 对象里是否有任何自有键 */
function hasKeys(value) {
  if (!value || typeof value !== 'object') {
    return false
  }
  for (var k in value) {
    return true
  }
  return false
}

/** proto / 秒 / 毫秒时间戳统一成秒 */
function normalizeSeconds(value) {
  var num = Number(value)
  if (!isFinite(num) || num <= 0) {
    return 0
  }
  return num > 10000000000 ? Math.floor(num / 1000) : Math.floor(num)
}

// ------------------------------------------------------------ Kiro

var KIRO_DEFAULT_REGION = 'us-east-1'
/** runtime endpoint 按 profileArn 里的 region 选；未列出的区域回落到 us-east-1 */
var KIRO_RUNTIME_ENDPOINTS = {
  'us-east-1': 'https://q.us-east-1.amazonaws.com',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com',
  'us-gov-east-1': 'https://q-fips.us-gov-east-1.amazonaws.com',
  'us-gov-west-1': 'https://q-fips.us-gov-west-1.amazonaws.com',
}
/** Kiro 把登录态（含 profileArn）明文存在这个 ItemTable 键里 */
var KIRO_AUTH_KEY = 'kiro.kiroAgent'

function kiroRuntimeEndpoint(region) {
  return KIRO_RUNTIME_ENDPOINTS[region] || KIRO_RUNTIME_ENDPOINTS[KIRO_DEFAULT_REGION]
}

/** arn:<partition>:<service>:<region>:<account>:<resource> */
function kiroRegionOf(profileArn) {
  var parts = String(profileArn || '').split(':')
  if (parts.length < 5 || parts[0] !== 'arn') {
    return ''
  }
  var region = trim(parts[3])
  return region ? region : ''
}

/** 登录态 JSON 里找第一个 arn: 开头的字符串 */
function findArn(node, depth) {
  var level = depth || 0
  if (node === null || node === undefined || level > 5) {
    return ''
  }
  if (typeof node === 'string') {
    return node.indexOf('arn:') === 0 ? trim(node) : ''
  }
  if (typeof node !== 'object') {
    return ''
  }
  var keys = ['profileArn', 'profile_arn', 'arn']
  for (var i = 0; i < keys.length; i++) {
    var direct = findArn(node[keys[i]], level + 1)
    if (direct) {
      return direct
    }
  }
  for (var k in node) {
    var nested = findArn(node[k], level + 1)
    if (nested) {
      return nested
    }
  }
  return ''
}

/** profileArn 优先用登录时拿到的，其次回落到本地客户端登录态 */
function kiroProfileArn(account) {
  var meta = objectOf(account && account.meta)
  var stored = trim(meta.profileArn)
  if (stored) {
    return stored
  }
  var raw = ''
  try {
    if (toolbox.agentAuth && typeof toolbox.agentAuth.readSecret === 'function') {
      raw = toolbox.agentAuth.readSecret('kiro', KIRO_AUTH_KEY)
    }
  }
  catch (e) {
    return ''
  }
  if (!trim(raw)) {
    return ''
  }
  var parsed = null
  try {
    parsed = JSON.parse(raw)
  }
  catch (e) {
    return ''
  }
  return findArn(parsed, 0)
}

/** 用量明细：优先 type=credit 的那一条 */
function kiroBreakdown(root) {
  var list = root.usageBreakdownList || root.usageBreakdowns
  if (Object.prototype.toString.call(list) !== '[object Array]' || list.length === 0) {
    return {}
  }
  for (var i = 0; i < list.length; i++) {
    var item = objectOf(list[i])
    if (String(item.type || '').toLowerCase() === 'credit') {
      return item
    }
  }
  return objectOf(list[0])
}

/**
 * Kiro 用量。
 *
 * 直接打 AWS runtime 的 getUsageLimits，只带 Bearer token（参考实现没有 SigV4）；
 * region 从 profileArn 解，profileArn 缺失时接口多半也能回默认档位，先试再说。
 */
function queryKiroQuota(account) {
  var token = trim(account && account.token)
  if (!token) {
    throw new Error('缺少 Kiro 登录凭据，请重新登录或重新导入账号')
  }

  var profileArn = kiroProfileArn(account)
  var region = kiroRegionOf(profileArn) || KIRO_DEFAULT_REGION
  var url = kiroRuntimeEndpoint(region) +
    '/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true'
  if (profileArn) {
    url += '&profileArn=' + encodeURIComponent(profileArn)
  }

  var body = requestJSONOK('GET', url, {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/json',
  }, null, 'Kiro 用量查询')

  // 不同版本把用量塞在不同层：kiro.resourceNotifications.usageState / usageState / 根
  var rootCandidates = [
    body.kiro && body.kiro.resourceNotifications && body.kiro.resourceNotifications.usageState,
    body.usageState,
    body,
  ]
  var root = {}
  for (var r = 0; r < rootCandidates.length; r++) {
    var candidate = objectOf(rootCandidates[r])
    if (hasKeys(candidate)) {
      root = candidate
      break
    }
  }

  var breakdown = kiroBreakdown(root)
  var estimated = objectOf(root.estimatedUsage)

  var total = pickNumber(estimated, ['total', 'creditsTotal'])
  if (total === null) {
    total = numberByKeysDeep(breakdown, ['usagelimitwithprecision', 'usagelimit', 'limit', 'total', 'totalcredits'], 0)
  }
  var used = pickNumber(estimated, ['used', 'creditsUsed'])
  if (used === null) {
    used = numberByKeysDeep(breakdown, ['currentusagewithprecision', 'currentusage', 'used', 'usedcredits'], 0)
  }
  if (total === null && used === null) {
    throw new Error('Kiro 没有返回可识别的配额字段，可能是套餐不支持查询')
  }

  // 试用/赠送额度单独一档，和正式额度加在一起才是总量
  var bonus = objectOf(breakdown.freeTrialInfo || breakdown.freeTrialUsage)
  var bonusTotal = numberByKeysDeep(bonus, ['usagelimitwithprecision', 'usagelimit', 'limit', 'total'], 0) || 0
  var bonusUsed = numberByKeysDeep(bonus, ['currentusagewithprecision', 'currentusage', 'used'], 0) || 0

  var resetRaw = pickNumber(root, ['nextDateReset', 'resetAt', 'resetTime'])
  if (resetRaw === null) {
    resetRaw = pickNumber(breakdown, ['resetDate', 'resetAt'])
  }
  var resetAt = normalizeSeconds(resetRaw || 0)

  var safeTotal = (total || 0) + bonusTotal
  var safeRemain = Math.max(0, (total || 0) - (used || 0)) + Math.max(0, bonusTotal - bonusUsed)

  return {
    remain: Math.round(safeRemain * 100) / 100,
    total: Math.round(safeTotal * 100) / 100,
    cycleEnd: resetAt > 0 ? new Date(resetAt * 1000).toISOString() : '',
    packages: breakdown && hasKeys(breakdown) ? 1 : 0,
    updatedAt: nowISO(),
  }
}

// ------------------------------------------------------------ Antigravity

var ANTIGRAVITY_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com'
var ANTIGRAVITY_USER_AGENT = 'antigravity/1.20.5 windows/amd64'

function antigravityHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'User-Agent': ANTIGRAVITY_USER_AGENT,
    'x-goog-api-client': 'google-nodejs/10.3.0',
    'Accept': '*/*',
  }
}

function antigravityMetadata() {
  return {
    ideName: 'antigravity',
    ideType: 'ANTIGRAVITY',
    ideVersion: '1.20.5',
    pluginVersion: '1.20.5',
    platform: 'PLATFORM_UNSPECIFIED',
    updateChannel: 'stable',
  }
}

/** loadCodeAssist 里带项目 id，配额接口按项目统计 */
function antigravityProjectId(token) {
  try {
    var body = requestJSONOK('POST', ANTIGRAVITY_BASE_URL + '/v1internal:loadCodeAssist',
      antigravityHeaders(token),
      { metadata: antigravityMetadata(), mode: 'FULL_ELIGIBILITY_CHECK' },
      'Antigravity 项目查询')
    return trim(body.cloudaicompanionProject)
  }
  catch (e) {
    toolbox.log('[antigravity] 取项目 id 失败：' + (e && e.message ? e.message : String(e)))
    return ''
  }
}

/**
 * Antigravity 用量。
 *
 * 配额是「按桶的剩余比例」，没有绝对值；这里取所有桶里最紧张的那个，
 * 用 100 做总量、剩余百分比做剩余量，界面上按百分数展示。
 */
function queryAntigravityQuota(account) {
  var token = trim(account && account.token)
  if (!token) {
    throw new Error('缺少 Antigravity 登录凭据，请重新登录或重新导入账号')
  }
  var meta = objectOf(account.meta)
  var projectId = trim(meta.projectId) || antigravityProjectId(token)

  var body = requestJSONOK('POST', ANTIGRAVITY_BASE_URL + '/v1internal:retrieveUserQuotaSummary',
    antigravityHeaders(token),
    projectId ? { project: projectId } : {},
    'Antigravity 余量查询')

  var buckets = []
  var groups = body.groups
  if (Object.prototype.toString.call(groups) === '[object Array]') {
    for (var g = 0; g < groups.length; g++) {
      var list = objectOf(groups[g]).buckets
      if (Object.prototype.toString.call(list) !== '[object Array]') {
        continue
      }
      for (var b = 0; b < list.length; b++) {
        buckets.push(objectOf(list[b]))
      }
    }
  }
  if (buckets.length === 0) {
    throw new Error('Antigravity 没有返回可识别的配额桶，可能是账号不支持查询')
  }

  var lowest = null
  var resetTime = ''
  for (var i = 0; i < buckets.length; i++) {
    var fraction = Number(buckets[i].remainingFraction)
    if (!isFinite(fraction)) {
      continue
    }
    if (fraction < 0) {
      fraction = 0
    }
    if (fraction > 1) {
      fraction = 1
    }
    if (lowest === null || fraction < lowest) {
      lowest = fraction
    }
    var at = trim(buckets[i].resetTime)
    if (at && (!resetTime || at < resetTime)) {
      resetTime = at
    }
  }
  if (lowest === null) {
    throw new Error('Antigravity 配额桶里没有剩余比例字段')
  }

  return {
    remain: Math.round(lowest * 100),
    total: 100,
    unit: 'percent',
    cycleEnd: resetTime,
    packages: buckets.length,
    updatedAt: nowISO(),
  }
}

// ------------------------------------------------------------ Gemini（Cloud Code）

var GEMINI_BASE_URL = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
/**
 * 上游身份五头，逐字写死。
 *
 * 任何一个字符不同都可能被判定成非官方客户端；也**不要**加 x-goog-api-key /
 * x-goog-api-client —— 原版客户端不带。
 */
var GEMINI_IDENTITY_HEADERS = {
  'User-Agent': 'antigravity/4.3.0 (cmdc-pak)',
  'x-client-name': 'antigravity',
  'x-client-version': '4.3.0',
  'x-machine-id': 'cmdc-pak',
  'x-vscode-sessionid': 'proxy',
}
/** loadCodeAssist 拿不到项目号时的兜底（免费档账号的 LCA 返回空） */
var GEMINI_DEFAULT_PROJECT = 'aicode-consumers'
var GEMINI_BUCKET_FIVE_HOUR = 'gemini-5h'
var GEMINI_BUCKET_WEEKLY = 'gemini-weekly'

function geminiHeaders(token) {
  var headers = {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
  }
  for (var key in GEMINI_IDENTITY_HEADERS) {
    headers[key] = GEMINI_IDENTITY_HEADERS[key]
  }
  return headers
}

/**
 * 账号所属的 Cloud Code 项目号。
 *
 * 配额接口**必须**带 project：空对象 `{}` 对部分账号会 403
 * SUBSCRIPTION_REQUIRED（同一个 token 带上 project 就 200）。
 * 字段名是 `project`，不是 `cloudaicompanionProject`（后者直接 400）。
 */
function geminiProjectId(account) {
  var cached = trim(objectOf(account && account.meta).projectId)
  if (cached) {
    return cached
  }
  try {
    // 请求体逐字照抄上游抓包，多一个字段就可能被识别成非官方客户端
    var body = requestJSONOK('POST', GEMINI_BASE_URL + '/v1internal:loadCodeAssist',
      geminiHeaders(trim(account && account.token)),
      '{"metadata":{"ideType":"ANTIGRAVITY"}}',
      'Gemini 项目查询')
    return trim(body.cloudaicompanionProject) || GEMINI_DEFAULT_PROJECT
  }
  catch (e) {
    toolbox.log('[gemini] 取项目号失败：' + (e && e.message ? e.message : String(e)))
    return GEMINI_DEFAULT_PROJECT
  }
}

/**
 * Gemini 用量。
 *
 * 配额是「窗口剩余比例」而不是积分：接口按 bucketId 给出 5 小时窗与周窗
 * （`gemini-5h` / `gemini-weekly`），各自带 remainingFraction 与 resetTime。
 * 界面只有一个进度条，故取**最紧张**的那个窗口（与 Antigravity 同口径），
 * 并把最早的重置时刻作为 cycleEnd。
 */
function queryGeminiQuota(account) {
  var token = trim(account && account.token)
  if (!token) {
    throw new Error('缺少 Gemini 登录凭据，请重新登录或重新导入账号')
  }
  var body = requestJSONOK('POST', GEMINI_BASE_URL + '/v1internal:retrieveUserQuotaSummary',
    geminiHeaders(token),
    { project: geminiProjectId(account) },
    'Gemini 余量查询')

  var groups = body.groups
  var buckets = []
  if (Object.prototype.toString.call(groups) === '[object Array]') {
    for (var g = 0; g < groups.length; g++) {
      var list = objectOf(groups[g]).buckets
      if (Object.prototype.toString.call(list) !== '[object Array]') {
        continue
      }
      for (var b = 0; b < list.length; b++) {
        buckets.push(objectOf(list[b]))
      }
    }
  }

  var lowest = null
  var resetTime = ''
  var matched = 0
  for (var i = 0; i < buckets.length; i++) {
    var id = trim(buckets[i].bucketId)
    if (id !== GEMINI_BUCKET_FIVE_HOUR && id !== GEMINI_BUCKET_WEEKLY) {
      continue
    }
    var fraction = Number(buckets[i].remainingFraction)
    // 认不出比例或认不出重置时刻的桶一律丢弃，不编造 100%
    if (!isFinite(fraction) || !trim(buckets[i].resetTime)) {
      continue
    }
    if (fraction < 0) {
      fraction = 0
    }
    if (fraction > 1) {
      fraction = 1
    }
    matched++
    if (lowest === null || fraction < lowest) {
      lowest = fraction
    }
    var at = trim(buckets[i].resetTime)
    if (!resetTime || at < resetTime) {
      resetTime = at
    }
  }
  if (lowest === null) {
    throw new Error('Gemini 配额响应里没有可识别的配额窗口')
  }

  return {
    remain: Math.round(lowest * 100),
    total: 100,
    unit: 'percent',
    cycleEnd: resetTime,
    packages: matched,
    updatedAt: nowISO(),
  }
}

// ------------------------------------------------------------ MiniMax Code

var MINIMAX_HOST = 'https://agent.minimax.cn'
var MINIMAX_CLIENT_ID = 'mcode-public'
var MINIMAX_AUDIENCE = 'agent-backend'
var MINIMAX_SCOPE = 'agent.default'

/** x-www-form-urlencoded 请求体：设备码链路只收这个格式 */
function formBodyOf(fields) {
  var parts = []
  for (var key in fields) {
    var value = fields[key]
    if (value === undefined || value === null || value === '') {
      continue
    }
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
  }
  return parts.join('&')
}

/** 设备码 / 令牌端点的公共头 */
function minimaxFormHeaders() {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
  }
}

function minimaxHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
}

/** 宽松取金额：服务端把 "800.00" 这类数字发成字符串 */
function amountOf(value) {
  var num = Number(value)
  return isFinite(num) ? num : 0
}

/**
 * MiniMax 用量。
 *
 * 走 `/minimax-cloud/api/v1/credit/details`，响应是**平铺**的
 * （`details` / `total_count` 与 `base_resp` 同级，没有 data 包裹）。
 * 余额 = 各包 `remaining_amount` 之和；`granted_amount` 之和作为总量。
 * `details` 缺失视为「真的为 0」，`base_resp.status_code` 非 0 才是真失败。
 */
function queryMinimaxQuota(account) {
  var token = trim(account && account.token)
  if (!token) {
    throw new Error('缺少 MiniMax 登录凭据，请重新登录或重新导入账号')
  }
  var resp = requestOK('GET', MINIMAX_HOST + '/minimax-cloud/api/v1/credit/details',
    token, null, 'MiniMax 余量查询', minimaxHeaders(token))
  var payload = parseBody(resp)
  var base = objectOf(payload && payload.base_resp)
  var statusCode = base.status_code
  if (statusCode !== undefined && statusCode !== null && String(statusCode) !== '0') {
    throw new Error('余量查询失败：' + (trim(base.status_msg) || 'code=' + statusCode))
  }

  var remain = 0
  var total = 0
  var cycleEnd = ''
  var count = 0
  var details = payload && payload.details
  if (Object.prototype.toString.call(details) === '[object Array]') {
    for (var i = 0; i < details.length; i++) {
      var entry = objectOf(details[i])
      remain += amountOf(entry.remaining_amount)
      total += amountOf(entry.granted_amount)
      var expireAt = Number(entry.expire_at_ms)
      if (isFinite(expireAt) && expireAt > 0) {
        var iso = new Date(expireAt).toISOString()
        if (!cycleEnd || iso < cycleEnd) {
          cycleEnd = iso
        }
      }
      count++
    }
  }
  if (total < remain) {
    total = remain
  }

  return {
    remain: Math.round(remain * 100) / 100,
    total: Math.round(total * 100) / 100,
    cycleEnd: cycleEnd,
    packages: count,
    updatedAt: nowISO(),
  }
}

// ------------------------------------------------------------ Cline

var CLINE_API_BASE = 'https://api.cline.bot'
var CLINE_WORKOS_BASE = 'https://api.workos.com'
var CLINE_WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR'

/**
 * Cline 的访问令牌必须保留 `workos:` 前缀。
 *
 * 剥掉即 401，且服务端给的是 "make sure you're using the latest version of
 * Cline" —— 与真实原因毫不相干。这里做幂等补齐，服务端带不带前缀都能用。
 */
function clineBearerOf(token) {
  var value = trim(token)
  if (!value) {
    return ''
  }
  return value.indexOf('workos:') === 0 ? value : 'workos:' + value
}

function clineHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://cline.bot',
    'X-Title': 'Cline',
    'X-IS-MULTIROOT': 'false',
    'X-CLIENT-TYPE': 'extension',
  }
}

/** 令牌注册那一步还没有 Cline 令牌，不能带 Authorization */
function clineRegisterHeaders() {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://cline.bot',
    'X-Title': 'Cline',
    'X-IS-MULTIROOT': 'false',
  }
}

/**
 * Cline 用量。
 *
 * 走 `/api/v1/users/me/plan/usage-limits`（路径段是字面量 `me`，由网关按
 * Bearer 判定账号，不依赖凭据里的 account_id）。响应 `data.limits[]` 给的是
 * **已用百分比**（five_hour / weekly / monthly），换算成剩余百分比后取最紧张的
 * 那个窗口；`resetsAt` 是 ISO 字符串，用量为 0 的窗口可能是空串。
 */
function queryClineQuota(account) {
  var token = clineBearerOf(account && account.token)
  if (!token) {
    throw new Error('缺少 Cline 登录凭据，请重新登录或重新导入账号')
  }
  var resp = requestOK('GET', CLINE_API_BASE + '/api/v1/users/me/plan/usage-limits',
    token, null, 'Cline 余量查询', clineHeaders(token))
  var payload = objectOf(parseBody(resp))
  var serverError = trim(payload.error || payload.message)
  if (payload.success === false || (serverError && payload.success !== true)) {
    throw new Error('余量查询失败：' + (serverError || '服务端返回失败'))
  }
  var data = objectOf(payload.data)
  var limits = data.limits

  var lowest = null
  var resetTime = ''
  var count = 0
  if (Object.prototype.toString.call(limits) === '[object Array]') {
    for (var i = 0; i < limits.length; i++) {
      var entry = objectOf(limits[i])
      if (!trim(entry.type)) {
        continue
      }
      var used = Number(entry.percentUsed)
      if (!isFinite(used)) {
        used = 0
      }
      // 剩余百分比；超额（used > 100）按 0 显示，进度条不会画到外面
      var remainPct = Math.max(0, 100 - used)
      count++
      if (lowest === null || remainPct < lowest) {
        lowest = remainPct
      }
      var at = trim(entry.resetsAt)
      if (at && (!resetTime || at < resetTime)) {
        resetTime = at
      }
    }
  }
  if (lowest === null) {
    throw new Error('Cline 没有返回可识别的额度窗口')
  }

  return {
    remain: Math.round(lowest),
    total: 100,
    unit: 'percent',
    cycleEnd: resetTime,
    packages: count,
    updatedAt: nowISO(),
  }
}

// ------------------------------------------------------------ Accio（阿里）

var ACCIO_GATEWAY = 'https://phoenix-gw.alibaba.com'
var ACCIO_LOGIN_BASE = 'https://www.accio-ai.com'
var ACCIO_CLIENT_ID = 'accio-work'

/** 积分桶的键与展示名（响应里是 entitlement 下的三个对象） */
var ACCIO_CREDIT_BUCKETS = [
  { key: 'daily', label: '每日积分' },
  { key: 'monthly', label: '每月积分' },
  { key: 'recommend', label: '推荐积分' },
]

function accioHeaders() {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
}

/**
 * Accio 用量。
 *
 * `currentSubscription` 的 token 放在 **query**（放 header 会 400），
 * 余额在 `data.entitlement.{daily,monthly,recommend}.remaining`；
 * 顶层的 `data.remaining` 是服务端算好的总额，有就以它为准（用户能跟官方客户端核对）。
 * `remaining` 读不到的桶跳过 —— 那是「数据不足」，按 0 展示等于说「已用光」。
 */
function queryAccioQuota(account) {
  var token = trim(account && account.token)
  if (!token) {
    throw new Error('缺少 Accio 登录凭据，请重新登录或重新导入账号')
  }
  var resp = requestOK('GET',
    ACCIO_GATEWAY + '/api/entitlement/currentSubscription?accessToken=' + encodeURIComponent(token),
    token, null, 'Accio 余量查询', accioHeaders())
  var payload = objectOf(parseBody(resp))
  if (payload.success !== true) {
    throw new Error('余量查询失败：'
      + (trim(payload.message || payload.error) || ('code=' + String(payload.code))))
  }

  var data = objectOf(payload.data)
  var entitlement = objectOf(data.entitlement)
  var remain = 0
  var total = 0
  var count = 0
  for (var i = 0; i < ACCIO_CREDIT_BUCKETS.length; i++) {
    var bucket = objectOf(entitlement[ACCIO_CREDIT_BUCKETS[i].key])
    if (!hasKeys(bucket)) {
      continue
    }
    var remaining = Number(bucket.remaining)
    if (!isFinite(remaining)) {
      continue
    }
    remain += remaining
    total += amountOf(bucket.total)
    count++
  }
  var topRemaining = Number(data.remaining)
  if (isFinite(topRemaining)) {
    remain = topRemaining
  }
  if (count === 0 && !isFinite(topRemaining)) {
    throw new Error('Accio 配额响应里没有可识别的积分字段')
  }
  if (total < remain) {
    total = remain
  }

  return {
    remain: Math.round(remain * 100) / 100,
    total: Math.round(total * 100) / 100,
    cycleEnd: '',
    packages: count,
    updatedAt: nowISO(),
  }
}

// ------------------------------------------------------------ LobsterAI（有道）

var LOBSTERAI_API_BASE = 'https://lobsterai-server.youdao.com'
var LOBSTERAI_PORTAL_BASE = 'https://lobsterai.youdao.com'
var LOBSTERAI_VERSION_API = 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update'
/** 版本号拉不到时的兜底值（服务端不强校验，宁可用稍旧的也别让登录失败） */
var LOBSTERAI_FALLBACK_VERSION = '2026.9.4'
/** 原样照抄客户端 UA；不跟着真版本号改 */
var LOBSTERAI_USER_AGENT = 'LobsterAI/0.1.0'

function lobsteraiHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': LOBSTERAI_USER_AGENT,
  }
}

/** 解 LobsterAI 的统一信封；code 为 0/200 才算成功 */
function lobsteraiEnvelopeOf(payload) {
  var body = objectOf(payload)
  var code = body.code === undefined || body.code === null ? 0 : body.code
  return {
    ok: String(code) === '0' || String(code) === '200',
    message: trim(body.msg || body.message) || ('code=' + String(code)),
    data: objectOf(body.data),
  }
}

/**
 * 客户端版本号（日期式，如 `2026.9.4`）。
 *
 * 该响应**不是**统一信封：`code`/`msg` 在外层，载荷在 `data.value`。
 * 拉不到就用兜底值继续 —— 参考实现取不到版本号会整个放弃登录，这里更宽容。
 */
function lobsteraiClientVersion() {
  try {
    var resp = toolbox.http.request({
      method: 'GET',
      url: LOBSTERAI_VERSION_API,
      headers: { 'Accept': 'application/json' },
    })
    if (resp.status < 200 || resp.status >= 300) {
      return LOBSTERAI_FALLBACK_VERSION
    }
    var body = objectOf(parseBody(resp))
    var value = objectOf(objectOf(body.data).value)
    return trim(value.version) || LOBSTERAI_FALLBACK_VERSION
  }
  catch (e) {
    return LOBSTERAI_FALLBACK_VERSION
  }
}

/**
 * LobsterAI 用量。
 *
 * 用 `profile-summary` 而不是 `/api/user/quota`：后者只给免费额度（300），
 * 不含活动积分（实测同一账号 profile-summary 有 5297.72，quota 只有 300）。
 * 服务端**不下面值**，只给 `creditsRemaining`；同一组活动的面值恒定，
 * 故取「同组有效包剩余量的最大值」当面值，让「剩余/总额」不至于永远是 1:1。
 * 已过 `expiresAt` 的包不计入 —— 那是发过但已作废的积分。
 */
function queryLobsteraiQuota(account) {
  var token = trim(account && account.token)
  if (!token) {
    throw new Error('缺少 LobsterAI 登录凭据，请重新登录或重新导入账号')
  }
  var resp = requestOK('GET', LOBSTERAI_API_BASE + '/api/user/profile-summary',
    token, null, 'LobsterAI 余量查询', lobsteraiHeaders(token))
  var envelope = lobsteraiEnvelopeOf(parseBody(resp))
  if (!envelope.ok) {
    throw new Error('余量查询失败：' + envelope.message)
  }

  var data = envelope.data
  var entries = []
  var items = data.creditItems
  if (Object.prototype.toString.call(items) === '[object Array]') {
    for (var i = 0; i < items.length; i++) {
      var item = objectOf(items[i])
      var remaining = Number(item.creditsRemaining)
      if (!isFinite(remaining)) {
        continue
      }
      var expiresAt = trim(item.expiresAt)
      var expiredAt = expiresAt ? Date.parse(expiresAt.replace(' ', 'T')) : NaN
      if (!isNaN(expiredAt) && Date.now() >= expiredAt) {
        continue
      }
      entries.push({
        label: trim(item.label) || trim(item.type) || '积分包',
        remaining: remaining,
        expiresAt: expiresAt,
      })
    }
  }

  var remain = 0
  var total = 0
  var cycleEnd = ''
  if (entries.length === 0) {
    // 没有逐包明细：只有总额就显示总额，两者都没有才算失败
    var top = Number(data.totalCreditsRemaining)
    if (!isFinite(top)) {
      throw new Error('LobsterAI 响应里没有可识别的积分字段')
    }
    remain = top
    total = top
  }
  else {
    // 同组面值 = 该组剩余量的最大值（没用过的包剩余即面值）
    var faces = {}
    for (var a = 0; a < entries.length; a++) {
      var key = entries[a].label
      if (faces[key] === undefined || entries[a].remaining > faces[key]) {
        faces[key] = entries[a].remaining
      }
    }
    for (var b = 0; b < entries.length; b++) {
      remain += entries[b].remaining
      total += faces[entries[b].label]
      var at = entries[b].expiresAt
      if (at) {
        var iso = new Date(Date.parse(at.replace(' ', 'T'))).toISOString()
        if (!cycleEnd || iso < cycleEnd) {
          cycleEnd = iso
        }
      }
    }
  }

  return {
    remain: Math.round(remain * 100) / 100,
    total: Math.round(total * 100) / 100,
    cycleEnd: cycleEnd,
    packages: entries.length,
    updatedAt: nowISO(),
  }
}

// ------------------------------------------------------------ Raccoon（商汤）

var RACCOON_API_BASE = 'https://xiaohuanxiong.com'
var RACCOON_AUTH_PREFIX = '/api/web/auth/v1'

function raccoonHeaders(token) {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token,
    // 个人账号为空串，但客户端总是发这个头
    'X-Org-Code': '',
    'X-Raccoon-Language': 'zh',
    'X-Client-Platform': 'desktop-windows',
  }
}

/** 解 Raccoon 的统一信封：code 为 0 才算成功 */
function raccoonEnvelopeOf(payload) {
  var body = objectOf(payload)
  var code = body.code === undefined || body.code === null ? 0 : body.code
  return {
    ok: String(code) === '0',
    code: code,
    message: trim(body.message || body.msg),
    data: objectOf(body.data),
  }
}

/**
 * Raccoon 用量。
 *
 * 只读端点 `GET /points/v1/balance`（高频路径上绝不碰写端点）。
 * `available_points` 是核心字段，缺了就报错而不是编一个 0；
 * 分池（奖励 / 每日 / 会员 / 充值）只用于明细计数，有效期与回补规则各不相同。
 */
function queryRaccoonQuota(account) {
  var token = trim(account && account.token)
  if (!token) {
    throw new Error('缺少 Raccoon 登录凭据，请重新登录或重新导入账号')
  }
  var resp = requestOK('GET', RACCOON_API_BASE + '/points/v1/balance',
    token, null, 'Raccoon 余量查询', raccoonHeaders(token))
  var envelope = raccoonEnvelopeOf(parseBody(resp))
  if (!envelope.ok) {
    throw new Error('余量查询失败：' + (envelope.message || ('code=' + String(envelope.code))))
  }

  var data = envelope.data
  var available = Number(data.available_points)
  if (!isFinite(available)) {
    throw new Error('Raccoon 响应缺少 available_points')
  }

  var pools = [
    { key: 'reward_points', skipZero: false },
    { key: 'daily_points', skipZero: false },
    { key: 'monthly_points', skipZero: true },
    { key: 'topup_points', skipZero: false },
  ]
  var count = 0
  for (var i = 0; i < pools.length; i++) {
    var value = Number(data[pools[i].key])
    if (!isFinite(value)) {
      continue
    }
    if (pools[i].skipZero && value <= 0) {
      continue
    }
    count++
  }

  return {
    remain: Math.round(available * 100) / 100,
    // 服务端不下面值，余额即唯一读数；给 total 同值避免进度条恒为 0
    total: Math.round(available * 100) / 100,
    cycleEnd: '',
    packages: count,
    updatedAt: nowISO(),
  }
}

// ------------------------------------------------------------ Loomy（讯飞）

var LOOMY_API_BASE = 'https://loomyad.xunfei.cn/api/v1'
var LOOMY_ACCOUNT_BASE = 'https://account.xfinfr.com'
var LOOMY_ACCESS_KEY_ID = '2thryby66wxi53sk'
var LOOMY_ACCESS_KEY_SECRET = 'zsak6eadrbawz683wf5r3m2snrwj868r'
var LOOMY_APP_ID = 'GM3LOOMY'
var LOOMY_WECHAT_APP_ID = 'wx18d60be432287cf8'
/** 微信校验域名白名单，换成本地地址会直接回「redirect_uri 参数错误」 */
var LOOMY_WECHAT_REDIRECT_URI = 'https://loomy.xunfei.cn/oauth/wechat/callback'
/** 登录会话有效期：14 天（服务端只接受声明值，响应里不带到期时间） */
var LOOMY_SESSION_TTL_SECONDS = 1209600

/**
 * MD5：讯飞账号接口的 Content-MD5 要用。
 *
 * goja 里没有 crypto 模块，这里按 RFC 1321 实现最小版本（只吃字节数组）。
 * K 表用 `floor(abs(sin(i+1)) * 2^32)` 现算 —— 这是各语言实现的通用写法，
 * 避免把 64 个魔数硬编码进插件。
 */
function md5Bytes(input) {
  var msg = []
  var i
  for (i = 0; i < input.length; i++) {
    msg.push(input[i] & 0xff)
  }
  var bitLenLo = (input.length * 8) >>> 0
  var bitLenHi = Math.floor(input.length * 8 / 4294967296)
  msg.push(0x80)
  while (msg.length % 64 !== 56) {
    msg.push(0)
  }
  // 长度按小端序追加
  msg.push(bitLenLo & 0xff, (bitLenLo >>> 8) & 0xff, (bitLenLo >>> 16) & 0xff, (bitLenLo >>> 24) & 0xff)
  msg.push(bitLenHi & 0xff, (bitLenHi >>> 8) & 0xff, (bitLenHi >>> 16) & 0xff, (bitLenHi >>> 24) & 0xff)

  var K = []
  for (i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0
  }
  var S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]

  var a0 = 0x67452301
  var b0 = 0xefcdab89 | 0
  var c0 = 0x98badcfe | 0
  var d0 = 0x10325476
  var M = []
  for (var off = 0; off < msg.length; off += 64) {
    for (i = 0; i < 16; i++) {
      M[i] = (msg[off + i * 4] | (msg[off + i * 4 + 1] << 8)
        | (msg[off + i * 4 + 2] << 16) | (msg[off + i * 4 + 3] << 24)) | 0
    }
    var A = a0
    var B = b0
    var C = c0
    var D = d0
    for (i = 0; i < 64; i++) {
      var F
      var g
      if (i < 16) {
        F = (B & C) | (~B & D)
        g = i
      }
      else if (i < 32) {
        F = (D & B) | (~D & C)
        g = (5 * i + 1) % 16
      }
      else if (i < 48) {
        F = B ^ C ^ D
        g = (3 * i + 5) % 16
      }
      else {
        F = C ^ (B | ~D)
        g = (7 * i) % 16
      }
      var previousD = D
      D = C
      C = B
      var sum = (A + F + K[i] + M[g]) | 0
      var shift = S[(i >> 4) * 4 + (i % 4)]
      B = (B + ((sum << shift) | (sum >>> (32 - shift)))) | 0
      A = previousD
    }
    a0 = (a0 + A) | 0
    b0 = (b0 + B) | 0
    c0 = (c0 + C) | 0
    d0 = (d0 + D) | 0
  }

  var out = []
  var words = [a0, b0, c0, d0]
  for (i = 0; i < 4; i++) {
    out.push(words[i] & 0xff, (words[i] >>> 8) & 0xff, (words[i] >>> 16) & 0xff, (words[i] >>> 24) & 0xff)
  }
  return out
}

/** MD5 的 base64 形态（Content-MD5 头）；空 body 返回空串 */
function md5Base64(text) {
  if (!text) {
    return ''
  }
  return base64Encode(md5Bytes(utf8BytesOf(text)))
}

/** SHA-1：HMAC-SHA1 签名要用 */
function sha1Bytes(input) {
  var msg = []
  var i
  for (i = 0; i < input.length; i++) {
    msg.push(input[i] & 0xff)
  }
  var bitLenLo = (input.length * 8) >>> 0
  var bitLenHi = Math.floor(input.length * 8 / 4294967296)
  msg.push(0x80)
  while (msg.length % 64 !== 56) {
    msg.push(0)
  }
  // 长度按大端序追加
  msg.push((bitLenHi >>> 24) & 0xff, (bitLenHi >>> 16) & 0xff, (bitLenHi >>> 8) & 0xff, bitLenHi & 0xff)
  msg.push((bitLenLo >>> 24) & 0xff, (bitLenLo >>> 16) & 0xff, (bitLenLo >>> 8) & 0xff, bitLenLo & 0xff)

  var h = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0]
  var w = []
  for (var off = 0; off < msg.length; off += 64) {
    for (i = 0; i < 16; i++) {
      w[i] = ((msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16)
        | (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3]) | 0
    }
    for (i = 16; i < 80; i++) {
      var x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
      w[i] = (x << 1) | (x >>> 31)
    }
    var a = h[0]
    var b = h[1]
    var c = h[2]
    var d = h[3]
    var e = h[4]
    for (i = 0; i < 80; i++) {
      var f
      var k
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      }
      else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      }
      else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc | 0
      }
      else {
        f = b ^ c ^ d
        k = 0xca62c1d6 | 0
      }
      var t = ((((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0)
      e = d
      d = c
      c = (b << 30) | (b >>> 2)
      b = a
      a = t
    }
    h[0] = (h[0] + a) | 0
    h[1] = (h[1] + b) | 0
    h[2] = (h[2] + c) | 0
    h[3] = (h[3] + d) | 0
    h[4] = (h[4] + e) | 0
  }

  var out = []
  for (i = 0; i < 5; i++) {
    out.push((h[i] >>> 24) & 0xff, (h[i] >>> 16) & 0xff, (h[i] >>> 8) & 0xff, h[i] & 0xff)
  }
  return out
}

/** HMAC-SHA1 的 base64 形态 */
function hmacSha1Base64(keyText, messageText) {
  var key = utf8BytesOf(keyText)
  if (key.length > 64) {
    key = sha1Bytes(key)
  }
  while (key.length < 64) {
    key.push(0)
  }
  var outer = []
  var inner = []
  for (var i = 0; i < 64; i++) {
    outer.push(key[i] ^ 0x5c)
    inner.push(key[i] ^ 0x36)
  }
  var innerHash = sha1Bytes(inner.concat(utf8BytesOf(messageText)))
  return base64Encode(sha1Bytes(outer.concat(innerHash)))
}

/** RFC3986 转义：encodeURIComponent 之外还要补转 ! ' ( ) * */
function escapeRfc3986(value) {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
}

/** 路径段逐段转义（讯飞签名的 ESCAPED_PATH） */
function loomyEscapedPath(path) {
  var clean = path.charAt(0) === '/' ? path : '/' + path
  if (clean.length > 1 && clean.charAt(clean.length - 1) === '/') {
    clean = clean.slice(0, -1)
  }
  var segments = clean.split('/')
  var out = []
  for (var i = 0; i < segments.length; i++) {
    out.push(segments[i] ? escapeRfc3986(segments[i]) : '')
  }
  return out.join('/')
}

/**
 * 讯飞账号（CAccount）请求。
 *
 * 认证头是 `account {ak}:{sig}` 而不是 Bearer；签名串共 9 段、`\n` 连接，
 * 后两段（SignedHeaders / CanonicalizedHeaders）恒为空 —— 所以最终字符串
 * **以两个换行结尾**，去掉会让签名不匹配。
 * body 必须先序列化一次，签名与发送共用同一个字符串，否则字节一变就失效。
 */
function loomyAccountPost(path, param, what) {
  var body = JSON.stringify({
    base: {
      appid: LOOMY_APP_ID,
      modelid: 'Web',
      version: '1.0.0',
      devid: 'web',
      // 客户端在 Windows 上发的也是这个值，照抄不要改
      ua: 'Loomy|Desktop|Electron|macOS',
      traceid: hexOf(randomBytes(16)),
    },
    param: param,
  })
  var contentType = 'application/json'
  var date = new Date().toUTCString()
  var nonce = newSessionId()
  var stringToSign = [
    'POST',
    loomyEscapedPath(path),
    '',
    md5Base64(body),
    contentType,
    date,
    nonce,
    '',
    '',
  ].join('\n')
  var signature = hmacSha1Base64(LOOMY_ACCESS_KEY_SECRET, stringToSign)

  var resp = toolbox.http.request({
    method: 'POST',
    url: LOOMY_ACCOUNT_BASE + path,
    headers: {
      'Authorization': 'account ' + LOOMY_ACCESS_KEY_ID + ':' + signature,
      'Date': date,
      'Nonce': nonce,
      'Content-Type': contentType,
      'Content-MD5': md5Base64(body),
    },
    body: body,
  })
  var payload = parseBody(resp)
  if (!payload) {
    throw new Error(what + '失败：响应不是 JSON（HTTP ' + resp.status + '）')
  }
  // 账号端点的成功码是字符串 '000000'
  if (String(payload.code) !== '000000') {
    throw new Error(what + '失败：' + (trim(payload.desc || payload.message) || ('code=' + String(payload.code))))
  }
  return objectOf(payload.data)
}

/** 业务信封：成功码 '000000'，失败也返回 HTTP 200 */
function loomyEnvelopeOf(payload) {
  var body = objectOf(payload)
  return {
    ok: String(body.code) === '000000',
    message: trim(body.desc || body.message) || ('code=' + String(body.code)),
    data: objectOf(body.data),
  }
}

/**
 * 取微信扫码登录的 uuid。
 *
 * 授权页 HTML 里直接内嵌 uuid，两条路径互为兜底，无需执行 JS。
 */
function loomyWechatUuidOf(state) {
  var url = 'https://open.weixin.qq.com/connect/qrconnect?'
    + 'appid=' + encodeURIComponent(LOOMY_WECHAT_APP_ID)
    + '&redirect_uri=' + encodeURIComponent(LOOMY_WECHAT_REDIRECT_URI)
    + '&response_type=code&scope=snsapi_login'
    + '&state=' + encodeURIComponent(state)
    + '#wechat_redirect'
  var resp = toolbox.http.request({
    method: 'GET',
    url: url,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  })
  var html = String(resp.body || '')
  var matched = /\/(?:connect\/qrcode|l\/qrconnect\?uuid=)\/?([A-Za-z0-9_\-=+\/]{6,64})/.exec(html)
  return { authUrl: url, uuid: matched ? matched[1] : '' }
}

/**
 * 微信扫码长轮询一次。
 *
 * 状态语义以微信授权页内嵌 JS（官方源码）为准：
 * 408 待扫码、404 已扫码待确认、**405 已确认（code 就在这一帧）**、
 * 403 用户取消、402 二维码失效。早期把 404/405 读反过，导致永远等不到 code。
 */
function loomyWechatPollOnce(uuid, last) {
  var url = 'https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=' + encodeURIComponent(uuid)
  if (last) {
    url += '&last=' + encodeURIComponent(last)
  }
  var resp = toolbox.http.request({
    method: 'GET',
    url: url,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  })
  var text = String(resp.body || '')
  var errcode = /wx_errcode=(\d+)/.exec(text)
  var code = /wx_code='([^']*)'/.exec(text)
  return {
    errcode: errcode ? errcode[1] : '',
    code: code ? code[1] : '',
  }
}

/**
 * Loomy 用量。
 *
 * 只读端点 `/points/records`（`/points/first-login` 是写端点，会触发签到，
 * 打开面板时绝不能调）。两个积分池分开作明细：`balance` 永久、`dailyBalance` 每日。
 * 认证头是 `token: <session>`，不是 Bearer。
 */
function queryLoomyQuota(account) {
  var token = trim(account && account.token)
  if (!token) {
    throw new Error('缺少 Loomy 登录凭据，请重新登录或重新导入账号')
  }
  var resp = toolbox.http.request({
    method: 'GET',
    url: LOOMY_API_BASE + '/points/records?pageNo=1&pageSize=1&recordType=all',
    headers: { 'Accept': 'application/json', 'token': token },
  })
  var payload = parseBody(resp)
  if (!payload) {
    throw new Error('余量查询失败：响应不是 JSON（HTTP ' + resp.status + '）')
  }
  var envelope = loomyEnvelopeOf(payload)
  if (!envelope.ok) {
    throw new Error('余量查询失败：' + envelope.message)
  }

  var data = envelope.data
  var permanent = Number(data.balance)
  if (!isFinite(permanent)) {
    throw new Error('Loomy 响应缺少 balance 字段')
  }
  var daily = Number(data.dailyBalance)
  if (!isFinite(daily)) {
    daily = 0
  }
  var available = Number(data.availableBalance)
  var total = isFinite(available) ? available : permanent + daily

  var count = 1
  if (isFinite(Number(data.dailyBalance))) {
    count = 2
  }
  return {
    remain: Math.round(total * 100) / 100,
    total: Math.round(total * 100) / 100,
    cycleEnd: trim(data.dailyCycleDate),
    packages: count,
    updatedAt: nowISO(),
  }
}

// ------------------------------------------------------------ Trae

/** 取用量接口的响应根（各区域包了不同的壳） */
function traeUsageRoot(body) {
  var candidates = [
    body.Result,
    body.result,
    body.payload,
    body.ide_user_ent_usage,
    body.user_current_entitlement_list,
    body,
  ]
  for (var i = 0; i < candidates.length; i++) {
    var item = objectOf(candidates[i])
    if (hasKeys(item)) {
      return item
    }
  }
  return {}
}

/**
 * 权益包列表里累加「总量 / 已用」。
 *
 * 服务端有两套形状，都必须认：
 * 1. **现行形状**（`/trae/api/v2/pay/ide_user_ent_usage`）：
 *    `pack.entitlement_base_info.quota.credits_limit` + `pack.usage.credits_amount`，
 *    条目级 `expire_time`（**秒级**时间戳）；
 * 2. 旧的扁平形状（`basic_usage_limit` / `basic_usage_amount`），保留兜底。
 */
function traeUsageTotals(root) {
  var packs = root.user_entitlement_pack_list || root.userEntitlementPackList
  if (Object.prototype.toString.call(packs) !== '[object Array]') {
    return null
  }
  var total = 0
  var used = 0
  var counted = 0
  var cycleEnd = ''
  for (var i = 0; i < packs.length; i++) {
    var pack = objectOf(packs[i])
    if (pack.is_hide === true) {
      continue
    }
    var limit = pickNumber(pack, ['basic_usage_limit', 'basicUsageLimit'])
    var amount = pickNumber(pack, ['basic_usage_amount', 'basicUsageAmount'])
    var bonusLimit = pickNumber(pack, ['bonus_usage_limit', 'bonusUsageLimit'])
    var bonusAmount = pickNumber(pack, ['bonus_usage_amount', 'bonusUsageAmount'])

    if (limit === null && bonusLimit === null) {
      // 现行形状：额度在 entitlement_base_info.quota 里
      var base = objectOf(pack.entitlement_base_info || pack.entitlementBaseInfo)
      var quota = objectOf(base.quota)
      var creditsLimit = pickNumber(quota, ['credits_limit', 'creditsLimit'])
      if (creditsLimit === null || creditsLimit <= 0) {
        continue
      }
      var usage = objectOf(pack.usage)
      var creditsAmount = pickNumber(usage, ['credits_amount', 'creditsAmount'])
      counted++
      total += creditsLimit
      used += creditsAmount || 0
      // expire_time 是秒级时间戳：×1000 才是毫秒
      var expireSec = pickNumber(pack, ['expire_time', 'expireTime'])
      if (expireSec !== null && expireSec > 0) {
        var iso = new Date(expireSec * 1000).toISOString()
        if (!cycleEnd || iso < cycleEnd) {
          cycleEnd = iso
        }
      }
      continue
    }

    counted++
    total += (limit || 0) + (bonusLimit || 0)
    used += (amount || 0) + (bonusAmount || 0)
  }
  if (counted === 0) {
    return null
  }
  return { total: total, used: used, packs: counted, cycleEnd: cycleEnd }
}

/** 各区域的默认站点：登录页与本地登录态所在域 */
function traeDefaultHostOf(sourceId) {
  return sourceId === 'trae-cn' ? 'https://www.trae.cn' : 'https://www.trae.ai'
}

/** 各区域的**业务**域名：余量与签到都打这里，不是 www */
function traeApiHostOf(sourceId) {
  return sourceId === 'trae-cn' ? 'https://api.trae.cn' : 'https://api.trae.ai'
}

/** 按「本区域 → 另一区域」给出业务域名候选（token 属于哪边只有请求能验证） */
function traeApiHostsOf(sourceId) {
  var primary = traeApiHostOf(sourceId)
  var secondary = traeApiHostOf(sourceId === 'trae-cn' ? 'trae' : 'trae-cn')
  return primary === secondary ? [primary] : [primary, secondary]
}

/** 业务域名是否是国内站（决定 Package-Type / region / UA 等客户端形态） */
function traeIsCnHost(host) {
  return String(host).indexOf('.cn') >= 0 || String(host).indexOf('trae.com.cn') >= 0
}

/** 请求用的 access token：优先续期后的新 token，退回账号自身的 token */
function traeAccessTokenOf(account) {
  return trim(objectOf(account && account.meta).accessToken) || trim(account && account.token)
}

/**
 * Trae 账号的 user_id。
 *
 * 签到与余量都要**基于 user_id 确定性派生设备身份**（同一账号恒定，
 * 不同账号各自独立）。Web 登录会从 `login/account` 写进 meta；
 * 本地扫描导入的没有，用 JWT 的 uid / token 短哈希兜底，保证稳定即可。
 */
function traeUserIdOf(account) {
  var uid = trim(objectOf(account && account.meta).userId)
  if (uid) {
    return uid
  }
  uid = claimsUid(account && account.token) || ''
  if (uid) {
    return uid
  }
  var digest = sha256Bytes(utf8BytesOf(trim(account && account.token)))
  return 'trae-' + hexOf(digest).slice(0, 12)
}

/** SHA-256 确定性伪随机流：同一 (seed, salt) 永远产出同一串字节 */
function traeSeededStream(seed, salt, nbytes) {
  var prefix = utf8BytesOf(salt + ':' + seed)
  var out = []
  var counter = 0
  while (out.length < nbytes) {
    var input = prefix.slice()
    input.push((counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff)
    var digest = sha256Bytes(input)
    for (var i = 0; i < digest.length && out.length < nbytes; i++) {
      out.push(digest[i])
    }
    counter++
  }
  return out
}

/** 确定性 N 位数字串（每个账号一套稳定的设备号） */
function traeSeededDigits(n, seed, salt) {
  var bytes = traeSeededStream(seed, salt, n)
  var out = ''
  for (var i = 0; i < bytes.length; i++) {
    out += String(bytes[i] % 10)
  }
  return out
}

/** 15 位数字设备号（对齐客户端 `deriveDeviceId15`） */
function traeDeviceId15(uid) {
  return traeSeededDigits(15, uid, 'devid')
}

/** 由 uid 派生的 UUID v4（X-Market-User-Id） */
function traeMarketUserId(uid) {
  var bytes = traeSeededStream(uid, 'market', 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  var hex = ''
  for (var i = 0; i < bytes.length; i++) {
    hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)
  }
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16)
    + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32)
}

/** 由 uid 派生的 64 位 hex 会话号（Vscode-Sessionid） */
function traeSessionId(uid) {
  var bytes = traeSeededStream(uid, 'sess', 32)
  var out = ''
  for (var i = 0; i < bytes.length; i++) {
    out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)
  }
  return out
}

/**
 * Trae 业务端点（余量 / 签到）的请求头。
 *
 * ⚠️ 这三个端点认的是 `Authorization: Cloud-IDE-JWT <token>`，**不是 Bearer**；
 * 之前用 Bearer + x-cloudide-token，服务端一律回 401，界面上就是「登录态失效」。
 * 其余头是客户端形态伪装，缺了同样会被风控拦。
 */
function traeClientHeaders(account, cn) {
  var token = traeAccessTokenOf(account)
  var uid = traeUserIdOf(account)
  var version = cn ? TRAE_CN_IDE_VERSION : TRAE_IDE_VERSION
  return {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Accept-Language': 'zh-CN',
    'User-Agent': cn ? 'VSCode 1.107.1 (TRAE SOLO CN)' : 'VSCode 1.107.1 (TRAE)',
    'Authorization': 'Cloud-IDE-JWT ' + token,
    'X-Market-Client-Id': 'VSCode 1.107.1',
    'X-Market-User-Id': traeMarketUserId(uid),
    'X-User-Region': cn ? 'CN' : 'US',
    'X-Device-Id': traeDeviceId15(uid),
    'X-Lgw-Req-Sdk-Type': '3',
    'Package-Type': cn ? 'stable_cn' : 'stable',
    'X-Lscbd-Aid': '787976',
    'X-Lscbd-Platform': 'windows',
    'App-Version': version,
    'X-Tt-Trace-Id': '00-' + hexOf(randomBytes(16)) + '-01',
    'Vscode-Sessionid': traeSessionId(uid),
    'X-Request-Id': uuidV4(),
  }
}

/**
 * 确保账号有 user_id（签到/余量的设备身份由它派生）。
 *
 * 网页登录会从 `login/account` 拿到真实 uid 并写进 meta；本地 storage.json 扫描
 * 导入的只有令牌 —— 这里先用 token 派生的稳定值占位并**落库**，之后即使令牌续期，
 * 设备身份也不会漂移（漂移会被服务端当成新设备，签到的「每天一次」就错乱）。
 * 不额外发请求，避免拖慢余量刷新。
 */
function traeEnsureUserId(account) {
  var meta = objectOf(account.meta)
  if (trim(meta.userId)) {
    return
  }
  var digest = sha256Bytes(utf8BytesOf(trim(account && account.token)))
  meta.userId = 'trae-' + hexOf(digest).slice(0, 12)
  account.meta = meta
}

/** 发一次 Trae 业务请求；401 统一成「可续期」的错误 */
function traePostJSON(account, host, path, body, what) {
  var resp = toolbox.http.request({
    method: 'POST',
    url: host + path,
    headers: traeClientHeaders(account, traeIsCnHost(host)),
    body: JSON.stringify(body || {}),
  })
  if (resp.status === 401 || resp.status === 403) {
    throw authExpiredError()
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw describeHTTPError(what, resp)
  }
  var payload = parseBody(resp)
  if (!payload) {
    throw new Error(what + '失败：响应不是 JSON（HTTP ' + resp.status + '）')
  }
  return payload
}

/**
 * 用 refreshToken 换新的 access token（ExchangeToken）。
 *
 * 与 CodeBuddy 系同样的取舍：新 token 写 `meta.accessToken`，
 * **不动 `account.token`**（后者是账号身份，用于「当前」标记与导入去重）。
 */
function refreshTraeToken(source, account) {
  var meta = objectOf(account && account.meta)
  var refreshToken = trim(meta.refreshToken)
  if (!refreshToken) {
    return false
  }
  var loginHost = trim(meta.loginHost) || traeDefaultHostOf(source && source.id)
  var clientId = source && source.id === 'trae-cn' ? TRAE_CN_CLIENT_ID : TRAE_CLIENT_ID
  try {
    var exchanged = traeExchange(loginHost, {
      ClientID: clientId,
      RefreshToken: refreshToken,
      ClientSecret: '-',
      UserID: '',
    })
    if (!exchanged || !exchanged.token) {
      return false
    }
    meta.accessToken = exchanged.token
    if (exchanged.refreshToken) {
      meta.refreshToken = exchanged.refreshToken
    }
    account.meta = meta
    account.updatedAt = nowISO()
    return true
  }
  catch (e) {
    toolbox.log('[trae] 续期失败：' + String(e && e.message ? e.message : e))
    return false
  }
}

/** Trae 动作的续期包装：401 时先续期再重试一次 */
function withTraeRefresh(source, account, run) {
  try {
    return run()
  }
  catch (e) {
    if (!isAuthExpired(e) || !refreshTraeToken(source, account)) {
      throw e
    }
    return run()
  }
}

/**
 * Trae 用量。
 *
 * 打**业务域名**（api.trae.cn / api.trae.ai）+ 客户端身份头，
 * body 必须带 `require_usage: true`（服务端据此返回 `usage.credits_amount`）。
 * 先打本来源的区域，失败再试另一区域 —— 扫描导入的账号没有 loginHost，
 * 只有请求本身能验证 token 属于哪个站。
 */
function queryTraeQuota(account, source) {
  if (!traeAccessTokenOf(account)) {
    throw new Error('缺少 Trae 登录凭据，请重新登录或重新导入账号')
  }
  traeEnsureUserId(account)
  return withTraeRefresh(source, account, function () {
    var sourceId = source && source.id ? source.id : trim(account && account.source)
    var hosts = traeApiHostsOf(sourceId)
    var lastError = null
    var expiredError = null
    for (var h = 0; h < hosts.length; h++) {
      try {
        var payload = traePostJSON(account, hosts[h], '/trae/api/v2/pay/ide_user_ent_usage',
          { require_usage: true, req_source: 2 }, 'Trae 余量查询')
        var totals = traeUsageTotals(traeUsageRoot(payload))
        if (!totals) {
          lastError = new Error('Trae 没有返回可识别的权益包')
          continue
        }
        return {
          remain: Math.round(Math.max(0, totals.total - totals.used) * 100) / 100,
          total: Math.round(totals.total * 100) / 100,
          cycleEnd: totals.cycleEnd || '',
          packages: totals.packs,
          updatedAt: nowISO(),
        }
      }
      catch (e) {
        // 401 先记下继续试另一个区域；两个区域都拒才交给外层续期
        if (isAuthExpired(e)) {
          expiredError = expiredError || e
          continue
        }
        lastError = e
      }
    }
    throw expiredError || lastError || new Error('Trae 余量查询失败，请稍后重试')
  })
}

// ------------------------------------------------------------ Trae 签到

/** 签到状态：`{ enabled, checkedIn, credits, streakDays }` */
function traeCheckinStatusOf(account, host) {
  var payload = traePostJSON(account, host, '/trae/api/v2/ug/checkin_credits/status', {}, 'Trae 签到状态')
  var code = pickNumber(payload, ['code'])
  if (code !== null && code !== 0) {
    throw new Error(trim(payload.message || payload.msg) || '无法获取签到状态：code=' + code)
  }
  return {
    enabled: payload.enable === true,
    checkedIn: payload.checked_in === true,
    credits: pickNumber(payload, ['credits']) || 0,
    streakDays: pickNumber(payload, ['streak_days', 'streakDays']) || 0,
  }
}

/**
 * Trae 签到。
 *
 * 三步（对齐参考实现）：
 * 1. 查状态：`enable=false` 说明活动没开，直接返回原因，不发签到请求；
 *    `checked_in=true` 说明今天签过，不再重复请求；
 * 2. 领取：body 是 `{}`（不是 `{req_source:2}`）；
 * 3. 领取响应**不含积分数**（只有 `{code:0,message:"success"}`），补查一次状态拿
 *    `credits`，否则界面只能显示「+0 积分」。
 *
 * 业务码：9074 签到人数过多、1005 套餐限制，措辞要指向原因。
 */
function traeCheckinOnce(account, source) {
  traeEnsureUserId(account)
  var sourceId = source && source.id ? source.id : trim(account && account.source)
  var hosts = traeApiHostsOf(sourceId)
  var host = hosts[0]
  var status = null
  var lastError = null
  for (var h = 0; h < hosts.length; h++) {
    try {
      status = traeCheckinStatusOf(account, hosts[h])
      host = hosts[h]
      lastError = null
      break
    }
    catch (e) {
      lastError = e
      if (!isAuthExpired(e)) {
        throw e
      }
    }
  }
  if (!status) {
    throw lastError || new Error('无法获取签到状态')
  }

  var lastAt = account.checkin && account.checkin.lastAt ? account.checkin.lastAt : nowISO()
  var knownStreak = account.checkin && account.checkin.streak ? account.checkin.streak : 0

  if (!status.enabled) {
    account.checkin = {
      state: 'inactive',
      message: '签到活动当前未开启',
      lastAt: lastAt,
      streak: status.streakDays || knownStreak,
    }
    account.updatedAt = nowISO()
    return { ok: false, error: account.checkin.message }
  }
  if (status.checkedIn) {
    account.checkin = {
      state: 'claimed',
      message: '今天已经签到过了',
      lastAt: lastAt,
      streak: status.streakDays || knownStreak,
    }
    account.updatedAt = nowISO()
    return { ok: true, message: account.checkin.message, already: true }
  }

  var payload = traePostJSON(account, host, '/trae/api/v2/ug/checkin_credits/claim', {}, 'Trae 签到')
  var code = pickNumber(payload, ['code'])
  var message = trim(payload.message || payload.msg)
  if (code === 9074) {
    throw new Error(message || '签到人数过多，请稍后再试')
  }
  if (code === 1005) {
    throw new Error(message || '当前套餐不支持签到')
  }
  if (code !== null && code !== 0) {
    throw new Error(message || '签到失败（code=' + code + '）')
  }

  // 领取响应不含积分数，补查一次状态
  var after = null
  try {
    after = traeCheckinStatusOf(account, host)
  }
  catch (e) {
    after = null
  }
  var credit = after ? after.credits : 0
  var streak = (after && after.streakDays) || status.streakDays || knownStreak + 1
  var text = credit > 0 ? '签到成功，获得 ' + credit + ' 积分' : '签到成功'
  account.checkin = {
    state: 'claimed',
    message: text,
    lastAt: nowISO(),
    streak: streak,
  }
  account.updatedAt = nowISO()
  return { ok: true, message: text, already: false }
}

// ------------------------------------------------------------ 签到

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

/** 签到活动是否已开启；字段缺失时按「开启」处理，不误拦正常签到 */
function checkinActiveOf(payload) {
  if (!payload) {
    return true
  }
  var data = payload.data || payload.Data || payload
  var active = data.active
  if (active === undefined || active === null) {
    active = data.Active
  }
  if (active === false || active === 0 || active === 'false') {
    return false
  }
  return true
}

/**
 * 查询签到状态，返回 { state, active, streak, payload }。
 *
 * 权威端点是 checkin-activity-status；checkin-status 只在它「根本不存在」
 * （HTTP 404/405）时兜底 —— 后者返回的是占位数据（active:false、
 * checkin_dates:null），拿它判断状态会把「今天没签」误判成「活动未开启」。
 * 同理，业务码非 0 直接报错，不再往下一条路径兜底。
 */
function checkinStatus(source, token, account) {
  var paths = ['/v2/billing/meter/checkin-activity-status', '/v2/billing/meter/checkin-status']
  var headers = buddyHeaders(source, token, account)
  var lastError = ''
  for (var i = 0; i < paths.length; i++) {
    var resp = null
    try {
      resp = requestJSON('POST', source.api + paths[i], token, {}, headers)
    }
    catch (e) {
      // 网络错误：换下一条路径再试
      lastError = String(e && e.message ? e.message : e)
      continue
    }
    if (resp.status === 401 || resp.status === 403) {
      throw authExpiredError()
    }
    if (resp.status === 404 || resp.status === 405) {
      lastError = describeHTTPError('签到状态查询', resp).message
      continue
    }
    if (resp.status < 200 || resp.status >= 300) {
      lastError = describeHTTPError('签到状态查询', resp).message
      continue
    }
    var payload = parseBody(resp)
    var code = payload && payload.code !== undefined && payload.code !== null ? payload.code : 0
    // 业务失败（非 0）不能当成「还没签到」，否则会把失败误判成可签
    if (String(code) !== '0' && String(code) !== '200') {
      throw new Error(trim(payload && (payload.msg || payload.message)) || '无法获取签到状态：code=' + code)
    }
    return {
      state: checkinStateOf(payload),
      active: checkinActiveOf(payload),
      streak: checkinStreakOf(payload),
      payload: payload,
    }
  }
  throw new Error(lastError || '无法获取签到状态')
}

/**
 * 执行签到。
 *
 * 三个非 0 业务码都有确定含义，不能一律当「失败」：
 *   10001 / 1001  今天已经签过（服务端用 HTTP 400 表达，幂等而非错误）
 *   1002          当前账号没有领取资格
 *   1003          活动已结束
 * 后两者是终局状态，措辞要指向原因，否则用户只会反复重试。
 */
function performCheckin(source, account) {
  // 续期过的话用 meta 里的新 token（和余量查询保持一致）
  var token = buddyAccessTokenOf(account)
  var resp = requestJSON('POST', source.api + '/v2/billing/meter/daily-checkin', token, {}, buddyHeaders(source, token, account))
  var payload = parseBody(resp)
  var data = objectOf(payload && payload.data)
  var code = payload ? numberOr(payload.code, numberOr(data.code, 0)) : 0
  var reply = trim(payload ? (payload.msg || payload.message || data.msg || data.message) : '')
  var credit = numberOr(data.credit, 0)
  var streak = numberOr(data.streak_days, 0)

  // 10001 / 1001 = 今天已经签过：不是失败，但也不能算「刚刚签到成功」
  if (code === 10001 || code === 1001 || /已签到|已经签到|重复签/.test(reply)) {
    return { state: 'claimed', message: reply || '今天已经签到过了', already: true, streak: streak }
  }

  if (resp.status === 401 || resp.status === 403) {
    throw authExpiredError()
  }
  if (code === 1002) {
    throw new Error(reply || '当前账号没有签到资格')
  }
  if (code === 1003) {
    throw new Error(reply || '签到活动已结束')
  }
  if (String(code) !== '0' && String(code) !== '200') {
    // 有业务说明就以它为准；具体 code 只进日志
    toolbox.log('[签到] HTTP ' + resp.status + ' code=' + code + '；消息：' + reply)
    throw new Error(reply || '签到失败，请稍后重试')
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw describeHTTPError('签到', resp)
  }

  var message = reply || (credit > 0 ? '签到成功，获得 ' + credit + ' 积分' : '签到成功')
  return { state: 'claimed', message: message, already: false, streak: streak }
}

/** 给单个账号签到：401 时先尝试续期再重试一次 */
function runCheckin(account, source) {
  // Trae 是另一套协议（checkin_credits），与 CodeBuddy 系不共用
  if (source && (source.id === 'trae' || source.id === 'trae-cn')) {
    return withTraeRefresh(source, account, function () {
      return traeCheckinOnce(account, source)
    })
  }
  return withBuddyRefresh(source, account, function () {
    return checkinOnce(account, source)
  })
}

function checkinOnce(account, source) {
  var status = checkinStatus(source, buddyAccessTokenOf(account), account)
  var streakFromServer = status.streak || 0
  var lastAt = account.checkin && account.checkin.lastAt ? account.checkin.lastAt : nowISO()
  var knownStreak = account.checkin && account.checkin.streak ? account.checkin.streak : 0

  // 活动未开启时不发签到请求：服务端会回 1002/1003，界面只能显示成「签到失败」
  if (status.active === false) {
    account.checkin = {
      state: 'inactive',
      message: '签到活动当前未开启',
      lastAt: lastAt,
      streak: streakFromServer || knownStreak,
    }
    account.updatedAt = nowISO()
    return { ok: false, error: account.checkin.message }
  }

  if (status.state === 'claimed') {
    // 服务端已明确「今天签过」，不再发签到请求
    account.checkin = {
      state: 'claimed',
      message: '今天已经签到过了',
      lastAt: lastAt,
      streak: streakFromServer || knownStreak,
    }
    account.updatedAt = nowISO()
    return { ok: true, message: account.checkin.message, already: true }
  }

  var result = performCheckin(source, account)
  var streakBase = streakFromServer || knownStreak
  account.checkin = {
    state: result.state,
    message: result.message,
    lastAt: nowISO(),
    // 服务端给了天数就以服务端为准，否则本地累加
    streak: result.already ? streakBase : (result.streak || streakFromServer || streakBase + 1),
  }
  account.updatedAt = nowISO()
  return { ok: true, message: result.message, already: result.already }
}

// ------------------------------------------------------------ 凭据续期

/** 账号的 refresh_token；没有（例如从本地登录态导入的）返回空串 */
function buddyRefreshTokenOf(account) {
  return trim(objectOf(account && account.meta).refreshToken)
}

/**
 * 请求用的 access token：优先用续期拿到的新 token，退回账号自身的 token。
 *
 * ⚠️ 续期**不改** `account.token`：那个值代表「这个账号在本地登录态里的身份」，
 * `publicView.ideaCurrent`（与 IDE 里的 token 比对）和 `import` 的去重键都读它。
 * 续期换了它，界面上的「当前」标记会凭空消失、重新导入还会多出一条重复账号。
 */
function buddyAccessTokenOf(account) {
  return trim(objectOf(account && account.meta).accessToken) || trim(account && account.token)
}

/**
 * 由 expiresIn（相对秒数）推算绝对过期时间（毫秒）。
 *
 * `/v2/plugin/auth/token` 不返回绝对的 expiresAt，只给相对秒数；换算基准取
 * access_token 的 JWT `iat`（权威签发时刻），缺失时才用当前时刻。算不出返回 0。
 */
function buddyExpiresAtOf(token, expiresIn) {
  var seconds = numberOr(expiresIn, 0)
  if (seconds <= 0) {
    return 0
  }
  var claims = jwtClaims(token) || {}
  var issuedAt = numberOr(claims.iat, 0)
  var baseMs = issuedAt > 0 ? issuedAt * 1000 : Date.now()
  return baseMs + seconds * 1000
}

/**
 * 静默续期：POST /v2/plugin/auth/token/refresh。
 *
 * 请求头除常规身份标识外，还要 X-Refresh-Token（提交 refresh_token）与
 * X-Auth-Refresh-Source（来源标识，固定 ide-main）。成功后原地回写 token
 * 与 meta（refreshToken / expiresAt），失败返回 false —— 由调用方决定
 * 是否把原错误抛给用户。
 *
 * 没有 refresh_token 时直接返回 false：本地登录态导入的账号本来就没有。
 */
function refreshBuddyToken(source, account) {
  if (!buddyIdentity(source)) {
    return false
  }
  var refreshToken = buddyRefreshTokenOf(account)
  if (!refreshToken) {
    return false
  }
  var headers = buddyHeaders(source, buddyAccessTokenOf(account), account)
  headers['X-Refresh-Token'] = refreshToken
  headers['X-Auth-Refresh-Source'] = BUDDY_REFRESH_SOURCE

  var resp = null
  try {
    resp = toolbox.http.request({
      method: 'POST',
      url: source.api + '/v2/plugin/auth/token/refresh',
      headers: headers,
    })
  }
  catch (e) {
    toolbox.log('[续期] 网络错误：' + String(e && e.message ? e.message : e))
    return false
  }
  var payload = parseBody(resp)
  var code = payload && payload.code !== undefined && payload.code !== null ? String(payload.code) : '0'
  if (resp.status < 200 || resp.status >= 300 || (code !== '0' && code !== '200')) {
    toolbox.log('[续期] HTTP ' + resp.status + ' code=' + code)
    return false
  }
  var data = objectOf(payload && payload.data)
  var token = trim(data.accessToken || data.access_token)
  if (!token) {
    toolbox.log('[续期] 响应里没有 accessToken')
    return false
  }

  var meta = objectOf(account.meta)
  meta.accessToken = token
  meta.refreshToken = trim(data.refreshToken || data.refresh_token) || refreshToken
  var expiresAt = buddyExpiresAtOf(token, data.expiresIn || data.expires_in)
  if (expiresAt > 0) {
    meta.expiresAt = expiresAt
  }
  account.meta = meta
  account.updatedAt = nowISO()
  return true
}

/**
 * CodeBuddy 系动作的续期包装：过期了先续期，401 再续一次并重试。
 *
 * 只对 CodeBuddy 系生效（其余来源没有 refresh 链路）；续期失败时把原错误
 * 原样抛出，用户看到的仍是「登录态已失效」。
 */
function withBuddyRefresh(source, account, run) {
  if (!buddyIdentity(source)) {
    return run()
  }
  var expiresAt = numberOr(objectOf(account.meta).expiresAt, 0)
  if (expiresAt > 0 && Date.now() >= expiresAt) {
    refreshBuddyToken(source, account)
  }
  try {
    return run()
  }
  catch (e) {
    if (!isAuthExpired(e) || !refreshBuddyToken(source, account)) {
      throw e
    }
    return run()
  }
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

function publicView(account, currentMap, index, ideaToken) {
  var view = {
    id: account.id,
    source: account.source,
    name: account.name,
    addedAt: account.addedAt,
    updatedAt: account.updatedAt,
    quota: account.quota || null,
    checkin: account.checkin || null,
    // 已勾选的登录态位置（file + key），「设为当前」时写这些位置
    targets: account.targets || [],
    current: currentMap[account.source] === account.id,
    // IDEA 里实际登录的是不是这个账号（按 token 比对）
    ideaCurrent: Boolean(ideaToken && account.token === ideaToken),
    index: index,
  }
  return view
}

function stateSnapshot() {
  var list = loadAccounts()
  var currentMap = loadCurrent()
  var ideaToken = currentIdeaToken()
  var accounts = []
  for (var i = 0; i < list.length; i++) {
    accounts.push(publicView(list[i], currentMap, i, ideaToken))
  }
  return {
    // 来源列表保持全量：导入、签到分组、账号归属都依赖它。
    // 「没账号的不显示」只做在界面上，不能在这里动数据。
    sources: SOURCES,
    actions: ACTIONS,
    accounts: accounts,
    current: currentMap,
  }
}

// ------------------------------------------------------------ 扩展动作

function runQuota(account, source) {
  // 401 时先续期再重试一次：CodeBuddy 系的 access token 过期后不续期只能重登
  var quota = withBuddyRefresh(source, account, function () {
    return queryQuota(source, account)
  })
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

  // 一键签到：跨来源，不看当前来源/勾选过滤 —— 所有支持签到的账号都签一遍
  var crossSource = false
  if (action === 'checkin-all') {
    action = 'checkin'
    sourceId = ''
    crossSource = true
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
    // 一键签到只处理「声明了签到能力」的来源；其余账号不该出现在结果里
    if (crossSource && (!source.capabilities || !source.capabilities.checkin)) {
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
    var displayName = nameOf(entry, entry.token)
    if (!displayName) {
      displayName = source.label + ' ' + String(list.length + 1)
    }
    list.push({
      id: newId(),
      source: sourceId,
      name: displayName,
      token: entry.token,
      // 网页登录刚拿到的附加凭据（refreshToken / profileArn / loginHost）随 token 一起落库
      meta: takeLoginMeta(entry.token),
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

// ------------------------------------------------------------ 浏览器登录（统一骨架）

/**
 * 三种 kind：
 *   implicit  回调 URL 的 query 里直接带 token（Windsurf）
 *   code      回调拿到 code，再按渠道自己的方式换 token（Copilot / Kiro / Trae / Antigravity）
 *   poll      没有回调，带 verifier 轮询服务端（Cursor / Qoder）
 *
 * 新渠道只需要在 OAUTH_FLOWS 里加一个对象，oauthStart / oauthPoll 自动分派。
 */

var OAUTH_CALLBACK_PORT = 18765
/** Google 要求回调地址严格匹配，所以统一用 localhost 而不是 127.0.0.1 */
var OAUTH_LOCAL_HOST = 'localhost'
var OAUTH_FLOW_TTL_MS = 10 * 60 * 1000

// ------------------------------------------------------------ 随机与编码

/** goja 没有 crypto / atob，这里补最小的随机与编码工具 */

function randomBytes(length) {
  var out = []
  if (toolbox.crypto && typeof toolbox.crypto.randomBytes === 'function') {
    try {
      var host = toolbox.crypto.randomBytes(length)
      if (host && host.length === length) {
        for (var h = 0; h < length; h++) {
          out.push(Number(host[h]) & 0xff)
        }
        return out
      }
    }
    catch (e) {
      // 宿主版本偏旧：退回 Math.random
    }
  }
  for (var i = 0; i < length; i++) {
    out.push(Math.floor(Math.random() * 256))
  }
  return out
}

/** UTF-8 编码成字节数组（verifier / code 都是 ASCII，这里只兜底） */
function utf8BytesOf(text) {
  var source = String(text === null || text === undefined ? '' : text)
  var out = []
  for (var i = 0; i < source.length; i++) {
    var code = source.charCodeAt(i)
    if (code < 0x80) {
      out.push(code)
    }
    else if (code < 0x800) {
      out.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F))
    }
    else {
      out.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F))
    }
  }
  return out
}

function base64Encode(bytes) {
  var out = ''
  var i = 0
  while (i + 2 < bytes.length) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64_CHARS.charAt((n >> 18) & 63)
      + B64_CHARS.charAt((n >> 12) & 63)
      + B64_CHARS.charAt((n >> 6) & 63)
      + B64_CHARS.charAt(n & 63)
    i += 3
  }
  var rest = bytes.length - i
  if (rest === 1) {
    var one = bytes[i] << 16
    out += B64_CHARS.charAt((one >> 18) & 63) + B64_CHARS.charAt((one >> 12) & 63) + '=='
  }
  else if (rest === 2) {
    var two = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64_CHARS.charAt((two >> 18) & 63)
      + B64_CHARS.charAt((two >> 12) & 63)
      + B64_CHARS.charAt((two >> 6) & 63)
      + '='
  }
  return out
}

function base64UrlOf(bytes) {
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function hexOf(bytes) {
  var out = ''
  for (var i = 0; i < bytes.length; i++) {
    out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)
  }
  return out
}

/** SHA-256 常量表 */
var SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function rotr32(value, bits) {
  return (value >>> bits) | (value << (32 - bits))
}

/** SHA-256：PKCE 的 S256 要用，goja 里没有现成的 */
function sha256Bytes(input) {
  var msg = []
  var i
  for (i = 0; i < input.length; i++) {
    msg.push(input[i] & 0xff)
  }
  var bitLenLo = (input.length * 8) >>> 0
  var bitLenHi = Math.floor(input.length * 8 / 4294967296)
  msg.push(0x80)
  while (msg.length % 64 !== 56) {
    msg.push(0)
  }
  msg.push((bitLenHi >>> 24) & 0xff, (bitLenHi >>> 16) & 0xff, (bitLenHi >>> 8) & 0xff, bitLenHi & 0xff)
  msg.push((bitLenLo >>> 24) & 0xff, (bitLenLo >>> 16) & 0xff, (bitLenLo >>> 8) & 0xff, bitLenLo & 0xff)

  var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  var w = []
  for (var off = 0; off < msg.length; off += 64) {
    for (i = 0; i < 16; i++) {
      w[i] = ((msg[off + i * 4] << 24)
        | (msg[off + i * 4 + 1] << 16)
        | (msg[off + i * 4 + 2] << 8)
        | msg[off + i * 4 + 3]) | 0
    }
    for (i = 16; i < 64; i++) {
      var s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      var s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    var a = h[0]
    var b = h[1]
    var c = h[2]
    var d = h[3]
    var e = h[4]
    var f = h[5]
    var g = h[6]
    var hh = h[7]
    for (i = 0; i < 64; i++) {
      var S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)
      var ch = (e & f) ^ (~e & g)
      var temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) | 0
      var S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)
      var maj = (a & b) ^ (a & c) ^ (b & c)
      var temp2 = (S0 + maj) | 0
      hh = g
      g = f
      f = e
      e = (d + temp1) | 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) | 0
    }
    h[0] = (h[0] + a) | 0
    h[1] = (h[1] + b) | 0
    h[2] = (h[2] + c) | 0
    h[3] = (h[3] + d) | 0
    h[4] = (h[4] + e) | 0
    h[5] = (h[5] + f) | 0
    h[6] = (h[6] + g) | 0
    h[7] = (h[7] + hh) | 0
  }

  var out = []
  for (i = 0; i < 8; i++) {
    out.push((h[i] >>> 24) & 0xff, (h[i] >>> 16) & 0xff, (h[i] >>> 8) & 0xff, h[i] & 0xff)
  }
  return out
}

/** PKCE：verifier 明文，challenge = base64url(sha256(verifier)) */
function pkceChallengeOf(verifier) {
  return base64UrlOf(sha256Bytes(utf8BytesOf(verifier)))
}

/** UUID v4，只用作本地会话标识 */
function uuidV4() {
  var bytes = randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  var hex = hexOf(bytes)
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16)
    + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32)
}

/** 解析回调 query（不把 + 当空格：OAuth 的 code 里 + 是有效字符） */
function parseQueryString(text) {
  var out = {}
  var raw = String(text || '')
  if (raw.charAt(0) === '?') {
    raw = raw.slice(1)
  }
  if (raw.charAt(0) === '#') {
    raw = raw.slice(1)
  }
  if (!raw) {
    return out
  }
  var parts = raw.split('&')
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) {
      continue
    }
    var eq = parts[i].indexOf('=')
    var key = eq < 0 ? parts[i] : parts[i].slice(0, eq)
    var value = eq < 0 ? '' : parts[i].slice(eq + 1)
    try {
      key = decodeURIComponent(key)
      value = decodeURIComponent(value)
    }
    catch (e) {
      // 解码失败就用原文
    }
    out[key] = value
  }
  return out
}

/** 在回调参数里按多个键名取第一个非空值 */
function firstParam(params, keys) {
  var source = objectOf(params)
  for (var i = 0; i < keys.length; i++) {
    var value = trim(source[keys[i]])
    if (value) {
      return value
    }
  }
  return ''
}

/**
 * 解析回调里 URL 编码的 JSON 参数（Trae 的 `userInfo` / `userJwt` / `authCodeInfo`）。
 *
 * 三种形态都要认：已解码过的 JSON、还带 percent-encoding 的 JSON、
 * 以及用 `+` 表示空格的 form 编码。解不出返回 null（不抛错）。
 */
function jsonParamOf(raw) {
  var text = trim(raw)
  if (!text) {
    return null
  }
  var candidates = [text]
  try {
    var unescaped = decodeURIComponent(text)
    if (unescaped !== text) {
      candidates.push(unescaped)
    }
  }
  catch (e) {
    // 非法编码：只用原串
  }
  try {
    var plusFixed = decodeURIComponent(text.replace(/\+/g, '%20'))
    if (candidates.indexOf(plusFixed) < 0) {
      candidates.push(plusFixed)
    }
  }
  catch (e) {
    // 同上
  }
  for (var i = 0; i < candidates.length; i++) {
    try {
      var parsed = JSON.parse(candidates[i])
      if (parsed && typeof parsed === 'object'
        && Object.prototype.toString.call(parsed) !== '[object Array]') {
        return parsed
      }
    }
    catch (e) {
      // 试下一个候选
    }
  }
  return null
}

/** 从 JSON 对象里取字符串（数字也转成字符串） */
function jsonTextOf(source, key) {
  if (!source) {
    return ''
  }
  var value = source[key]
  if (typeof value === 'string') {
    return trim(value)
  }
  if (typeof value === 'number' && isFinite(value)) {
    return String(value)
  }
  return ''
}

/** 取第一个非空字符串（不能用 || 串，空串不是 falsy 语义上的「缺失」） */
function firstNonEmptyOf(list) {
  for (var i = 0; i < list.length; i++) {
    var value = trim(list[i])
    if (value) {
      return value
    }
  }
  return ''
}

/**
 * 本地回调地址。
 *
 * 默认 `localhost:18765`；个别渠道有硬约束（Trae CN 只认
 * `http://127.0.0.1:18080/authorize`），由流程对象在 prepare 里显式指定。
 */
function oauthCallbackUrlOf(path, port, host) {
  return 'http://' + (host || OAUTH_LOCAL_HOST) + ':' + (port || OAUTH_CALLBACK_PORT) + path
}

// ------------------------------------------------------------ 各渠道流程

var WINDSURF_CLIENT_ID = '3GUryQ7ldAeKEuD2obYnppsnmj58eP5u'
var GITHUB_COPILOT_CLIENT_ID = '01ab8ac9400c4e429b23'
var GITHUB_COPILOT_CLIENT_SECRET = '2af589bb2ffd03a29cc0df83f767e3f6693f14cd'
var GITHUB_COPILOT_REDIRECT = 'https://vscode.dev/redirect'
var ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
var ANTIGRAVITY_CLIENT_SECRET = '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'
var ANTIGRAVITY_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/aicode',
].join(' ')
/** Trae 国际版 */
var TRAE_CLIENT_ID = 'ono9krqynydwx5'
var TRAE_IDE_VERSION = '3.5.66'
var TRAE_PLUGIN_VERSION = 'local'
/**
 * Trae CN：这三个值与国际化**完全不同**（参考实现按 CN 客户端实测）。
 *
 * 用国际版的值请求 CN 登录页会得到「登录失败 / 网络错误，请刷新页面重试」——
 * 页面拿 client_id + plugin_version 去换票，服务端不认就整页失败。
 */
var TRAE_CN_CLIENT_ID = 'en1oxy7wnw8j9n'
var TRAE_CN_IDE_VERSION = '0.1.52'
var TRAE_CN_PLUGIN_VERSION = '2.3.62834'
/**
 * CN 登录页只接受 `http://127.0.0.1:18080/authorize` 这个回调
 * （端口固定，且必须是 127.0.0.1 而非 localhost）。
 */
var TRAE_CN_CALLBACK_PORT = 18080

/** GitHub 账号信息：/user 没给邮箱时再查一次 /user/emails */
function githubUserOf(token) {
  var headers = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'toolbox-agent-accounts',
  }
  var body = requestJSONOK('GET', 'https://api.github.com/user', headers, null, 'GitHub 账号信息')
  var email = trim(body.email)
  if (!email) {
    try {
      var list = requestJSONOK('GET', 'https://api.github.com/user/emails', headers, null, 'GitHub 邮箱')
      var fallback = ''
      if (Object.prototype.toString.call(list) === '[object Array]') {
        for (var i = 0; i < list.length; i++) {
          var item = objectOf(list[i])
          if (item.verified === true && item.primary === true && trim(item.email)) {
            email = trim(item.email)
            break
          }
          if (item.verified === true && !fallback && trim(item.email)) {
            fallback = trim(item.email)
          }
        }
        if (!email) {
          email = fallback
        }
      }
    }
    catch (e) {
      // 没有邮箱读取权限：不影响登录
    }
  }
  return {
    login: trim(body.login),
    name: trim(body.name) || trim(body.login),
    email: email,
  }
}

/** Google userinfo：拿 email / name */
function googleUserOf(token) {
  try {
    var body = requestJSONOK('GET', 'https://www.googleapis.com/oauth2/v2/userinfo', {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json',
    }, null, 'Google 账号信息')
    return { email: trim(body.email), name: trim(body.name) }
  }
  catch (e) {
    return { email: '', name: '' }
  }
}

/** Qoder 用户信息：接口没给就返回空，不阻断登录 */
function qoderUserOf(token) {
  try {
    var body = requestJSONOK('GET', 'https://openapi.qoder.sh/api/v1/userinfo', {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json',
    }, null, 'Qoder 账号信息')
    var data = objectOf(body.data)
    return {
      email: trim(body.email || data.email),
      name: trim(body.name || body.nickname || data.name || data.nickname),
    }
  }
  catch (e) {
    return { email: '', name: '' }
  }
}

/** Kiro / Trae 的 token 响应有时包一层 data */
function unwrapData(body) {
  var data = objectOf(body.data)
  return hasKeys(data) ? data : objectOf(body)
}

/**
 * Trae：先问服务端要登录域名，取不到再按区域回落到默认值。
 *
 * ⚠️ 询问顺序必须**按来源的区域优先**：以前国际站排在前面且兜底恒为
 * `www.trae.ai`，国内用户登录时会被引导到国际站（登录页、后续余量全错）。
 */
function traeLoginHost(traceId, sourceId) {
  var cn = sourceId === 'trae-cn'
  var guidance = '/cloudide/api/v3/trae/GetLoginGuidance'
  var origins = cn
    ? ['https://www.trae.cn', 'https://api.trae.cn', 'https://api.trae.com.cn',
      'https://api.trae.ai', 'https://www.trae.ai', 'https://api.marscode.com']
    : ['https://api.marscode.com', 'https://api.trae.ai', 'https://www.trae.ai',
      'https://api.trae.cn', 'https://api.trae.com.cn', 'https://www.trae.cn']
  for (var i = 0; i < origins.length; i++) {
    try {
      var body = requestJSONOK('POST', origins[i] + guidance, {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Trae/1.0.0 toolbox-agent-accounts',
      }, { loginTraceID: traceId, login_trace_id: traceId }, 'Trae 登录域名查询')
      var host = deepPickText(body, ['loginhost', 'loginurl', 'login_host', 'login_url'], 0)
      if (host) {
        return host
      }
    }
    catch (e) {
      // 换下一个区域再试
    }
  }
  return traeDefaultHostOf(sourceId)
}

/** Trae 的接口域名候选：loginHost 本身 + api 变体 + 区域默认 */
function traeApiOrigins(loginHost) {
  var origin = trim(loginHost)
  if (!origin) {
    origin = 'https://www.trae.ai'
  }
  if (origin.indexOf('http') !== 0) {
    origin = 'https://' + origin
  }
  origin = origin.replace(/\/+$/, '')
  var hostName = origin.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  var list = [origin]
  if (hostName.indexOf('www.') === 0) {
    list.push('https://api.' + hostName.slice(4))
  }
  else if (hostName.indexOf('api.') !== 0) {
    list.push('https://api.' + hostName)
  }
  var cn = hostName.indexOf('.cn') >= 0 || hostName.indexOf('trae.com.cn') >= 0
  var extra = cn
    ? ['https://api.trae.cn', 'https://api.trae.com.cn', 'https://www.trae.cn']
    : ['https://api.marscode.com', 'https://api.trae.ai', 'https://www.trae.ai']
  for (var i = 0; i < extra.length; i++) {
    list.push(extra[i])
  }
  var out = []
  for (var j = 0; j < list.length; j++) {
    if (out.indexOf(list[j]) < 0) {
      out.push(list[j])
    }
  }
  return out
}

/** Trae：用 refreshToken 或 authCode 换 access token */
function traeExchange(loginHost, payload) {
  var origins = traeApiOrigins(loginHost)
  var paths = payload.AuthCode
    ? ['/trae/api/v3/oauth/ExchangeToken', '/cloudide/api/v3/trae/oauth/ExchangeToken']
    : ['/cloudide/api/v3/trae/oauth/ExchangeToken']
  var lastError = null
  for (var i = 0; i < origins.length; i++) {
    for (var p = 0; p < paths.length; p++) {
      try {
        var body = requestJSONOK('POST', origins[i] + paths[p], {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Trae/1.0.0 toolbox-agent-accounts',
        }, payload, 'Trae 凭据换取')
        var token = deepPickText(body, ['accesstoken', 'access_token', 'token'], 0)
        if (token) {
          return {
            token: token,
            refreshToken: deepPickText(body, ['refreshtoken', 'refresh_token'], 0),
            loginHost: origins[i],
          }
        }
        lastError = new Error('Trae 没有返回 accessToken')
      }
      catch (e) {
        lastError = e
      }
    }
  }
  throw lastError || new Error('Trae 凭据换取失败，请稍后重试')
}

/** Trae：用 access token 取用户信息 */
function traeUserOf(loginHost, token) {
  var origins = traeApiOrigins(loginHost)
  for (var i = 0; i < origins.length; i++) {
    try {
      var body = requestJSONOK('POST', origins[i] + '/cloudide/api/v3/trae/GetUserInfo', {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'x-cloudide-token': token,
        'User-Agent': 'Trae/1.0.0 toolbox-agent-accounts',
      }, {}, 'Trae 账号信息')
      return {
        email: deepPickText(body, ['nonplaintextemail', 'email'], 0),
        name: deepPickText(body, ['screenname', 'nickname', 'name'], 0),
        userId: deepPickText(body, ['userid', 'uid'], 0),
      }
    }
    catch (e) {
      // 换下一个域名
    }
  }
  return { email: '', name: '', userId: '' }
}

/**
 * 各渠道的浏览器登录流程。
 *
 * prepare(pending)          本地生成 state / verifier / 设备码
 * buildAuthUrl(pending)     给用户打开的授权页
 * finish(pending, params)   code / implicit：用回调参数换 token
 * poll(pending)             poll：每轮问一次服务端，done=false 表示继续等
 */
/**
 * Trae 的设备指纹：首次生成后持久化，之后一直复用。
 *
 * 每次登录重新生成会被服务端判为「异常客户端」——登录页只会给一句
 * 含糊的 “Something went wrong”，排查成本很高。格式是 32 位 hex
 * （对齐官方 login.sh 的 `openssl rand -hex 16`）。
 */
function traeDeviceCredential(key) {
  var storageKey = 'trae_' + key
  try {
    var stored = trim(toolbox.storage.get(storageKey))
    if (/^[0-9a-f]{32}$/.test(stored)) {
      return stored
    }
  }
  catch (e) {
    // 存储不可用时退化为本次生成，至少参数格式正确
  }
  var fresh = hexOf(randomBytes(16))
  try {
    toolbox.storage.set(storageKey, fresh)
  }
  catch (e) {
    // 同上
  }
  return fresh
}

/**
 * login_trace_id：machineId + deviceId 的**尾部 16 位**。
 * 回调不保证回传 machine_id / device_id，靠这个值反查是哪次登录。
 */
function traeTraceIdOf(machineId, deviceId) {
  var joined = machineId + deviceId
  return joined.length >= 16 ? joined.slice(-16) : joined.padStart(16, '0')
}

var OAUTH_FLOWS = {
  windsurf: {
    kind: 'implicit',
    callbackPath: '/callback',
    intervalMs: 800,
    prepare: function (pending) {
      pending.state = newSessionId()
      pending.redirect = oauthCallbackUrlOf('/callback')
    },
    buildAuthUrl: function (pending) {
      return 'https://www.windsurf.com/windsurf/signin?' + [
        'response_type=token',
        'client_id=' + WINDSURF_CLIENT_ID,
        'redirect_uri=' + encodeURIComponent(pending.redirect),
        'state=' + encodeURIComponent(pending.state),
        'prompt=login',
        'redirect_parameters_type=query',
        'workflow=onboarding',
      ].join('&')
    },
    finish: function (pending, params) {
      if (params.state && params.state !== pending.state) {
        throw new Error('回调 state 不匹配，请重新发起登录')
      }
      var token = trim(params.access_token)
      if (!token) {
        throw new Error('回调里没有拿到凭据，请重新发起登录')
      }
      var claims = jwtClaims(token) || {}
      return {
        token: token,
        email: trim(claims.email),
        name: trim(claims.name || claims.nickname) || claimsLabel(token),
      }
    },
  },

  'github-copilot': {
    kind: 'code',
    callbackPath: '/callback',
    intervalMs: 600,
    prepare: function (pending) {
      // 参考实现用 32 字节随机数的 hex 当 verifier
      pending.verifier = hexOf(randomBytes(32))
      pending.challenge = pkceChallengeOf(pending.verifier)
      pending.nonce = base64UrlOf(randomBytes(16))
      pending.callbackUrl = oauthCallbackUrlOf('/callback') + '?nonce=' + encodeURIComponent(pending.nonce)
    },
    buildAuthUrl: function (pending) {
      return 'https://github.com/login/oauth/authorize?' + [
        'client_id=' + GITHUB_COPILOT_CLIENT_ID,
        'redirect_uri=' + encodeURIComponent(GITHUB_COPILOT_REDIRECT),
        // state 是本地回调地址：GitHub 会原样带回来，vscode.dev 负责中转
        'state=' + encodeURIComponent(pending.callbackUrl),
        'scope=' + encodeURIComponent('read:user repo user:email workflow'),
        'code_challenge=' + encodeURIComponent(pending.challenge),
        'code_challenge_method=S256',
        'get_started_with=copilot-vscode',
        'prompt=select_account',
      ].join('&')
    },
    finish: function (pending, params) {
      if (params.nonce && params.nonce !== pending.nonce) {
        throw new Error('回调 nonce 不匹配，请重新发起登录')
      }
      if (params.state && params.state !== pending.callbackUrl) {
        throw new Error('回调 state 不匹配，请重新发起登录')
      }
      var code = trim(params.code)
      if (!code) {
        throw new Error('回调里没有授权码，请重新发起登录')
      }
      var form = [
        'client_id=' + encodeURIComponent(GITHUB_COPILOT_CLIENT_ID),
        'client_secret=' + encodeURIComponent(GITHUB_COPILOT_CLIENT_SECRET),
        'code=' + encodeURIComponent(code),
        'redirect_uri=' + encodeURIComponent(GITHUB_COPILOT_REDIRECT),
        'code_verifier=' + encodeURIComponent(pending.verifier),
      ].join('&')
      var body = requestJSONOK('POST', 'https://github.com/login/oauth/access_token', {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'toolbox-agent-accounts',
      }, form, 'GitHub 授权')
      if (trim(body.error)) {
        throw new Error('GitHub 授权失败：' + (trim(body.error_description) || trim(body.error)))
      }
      var token = trim(body.access_token)
      if (!token) {
        throw new Error('GitHub 没有返回 access_token')
      }
      var user = githubUserOf(token)
      return {
        token: token,
        email: user.email,
        name: user.name || user.login,
        meta: { login: user.login },
      }
    },
  },

  cursor: {
    kind: 'poll',
    intervalMs: 2000,
    prepare: function (pending) {
      pending.verifier = base64UrlOf(randomBytes(32))
      pending.challenge = pkceChallengeOf(pending.verifier)
      pending.uuid = uuidV4()
    },
    buildAuthUrl: function (pending) {
      return 'https://cursor.com/loginDeepControl?challenge=' + encodeURIComponent(pending.challenge)
        + '&uuid=' + encodeURIComponent(pending.uuid)
        + '&mode=login'
    },
    poll: function (pending) {
      var resp = toolbox.http.request({
        method: 'GET',
        url: 'https://api2.cursor.sh/auth/poll?uuid=' + encodeURIComponent(pending.uuid)
          + '&verifier=' + encodeURIComponent(pending.verifier),
        headers: { 'Accept': 'application/json' },
      })
      // 404 = 用户还没在浏览器里点确认
      if (resp.status === 404) {
        return { done: false }
      }
      if (resp.status < 200 || resp.status >= 300) {
        return { done: false }
      }
      var body = objectOf(parseBody(resp))
      var token = trim(body.accessToken)
      if (!token) {
        return { done: false }
      }
      var authId = trim(body.authId)
      return {
        done: true,
        token: token,
        email: authId.indexOf('@') >= 0 ? authId : '',
        name: '',
        meta: { refreshToken: trim(body.refreshToken), authId: authId },
      }
    },
  },

  qoder: {
    kind: 'poll',
    intervalMs: 1000,
    prepare: function (pending) {
      pending.verifier = base64UrlOf(randomBytes(32))
      pending.challenge = pkceChallengeOf(pending.verifier)
      pending.nonce = uuidV4().replace(/-/g, '')
    },
    buildAuthUrl: function (pending) {
      return 'https://qoder.com/device/selectAccounts?nonce=' + encodeURIComponent(pending.nonce)
        + '&challenge=' + encodeURIComponent(pending.challenge)
        + '&challenge_method=S256'
        + '&redirect_uri=' + encodeURIComponent('qoder://aicoding.aicoding-agent/login-success')
    },
    poll: function (pending) {
      var resp = toolbox.http.request({
        method: 'GET',
        url: 'https://openapi.qoder.sh/api/v1/deviceToken/poll?nonce=' + encodeURIComponent(pending.nonce)
          + '&verifier=' + encodeURIComponent(pending.verifier)
          + '&challenge_method=S256',
      })
      if (resp.status === 404) {
        return { done: false }
      }
      if (resp.status < 200 || resp.status >= 300) {
        return { done: false }
      }
      var body = objectOf(parseBody(resp))
      var token = trim(body.token)
      if (!token) {
        return { done: false }
      }
      var user = qoderUserOf(token)
      return {
        done: true,
        token: token,
        email: user.email,
        name: user.name,
        meta: { refreshToken: trim(body.refresh_token), userId: trim(body.user_id) },
      }
    },
  },

  minimax: {
    kind: 'poll',
    intervalMs: 2000,
    prepare: function (pending) {
      pending.verifier = base64UrlOf(randomBytes(32))
      pending.challenge = pkceChallengeOf(pending.verifier)
      var resp = toolbox.http.request({
        method: 'POST',
        url: MINIMAX_HOST + '/oauth2/device/code',
        headers: minimaxFormHeaders(),
        body: formBodyOf({
          client_id: MINIMAX_CLIENT_ID,
          scope: MINIMAX_SCOPE,
          audience: MINIMAX_AUDIENCE,
          code_challenge: pending.challenge,
          code_challenge_method: 'S256',
        }),
      })
      var body = objectOf(readBody(resp, 'MiniMax 设备码'))
      pending.deviceCode = trim(body.device_code)
      pending.userCode = trim(body.user_code)
      pending.verificationUri = trim(body.verification_uri_complete || body.verification_uri)
      if (!pending.deviceCode) {
        throw new Error('MiniMax 没有返回 device_code')
      }
      // interval 单位是秒；轮询由前端定时器驱动，这里换算成毫秒
      var interval = Number(body.interval)
      if (isFinite(interval) && interval > 0) {
        pending.intervalMs = Math.max(1000, Math.round(interval * 1000))
      }
      var expiresIn = Number(body.expires_in)
      if (isFinite(expiresIn) && expiresIn > 0) {
        pending.expiresAt = Date.now() + expiresIn * 1000
      }
    },
    buildAuthUrl: function (pending) {
      return pending.verificationUri
    },
    poll: function (pending) {
      var resp = toolbox.http.request({
        method: 'POST',
        url: MINIMAX_HOST + '/oauth2/token',
        headers: minimaxFormHeaders(),
        body: formBodyOf({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: pending.deviceCode,
          client_id: MINIMAX_CLIENT_ID,
          code_verifier: pending.verifier,
        }),
      })
      var body = objectOf(parseBody(resp))
      var status = trim(body.status)
      var error = trim(body.error)
      // ⚠️ MiniMax 用 200 + status=pending 表达「还在等」，标准形态是
      // 400 + error=authorization_pending —— 两种都必须认，否则用户来不及授权
      if (status === 'pending' || error === 'authorization_pending' || error === 'slow_down') {
        return { done: false }
      }
      if (error === 'access_denied' || error === 'authorization_denied') {
        throw new Error('MiniMax 授权被拒绝')
      }
      var token = trim(body.access_token)
      if (!token) {
        if (resp.status >= 400) {
          throw new Error(trim(body.error_description) || error || 'MiniMax 授权失败')
        }
        return { done: false }
      }
      var scope = trim(body.scope)
      // 客户端权威实现要求 scope 含 agent.default，不含即视为无效凭据
      if (scope && scope.split(/\s+/).indexOf(MINIMAX_SCOPE) < 0) {
        throw new Error('MiniMax 令牌的 scope 不含 ' + MINIMAX_SCOPE)
      }
      return {
        done: true,
        token: token,
        email: '',
        name: claimsLabel(token),
        meta: {
          refreshToken: trim(body.refresh_token),
          expiresIn: trim(body.expires_in),
        },
      }
    },
  },

  cline: {
    kind: 'poll',
    intervalMs: 5000,
    prepare: function (pending) {
      var resp = toolbox.http.request({
        method: 'POST',
        url: CLINE_WORKOS_BASE + '/user_management/authorize/device',
        headers: minimaxFormHeaders(),
        body: formBodyOf({ client_id: CLINE_WORKOS_CLIENT_ID }),
      })
      var body = objectOf(readBody(resp, 'Cline 设备码'))
      pending.deviceCode = trim(body.device_code)
      pending.userCode = trim(body.user_code)
      pending.verificationUri = trim(body.verification_uri_complete || body.verification_uri)
      if (!pending.deviceCode || !pending.userCode || !pending.verificationUri) {
        throw new Error('Cline 设备码响应缺少必要字段')
      }
      var interval = Number(body.interval)
      if (isFinite(interval) && interval > 0) {
        pending.intervalMs = Math.max(1000, Math.round(interval * 1000))
      }
      var expiresIn = Number(body.expires_in)
      if (isFinite(expiresIn) && expiresIn > 0) {
        pending.expiresAt = Date.now() + expiresIn * 1000
      }
    },
    buildAuthUrl: function (pending) {
      return pending.verificationUri
    },
    poll: function (pending) {
      var resp = toolbox.http.request({
        method: 'POST',
        url: CLINE_WORKOS_BASE + '/user_management/authenticate',
        headers: minimaxFormHeaders(),
        body: formBodyOf({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: pending.deviceCode,
          client_id: CLINE_WORKOS_CLIENT_ID,
        }),
      })
      var body = objectOf(parseBody(resp))
      var error = trim(body.error)
      // authorization_pending 不是错误：用户还没在浏览器里点授权
      if (error === 'authorization_pending' || error === 'slow_down') {
        return { done: false }
      }
      if (error === 'access_denied' || error === 'expired_token' || error === 'invalid_grant') {
        throw new Error(trim(body.error_description) || 'Cline 授权失败')
      }
      var workosToken = trim(body.access_token)
      var workosRefresh = trim(body.refresh_token)
      if (!workosToken) {
        if (resp.status >= 400) {
          throw new Error(trim(body.error_description) || 'Cline 授权失败')
        }
        return { done: false }
      }

      // 第二步：用 WorkOS 令牌换 Cline 自己的令牌（字段是驼峰）
      var registered = requestJSONOK('POST', CLINE_API_BASE + '/api/v1/auth/register',
        clineRegisterHeaders(), { accessToken: workosToken, refreshToken: workosRefresh }, 'Cline 令牌注册')
      var inner = objectOf(registered.data)
      if (!hasKeys(inner)) {
        inner = registered
      }
      var token = clineBearerOf(trim(inner.accessToken || inner.access_token) || workosToken)
      if (!token) {
        throw new Error('Cline 没有返回访问令牌')
      }
      var userInfo = objectOf(inner.userInfo)
      var accountId = trim(userInfo.clineUserId || userInfo.accountId || inner.accountId)
      var email = trim(userInfo.email || inner.email)
      return {
        done: true,
        token: token,
        email: email,
        name: email || accountId,
        meta: {
          refreshToken: trim(inner.refreshToken || inner.refresh_token) || workosRefresh,
          accountId: accountId,
        },
      }
    },
  },

  accio: {
    kind: 'code',
    callbackPath: '/callback',
    intervalMs: 800,
    prepare: function (pending) {
      // ⚠️ verifier 是 48 字节的 base64url（官方客户端同款），不是 32
      pending.verifier = base64UrlOf(randomBytes(48))
      pending.challenge = pkceChallengeOf(pending.verifier)
      pending.state = hexOf(randomBytes(32))
      pending.redirectUri = oauthCallbackUrlOf('/callback')
    },
    buildAuthUrl: function (pending) {
      // 参数缺一不可：少了 code_challenge 会被登录页判成 legacy 客户端，
      // 弹「请升级客户端」且回调永不到达
      return ACCIO_LOGIN_BASE + '/login?' + [
        'return_url=' + encodeURIComponent(pending.redirectUri),
        'state=' + encodeURIComponent(pending.state),
        'code_challenge=' + encodeURIComponent(pending.challenge),
        'code_challenge_method=S256',
        'client_id=' + ACCIO_CLIENT_ID,
        'ttid=' + encodeURIComponent('ttid_' + hexOf(randomBytes(16))),
        'language=zh',
      ].join('&')
    },
    finish: function (pending, params) {
      if (params.state && params.state !== pending.state) {
        throw new Error('回调 state 不匹配，请重新发起登录')
      }
      var code = trim(params.code)
      if (!code) {
        throw new Error('回调里没有授权码，请重新发起登录')
      }
      var body = requestJSONOK('POST', ACCIO_GATEWAY + '/api/oauth/token', accioHeaders(), {
        code: code,
        codeVerifier: pending.verifier,
        clientId: ACCIO_CLIENT_ID,
        redirectUri: pending.redirectUri,
      }, 'Accio 授权')
      if (body.success !== true) {
        throw new Error(trim(body.message || body.error) || 'Accio 授权失败')
      }
      var data = objectOf(body.data)
      var token = trim(data.accessToken)
      if (!token) {
        throw new Error('Accio 没有返回 accessToken')
      }
      var expiresAt = Number(data.expiresAt)
      return {
        token: token,
        email: '',
        name: claimsLabel(token),
        meta: {
          refreshToken: trim(data.refreshToken),
          // 服务端给的可能是秒级时间戳，统一成毫秒字符串
          expiresAt: isFinite(expiresAt) && expiresAt > 0
            ? String(expiresAt > 1000000000000 ? expiresAt : expiresAt * 1000)
            : '',
          sgcookie: trim(data.sgcookie),
        },
      }
    },
  },

  lobsterai: {
    kind: 'code',
    callbackPath: '/auth/callback',
    intervalMs: 800,
    prepare: function (pending) {
      pending.state = hexOf(randomBytes(16))
      // uuid / firstKeyfrom 贯穿账号生命周期：exchange 时要提交，续期时原样回传
      pending.uuid = uuidV4()
      pending.firstKeyfrom = String(Date.now())
      pending.version = lobsteraiClientVersion()
      // ⚠️ portal 会校验 redirect_uri 的形态，必须是 127.0.0.1:port/auth/callback
      pending.callbackUrl = 'http://127.0.0.1:' + OAUTH_CALLBACK_PORT + '/auth/callback'
    },
    buildAuthUrl: function (pending) {
      return LOBSTERAI_PORTAL_BASE + '/portal#/login?'
        + 'source=electron'
        + '&redirect_uri=' + encodeURIComponent(pending.callbackUrl)
        + '&state=' + encodeURIComponent(pending.state)
    },
    finish: function (pending, params) {
      if (params.state !== pending.state) {
        throw new Error('回调 state 不匹配，请重新发起登录')
      }
      var code = trim(params.code)
      if (!code) {
        throw new Error('回调里没有授权码，请重新发起登录')
      }
      var resp = toolbox.http.request({
        method: 'POST',
        url: LOBSTERAI_API_BASE + '/api/auth/exchange',
        // 换 token 时还没有令牌，故不带 Authorization
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': LOBSTERAI_USER_AGENT,
        },
        body: JSON.stringify({
          authCode: code,
          firstKeyfrom: pending.firstKeyfrom,
          latestKeyfrom: String(Date.now()),
          uuid: pending.uuid,
          version: pending.version,
        }),
      })
      var envelope = lobsteraiEnvelopeOf(readBody(resp, 'LobsterAI 授权'))
      if (!envelope.ok) {
        throw new Error('LobsterAI 授权失败：' + envelope.message)
      }
      var data = envelope.data
      var token = trim(data.accessToken)
      if (!token) {
        throw new Error('LobsterAI 没有返回 accessToken')
      }
      var expiresIn = Number(data.expiresIn)
      return {
        token: token,
        email: '',
        name: trim(data.nickname) || claimsLabel(token),
        meta: {
          refreshToken: trim(data.refreshToken),
          // 续期要用这三个身份字段，必须随账号一起落库
          uuid: pending.uuid,
          firstKeyfrom: pending.firstKeyfrom,
          latestKeyfrom: String(Date.now()),
          version: pending.version,
          userId: trim(data.accountUserId || data.yid),
          expiresAt: isFinite(expiresIn) && expiresIn > 0
            ? String(Date.now() + expiresIn * 1000)
            : '',
        },
      }
    },
  },

  raccoon: {
    kind: 'poll',
    intervalMs: 2000,
    prepare: function (pending) {
      // 扫码 code 由客户端本地生成（32 位 hex）：服务端只按它记录扫码结果，
      // 故完全绕开官方那条 `office-raccoon://` 自定义协议回调
      pending.qrCode = hexOf(randomBytes(16))
      pending.authUrl = RACCOON_API_BASE + '/login/mp?'
        + 'code=' + encodeURIComponent(pending.qrCode)
        + '&appname=' + encodeURIComponent('商汤小浣熊官网')
    },
    buildAuthUrl: function (pending) {
      return pending.authUrl
    },
    poll: function (pending) {
      var resp = toolbox.http.request({
        method: 'POST',
        url: RACCOON_API_BASE + RACCOON_AUTH_PREFIX + '/login_with_qrcode_code',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ qrcode_code: pending.qrCode }),
      })
      var envelope = raccoonEnvelopeOf(parseBody(resp))
      // 任何异常都按「继续等」处理：2 秒一次的轮询不该被偶发失败打断
      if (!envelope.ok) {
        return { done: false }
      }
      var status = trim(envelope.data.status)
      if (status === 'canceled') {
        throw new Error('扫码登录已取消')
      }
      if (status !== 'success') {
        return { done: false }
      }
      var token = trim(envelope.data.access_token)
      // 缺 token 的 success 视为未完成，否则会产出空凭据并卡死流程
      if (!token) {
        return { done: false }
      }
      var claims = jwtClaims(token) || {}
      var exp = Number(claims.exp)
      return {
        done: true,
        token: token,
        email: '',
        name: claimsLabel(token),
        meta: {
          refreshToken: trim(envelope.data.refresh_token),
          expiresAt: isFinite(exp) && exp > 0 ? String(exp * 1000) : '',
        },
      }
    },
  },

  loomy: {
    kind: 'poll',
    intervalMs: 1500,
    prepare: function (pending) {
      var opened = loomyWechatUuidOf(hexOf(randomBytes(16)))
      pending.wechatUuid = opened.uuid
      pending.authUrl = opened.authUrl
      pending.wechatLast = ''
      if (!pending.wechatUuid) {
        throw new Error('没能从微信授权页取到二维码，请重试')
      }
    },
    buildAuthUrl: function (pending) {
      return pending.authUrl
    },
    poll: function (pending) {
      // ⚠️ 这是微信侧的长轮询（约 25 秒才返回），由前端定时器驱动
      var result = loomyWechatPollOnce(pending.wechatUuid, pending.wechatLast)
      pending.wechatLast = result.errcode
      if (result.errcode === '403') {
        throw new Error('微信登录已取消')
      }
      // 405 才是「已确认」，code 就在这一帧；404 只是「已扫码待确认」
      if (result.errcode !== '405' || !result.code) {
        return { done: false }
      }

      var bind = loomyAccountPost('/login/thirdAccount/bind/auth',
        { tcode: { code: result.code }, type: 'wx' }, 'Loomy 微信授权')
      var rcode = trim(bind.rcode)
      if (!rcode) {
        throw new Error('Loomy 微信授权响应缺少 rcode')
      }
      // 讯飞侧已绑手机号才能直接换 session；否则需要短信表单（本插件暂无该表单）
      if (Number(bind.bind) !== 1) {
        throw new Error('该微信号还没绑定讯飞手机号，请先在 Loomy 客户端完成手机号绑定后重试')
      }
      var skipped = loomyAccountPost('/login/thirdAccount/bind/skip',
        { rcode: rcode, expire: LOOMY_SESSION_TTL_SECONDS }, 'Loomy 微信登录')
      var session = trim(skipped.session)
      var userid = trim(skipped.userid)
      if (!session) {
        throw new Error('Loomy 登录响应缺少 session')
      }
      return {
        done: true,
        token: session,
        email: '',
        name: trim(bind.nickname) || userid,
        meta: {
          userId: userid,
          // session 是登录时声明 14 天得来的，服务端不回到期时间
          expiresAt: String(Date.now() + LOOMY_SESSION_TTL_SECONDS * 1000),
        },
      }
    },
  },

  kiro: {
    kind: 'code',
    callbackPath: '/oauth/callback',
    intervalMs: 600,
    prepare: function (pending) {
      pending.state = base64UrlOf(randomBytes(24))
      pending.verifier = base64UrlOf(randomBytes(24))
      pending.challenge = pkceChallengeOf(pending.verifier)
      pending.redirectUri = oauthCallbackUrlOf('/oauth/callback')
    },
    buildAuthUrl: function (pending) {
      return 'https://app.kiro.dev/signin?' + [
        'state=' + encodeURIComponent(pending.state),
        'code_challenge=' + encodeURIComponent(pending.challenge),
        'code_challenge_method=S256',
        'redirect_uri=' + encodeURIComponent(pending.redirectUri),
        'redirect_from=KiroIDE',
      ].join('&')
    },
    finish: function (pending, params) {
      if (params.state !== pending.state) {
        throw new Error('回调 state 不匹配，请重新发起登录')
      }
      var code = trim(params.code)
      if (!code) {
        throw new Error('回调里没有授权码，请重新发起登录')
      }
      // 换 token 时的 redirect_uri 必须和授权时完全一致（含 login_option）
      var option = trim(params.login_option || params.loginOption)
      var redirect = pending.redirectUri + (option ? '?login_option=' + encodeURIComponent(option) : '')
      var body = requestJSONOK('POST', 'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token', {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      }, { code: code, code_verifier: pending.verifier, redirect_uri: redirect }, 'Kiro 授权')

      var data = unwrapData(body)
      var token = pickText(data, ['accessToken', 'access_token', 'token', 'idToken', 'id_token', 'accessTokenJwt'])
      if (!token) {
        token = pickText(body, ['accessToken', 'access_token', 'token', 'idToken', 'id_token'])
      }
      if (!token) {
        throw new Error('Kiro 没有返回 accessToken')
      }
      return {
        token: token,
        email: '',
        name: '',
        meta: {
          refreshToken: pickText(data, ['refreshToken', 'refresh_token']) || pickText(body, ['refreshToken', 'refresh_token']),
          profileArn: findArn(body, 0),
        },
      }
    },
  },

  antigravity: {
    kind: 'code',
    callbackPath: '/oauth-callback',
    intervalMs: 800,
    prepare: function (pending) {
      pending.state = uuidV4()
      pending.redirectUri = oauthCallbackUrlOf('/oauth-callback')
    },
    buildAuthUrl: function (pending) {
      return 'https://accounts.google.com/o/oauth2/v2/auth?' + [
        'client_id=' + encodeURIComponent(ANTIGRAVITY_CLIENT_ID),
        'redirect_uri=' + encodeURIComponent(pending.redirectUri),
        'response_type=code',
        'scope=' + encodeURIComponent(ANTIGRAVITY_SCOPES),
        'access_type=offline',
        'prompt=consent',
        'state=' + encodeURIComponent(pending.state),
      ].join('&')
    },
    finish: function (pending, params) {
      if (params.state !== pending.state) {
        throw new Error('回调 state 不匹配，请重新发起登录')
      }
      var code = trim(params.code)
      if (!code) {
        throw new Error('回调里没有授权码，请重新发起登录')
      }
      var form = [
        'client_id=' + encodeURIComponent(ANTIGRAVITY_CLIENT_ID),
        'client_secret=' + encodeURIComponent(ANTIGRAVITY_CLIENT_SECRET),
        'code=' + encodeURIComponent(code),
        'redirect_uri=' + encodeURIComponent(pending.redirectUri),
        'grant_type=authorization_code',
      ].join('&')
      var body = requestJSONOK('POST', 'https://oauth2.googleapis.com/token', {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      }, form, 'Google 授权')
      var token = trim(body.access_token)
      if (!token) {
        throw new Error('Google 没有返回 access_token')
      }
      var user = googleUserOf(token)
      return {
        token: token,
        email: user.email,
        name: user.name,
        meta: {
          refreshToken: trim(body.refresh_token),
          expiresIn: trim(body.expires_in),
        },
      }
    },
  },

  trae: {
    kind: 'code',
    callbackPath: '/authorize',
    intervalMs: 800,
    prepare: function (pending) {
      // 设备指纹持久化复用：随机值会被服务端当成异常客户端
      pending.machineId = traeDeviceCredential('machine_id')
      pending.deviceId = traeDeviceCredential('device_id')
      pending.loginTraceId = traeTraceIdOf(pending.machineId, pending.deviceId)
      pending.verifier = base64UrlOf(randomBytes(48))
      pending.challenge = pkceChallengeOf(pending.verifier)
      // sourceId 由 startFlowLogin 写入：trae 与 trae-cn 共用这套流程，只有区域不同
      pending.cn = pending.sourceId === 'trae-cn'
      pending.loginHost = traeLoginHost(pending.loginTraceId, pending.sourceId)
      // CN 登录页只认 127.0.0.1:18080（国际版没有这个限制）
      pending.callbackHost = pending.cn ? '127.0.0.1' : OAUTH_LOCAL_HOST
      pending.callbackPort = pending.cn ? TRAE_CN_CALLBACK_PORT : OAUTH_CALLBACK_PORT
      pending.callbackUrl = oauthCallbackUrlOf('/authorize', pending.callbackPort, pending.callbackHost)
    },
    buildAuthUrl: function (pending) {
      var host = pending.loginHost.indexOf('http') === 0 ? pending.loginHost : 'https://' + pending.loginHost
      host = host.replace(/\/+$/, '')
      // CN 用 CN 客户端的 client_id / 版本号；x_* 伪装也照 CN 客户端（macOS 形态）
      var clientId = pending.cn ? TRAE_CN_CLIENT_ID : TRAE_CLIENT_ID
      var pluginVersion = pending.cn ? TRAE_CN_PLUGIN_VERSION : TRAE_PLUGIN_VERSION
      var appVersion = pending.cn ? TRAE_CN_IDE_VERSION : TRAE_IDE_VERSION
      return host + '/authorization?' + [
        'login_version=1',
        // 通道名是 solo（不是产品名）：决定走哪条授权分支
        'auth_from=solo',
        'login_channel=native_ide',
        'plugin_version=' + encodeURIComponent(pluginVersion),
        'auth_type=local',
        'client_id=' + encodeURIComponent(clientId),
        'redirect=0',
        'login_trace_id=' + encodeURIComponent(pending.loginTraceId),
        'auth_callback_url=' + encodeURIComponent(pending.callbackUrl),
        // 主参数与 x_* 伪装头必须一致，否则设备指纹自相矛盾
        'machine_id=' + encodeURIComponent(pending.machineId),
        'device_id=' + encodeURIComponent(pending.deviceId),
        'x_device_id=' + encodeURIComponent(pending.deviceId),
        'x_machine_id=' + encodeURIComponent(pending.machineId),
        'x_device_brand=' + encodeURIComponent(pending.cn ? 'Apple' : 'PC'),
        'x_device_type=PC',
        'x_os_version=' + encodeURIComponent(pending.cn ? 'macOS 15.7.4' : '1.0'),
        'x_app_version=' + encodeURIComponent(appVersion),
        'x_app_type=stable',
        // ⚠️ 刻意**不带** code_challenge：带上会让授权页走 PKCE 新流程，
        // 回调只返 authCodeInfo（老流程才直接回 refreshToken + userInfo）。
        // 参考实现按 auth_type=local + 不带 PKCE 跑通，这里对齐它。
      ].join('&')
    },
    finish: function (pending, params) {
      var cn = Boolean(pending.cn)
      var clientId = cn ? TRAE_CN_CLIENT_ID : TRAE_CLIENT_ID
      var ideVersion = cn ? TRAE_CN_IDE_VERSION : TRAE_IDE_VERSION

      // 回调有三种形态，必须都认（参考实现只认第一种，PKCE 那条会直接报错）：
      //   1. 老流程直传：?refreshToken=...&userInfo={...}&userJwt={...}
      //   2. 新流程 PKCE：?authCodeInfo={"code":"..."} 或 ?code=...
      //   3. 只给 userJwt.Token（没有 refreshToken 时的兜底）
      var userInfo = jsonParamOf(params.userInfo)
      var userJwt = jsonParamOf(params.userJwt)
      var authCodeInfo = jsonParamOf(params.authCodeInfo)

      var refreshToken = firstNonEmptyOf([
        firstParam(params, ['refreshToken', 'refresh_token', 'RefreshToken', 'refresh-token']),
        jsonTextOf(userJwt, 'RefreshToken'),
      ])
      var accessToken = jsonTextOf(userJwt, 'Token')
      var authCode = firstNonEmptyOf([
        firstParam(params, ['authCode', 'auth_code', 'AuthCode', 'authorization_code', 'code']),
        jsonTextOf(authCodeInfo, 'code'),
        jsonTextOf(authCodeInfo, 'authCode'),
        // authCodeInfo 也可能是纯 code 字符串（不是 JSON）
        authCodeInfo ? '' : trim(params.authCodeInfo),
      ])

      var loginHost = firstParam(params, ['loginHost', 'login_host', 'LoginHost', 'host', 'consoleHost'])
        || pending.loginHost
      var exchanged = null
      if (refreshToken) {
        exchanged = traeExchange(loginHost, {
          ClientID: clientId,
          RefreshToken: refreshToken,
          ClientSecret: '-',
          UserID: '',
        })
      }
      else if (authCode) {
        exchanged = traeExchange(loginHost, {
          ClientID: clientId,
          AuthCode: authCode,
          CodeVerifier: pending.verifier,
          IDEVersion: ideVersion,
          DeviceInfo: {
            DeviceID: '0',
            MachineID: pending.loginTraceId,
            PlatformCode: 'IDE_PC',
            DeviceType: 'PC',
            DeviceName: 'PC',
            ClientVersion: ideVersion,
            DevicePublicKey: '',
            DeviceBrand: '',
            DeviceCPU: '',
            OSInfo: '',
            OSVersion: '',
          },
        })
      }
      else if (accessToken) {
        // 老流程的兜底：回调直接把 access token 带回来了，不用再换一次
        exchanged = { token: accessToken, refreshToken: '', loginHost: pending.loginHost }
      }
      else {
        // 把收到的参数名带出来：下次再遇到别的形态，一眼能看出缺的是什么
        throw new Error('回调里没有 refreshToken / accessToken / code（收到的参数：'
          + (Object.keys(objectOf(params)).join('、') || '无') + '），请重新发起登录')
      }

      var user = traeUserOf(exchanged.loginHost, exchanged.token)
      var nickname = jsonTextOf(userInfo, 'ScreenName')
      var uid = jsonTextOf(userInfo, 'UserID')
      // ⚠️ 回调里字段名是 TenantID，不是 EnterpriseID
      var tenantId = jsonTextOf(userInfo, 'TenantID')
      return {
        token: exchanged.token,
        email: user.email,
        name: user.name || nickname || (uid ? 'Trae ' + uid.slice(-4) : ''),
        meta: {
          loginHost: exchanged.loginHost,
          refreshToken: exchanged.refreshToken || refreshToken,
          userId: user.userId || uid,
          enterpriseId: tenantId,
        },
      }
    },
  },
}

/**
 * Gemini 与 Antigravity 是同一套 Google 授权（同 client / 同 scope / 同回调路径），
 * 差别只在余量接口，故直接复用流程对象，不重复写一遍。
 */
OAUTH_FLOWS.gemini = OAUTH_FLOWS.antigravity

/**
 * Trae 国内版与国标版共用同一套流程：登录域名在 prepare 里按 `pending.sourceId`
 * 选区域（国内先问 www.trae.cn，国际先问 www.trae.ai），故直接复用同一个对象。
 */
OAUTH_FLOWS['trae-cn'] = OAUTH_FLOWS.trae

// ------------------------------------------------------------ 回调服务与轮询

var oauthServerRunning = false
/** 当前回调服务实际监听的端口（Trae CN 要 18080，其余默认 18765） */
var oauthServerPort = 0
/** 回调到达时记下 path 与参数；oauthPoll 取走一次 */
var oauthCallback = null

function htmlPage(text) {
  return '<meta charset="utf-8"><p>' + text + '</p>'
}

/**
 * 起本地回调服务（或换到指定端口）。
 *
 * 宿主每个插件只能开一个本地服务，而 Trae CN 的登录页只认
 * `127.0.0.1:18080`，其余渠道用默认 18765 —— 故端口不一致时先停再起。
 * 同一时刻只会有一次登录在等回调，切换不会丢消息。
 */
function ensureOAuthServer(port) {
  var target = port || OAUTH_CALLBACK_PORT
  if (oauthServerRunning && oauthServerPort === target) {
    return
  }
  if (oauthServerRunning) {
    if (toolbox.server && typeof toolbox.server.stop === 'function') {
      try {
        toolbox.server.stop()
      }
      catch (e) {
        toolbox.log('[oauth] 停掉旧回调服务失败：' + String(e && e.message ? e.message : e))
      }
    }
    oauthServerRunning = false
  }
  toolbox.server.onRequest(function (req) {
    var path = req.path || '/'
    var pending = pendingLogin
    var headers = { 'Content-Type': 'text/html; charset=utf-8' }
    if (!pending || !pending.callbackPath) {
      return { status: 404, headers: headers, body: htmlPage('没有进行中的登录') }
    }
    if (path !== pending.callbackPath) {
      return { status: 404, headers: headers, body: htmlPage('not found') }
    }
    oauthCallback = { path: path, params: parseQueryString(req.query || '') }
    return { status: 200, headers: headers, body: htmlPage('登录成功，回到工具箱继续。') }
  })
  try {
    toolbox.server.start(target)
  }
  catch (e) {
    // 18080 也是 Trae 客户端自己登录时占用的端口，撞上时给一句人话
    if (target === TRAE_CN_CALLBACK_PORT) {
      throw new Error('本地回调端口 18080 被占用（Trae 客户端登录时也会用它），'
        + '请先关掉 Trae 里的登录窗口再重试')
    }
    throw e
  }
  oauthServerPort = target
  oauthServerRunning = true
}

/** 起一次渠道登录：准备好会话，返回授权页地址 */
function startFlowLogin(sourceId, flow) {
  oauthCallback = null
  var pending = {
    loginId: newSessionId(),
    sourceId: sourceId,
    flow: flow,
    kind: flow.kind,
    callbackPath: flow.callbackPath || '',
    intervalMs: flow.intervalMs || 1000,
    expiresAt: Date.now() + (flow.ttlMs || OAUTH_FLOW_TTL_MS),
  }
  // 先 prepare 再起服务：prepare 里才知道这个渠道要哪个回调端口
  if (flow.prepare) {
    flow.prepare(pending)
  }
  ensureOAuthServer(pending.callbackPort)
  pendingLogin = pending

  var result = {
    loginId: pending.loginId,
    kind: pending.kind,
    authUrl: flow.buildAuthUrl(pending),
    expiresIn: Math.max(1, Math.floor((pending.expiresAt - Date.now()) / 1000)),
    intervalMs: pending.intervalMs,
    callbackUrl: pending.callbackPath
      ? oauthCallbackUrlOf(pending.callbackPath, pending.callbackPort, pending.callbackHost)
      : '',
  }
  if (pending.userCode) {
    result.userCode = pending.userCode
    result.verificationUri = pending.verificationUri || result.authUrl
  }
  return result
}

/**
 * 网页登录拿到的附加凭据（refreshToken / profileArn / loginHost）。
 * 导入接口只提交 token，这些字段在导入时按 token 认领，只保留最近几条。
 */
var loginMetaCache = []

function rememberLoginMeta(token, meta) {
  if (!token || !hasKeys(meta)) {
    return
  }
  for (var i = loginMetaCache.length - 1; i >= 0; i--) {
    if (loginMetaCache[i].token === token) {
      loginMetaCache.splice(i, 1)
    }
  }
  loginMetaCache.push({ token: token, meta: meta })
  while (loginMetaCache.length > 20) {
    loginMetaCache.shift()
  }
}

/** 认领并清掉缓存：同一条凭据只落库一次 */
function takeLoginMeta(token) {
  for (var i = loginMetaCache.length - 1; i >= 0; i--) {
    if (loginMetaCache[i].token === token) {
      var meta = loginMetaCache[i].meta
      loginMetaCache.splice(i, 1)
      return meta
    }
  }
  return {}
}

/** 登录成功后统一收尾：查一次余量，组装返回 */
function finishLoginResult(source, data) {
  var token = trim(data && data.token)
  if (!token) {
    throw new Error('登录失败：没有拿到凭据')
  }
  var meta = objectOf(data.meta)
  var claims = jwtClaims(token) || {}
  var result = {
    done: true,
    token: token,
    email: trim(data.email) || trim(claims.email),
    name: trim(data.name) || trim(claims.name || claims.nickname) || claimsLabel(token),
    meta: meta,
    quota: null,
  }
  rememberLoginMeta(token, meta)
  if (source) {
    try {
      result.quota = queryQuota(source, { token: token, meta: meta })
    }
    catch (e) {
      toolbox.log('[oauthPoll] 余量查询失败：' + (e && e.message ? e.message : String(e)))
    }
  }
  return result
}

/** 轮询一次渠道登录：poll 直接问服务端，code / implicit 等本地回调 */
function completeFlowLogin(pending) {
  var flow = pending.flow
  var data = null

  if (flow.kind === 'poll') {
    data = flow.poll(pending)
    if (!data || !data.done) {
      return { done: false }
    }
  }
  else {
    if (!oauthCallback) {
      return { done: false }
    }
    var callback = oauthCallback
    oauthCallback = null
    if (callback.params.error) {
      throw new Error(trim(callback.params.error_description) || trim(callback.params.error) || '授权被拒绝')
    }
    data = flow.finish(pending, callback.params)
  }

  var source = sourceOf(pending.sourceId)
  pendingLogin = null
  return finishLoginResult(source, data)
}

/**
 * 登录流程里取账号信息：GET /v2/plugin/login/account?state=...
 *
 * 尽力而为：账号信息可能还没就绪（服务端回 12151），此时返回 null 由调用方
 * 退回 JWT 声明里的昵称。Goja 里没有事件循环，不能在这里等待重试。
 */
function fetchBuddyAccount(source, state, token) {
  try {
    var resp = toolbox.http.request({
      method: 'GET',
      url: source.api + '/v2/plugin/login/account?state=' + encodeURIComponent(state),
      headers: buddyHeaders(source, token, null, { noUserId: true, noEnterpriseId: true }),
    })
    if (resp.status < 200 || resp.status >= 300) {
      return null
    }
    var payload = parseBody(resp)
    var code = payload && payload.code !== undefined && payload.code !== null ? String(payload.code) : '0'
    if (code !== '0' && code !== '200') {
      return null
    }
    var data = objectOf(payload && payload.data)
    return {
      uid: trim(data.uid),
      nickname: trim(data.nickname),
      enterpriseId: trim(data.enterpriseId),
      accountType: trim(data.type),
    }
  }
  catch (e) {
    return null
  }
}

/**
 * 登录成功后的收尾：取账号信息 + 组装持久化用的 meta。
 *
 * meta 是这条链路的续期凭据：
 *   refreshToken   静默续期用（auth/token/refresh 的 X-Refresh-Token）
 *   expiresAt      绝对过期时间（毫秒），用于判断何时该续
 *   userId         控制面请求的 X-User-Id
 *   enterpriseId   企业账号的 X-Enterprise-Id / X-Tenant-Id
 * 任一字段缺失都不影响登录本身，只是对应能力退化。
 */
function buddyLoginOf(source, state, token, data) {
  var account = fetchBuddyAccount(source, state, token)
  var meta = {}
  var refreshToken = trim(data.refreshToken || data.refresh_token)
  if (refreshToken) {
    meta.refreshToken = refreshToken
  }
  var expiresAt = buddyExpiresAtOf(token, data.expiresIn || data.expires_in)
  if (expiresAt > 0) {
    meta.expiresAt = expiresAt
  }
  var userId = (account && account.uid) || claimsUid(token)
  if (userId) {
    meta.userId = userId
  }
  if (account && account.nickname) {
    meta.nickname = account.nickname
  }
  if (account && account.enterpriseId) {
    meta.enterpriseId = account.enterpriseId
  }
  if (account && account.accountType) {
    meta.accountType = account.accountType
  }
  return { meta: meta, nickname: account ? account.nickname : '' }
}

/** 发起网页登录：取一次 state 与授权页地址 */
toolbox.handler('oauthStart', function (input) {
  var sourceId = trim(input && input.source)
  var source = sourceOf(sourceId)
  if (!source) {
    throw new Error('请先选择账号来源')
  }
  if (!source.capabilities || !source.capabilities.oauth) {
    throw new Error('该来源不支持网页登录，请改用「粘贴 Token」或从本地登录态导入')
  }

  var flow = OAUTH_FLOWS[sourceId]
  if (flow) {
    return startFlowLogin(sourceId, flow)
  }

  var resp = toolbox.http.request({
    method: 'POST',
    url: source.api + '/v2/plugin/auth/state?platform=ide',
    // 身份标识要跟来源一致：缺 X-Domain / UA 时服务端按宿主默认身份处理
    headers: anonHeadersOf(source),
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

  // 渠道自定义流程（implicit / code / poll）
  if (pendingLogin.flow) {
    try {
      return completeFlowLogin(pendingLogin)
    }
    catch (e) {
      pendingLogin = null
      oauthCallback = null
      throw e
    }
  }

  var source = sourceOf(pendingLogin.sourceId)
  if (!source) {
    throw new Error('登录来源已失效，请重新发起')
  }

  // CodeBuddy 系：平台侧轮询通道
  var identity = buddyIdentity(source)
  var resp = toolbox.http.request({
    method: 'GET',
    url: source.api + '/v2/plugin/auth/token?state=' + encodeURIComponent(pendingLogin.state),
    headers: anonHeadersOf(source),
  })
  var body = objectOf(readBody(resp, 'auth/token'))
  var code = Number(body.code)
  var msg = trim(body.msg || body.message)

  // 11217 = token 尚未就绪：明确属于「继续等」，不能当成失败
  if (identity && code === CODE_TOKEN_NOT_READY) {
    return { done: false }
  }

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
  var state = pendingLogin.state
  pendingLogin = null

  // 登录成功后再取一次账号信息（uid / 昵称 / 企业 ID）：余量与企业鉴权都要用，
  // 而 auth/token 只给令牌。取不到不影响登录，昵称退回 JWT 声明。
  var login = identity ? buddyLoginOf(source, state, token, data) : null
  return finishLoginResult(source, {
    token: token,
    email: trim(data.email || data.mail),
    // 响应没带名字时退到 token 里的 JWT 声明，避免界面只能显示 token
    name: trim(data.nickname || data.name) || (login ? login.nickname : ''),
    meta: login ? login.meta : undefined,
  })
})

/** 取消进行中的登录：用户关掉浏览器页签后用它解锁按钮 */
toolbox.handler('cancelLogin', function () {
  var had = pendingLogin !== null
  pendingLogin = null
  oauthCallback = null
  return { cancelled: had }
})

/** 不落库地预览一个 token 的账号信息与余量，供导入前确认 */
toolbox.handler('previewToken', function (input) {
  var sourceId = trim(input && input.source)
  var source = sourceOf(sourceId)
  if (!source) {
    throw new Error('请先选择账号来源')
  }
  var token = trim(input && input.token)
  if (!token) {
    throw new Error('缺少 token')
  }

  var quota = null
  try {
    quota = queryQuota(source, { token: token, meta: {} })
  }
  catch (e) {
    quota = null
    toolbox.log('[previewToken] 余量查询失败：' + (e && e.message ? e.message : String(e)))
  }
  return {
    name: claimsLabel(token),
    quota: quota,
  }
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

/**
 * 剥离 IDEA 会话里的 uid 前缀，只保留 JWT 本体。
 * IDEA 存的是 "<uid>+eyJhbGci..."，直接用会把前缀算进 token。
 */
function normalizeIdeaToken(raw) {
  var text = trim(raw)
  if (!text) {
    return ''
  }
  var plus = text.indexOf('+')
  if (plus >= 0) {
    text = trim(text.slice(plus + 1))
  }
  var head = text.indexOf('eyJ')
  if (head > 0) {
    text = text.slice(head)
  }
  return trim(text)
}

/** 会话 JSON 里取 access token：auth.accessToken 最干净，其次 token，最后 accessToken */
function tokenFromSession(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return ''
  }
  var auth = parsed.auth && typeof parsed.auth === 'object' ? parsed.auth : {}
  var candidates = [auth.accessToken, parsed.token, parsed.accessToken]
  for (var i = 0; i < candidates.length; i++) {
    var value = normalizeIdeaToken(candidates[i])
    if (value) {
      return value
    }
  }
  return ''
}

/** 只认 CodeBuddy 系插件的键，避免把别的插件登录态也扫进来 */
function isCopilotKey(key) {
  if (AUTH_KEYS.indexOf(key) >= 0) {
    return true
  }
  return key.indexOf('coding-copilot') >= 0 || key.indexOf('planning-genie') >= 0
}

/** 从一个 secret-storage.xml 里取出 accessToken */
function tokensFromSecretStorage(xml, channel) {
  var out = []
  var re = /<Entry\s+key="([^"]+)"\s+value="([^"]*)"/g
  var match = re.exec(xml)
  while (match !== null) {
    var key = match[1]
    if (!isCopilotKey(key)) {
      match = re.exec(xml)
      continue
    }
    var raw = unescapeXml(match[2])
    var token = ''
    try {
      token = tokenFromSession(JSON.parse(raw))
    }
    catch (e) {
      token = normalizeIdeaToken(raw)
    }
    if (token.length > 20) {
      // key 要带出去：写入时靠它定位到具体那一条 Entry
      out.push({ token: token, channel: channel, key: key })
    }
    match = re.exec(xml)
  }
  return out
}

/** JetBrains 配置目录名 → 好读的产品名（界面上不出现原始目录名） */
var IDE_PRODUCT_NAMES = {
  'IntelliJIdea': 'IntelliJ IDEA',
  'PyCharm': 'PyCharm',
  'WebStorm': 'WebStorm',
  'PhpStorm': 'PhpStorm',
  'GoLand': 'GoLand',
  'RubyMine': 'RubyMine',
  'CLion': 'CLion',
  'DataGrip': 'DataGrip',
  'Rider': 'Rider',
  'AndroidStudio': 'Android Studio',
  'Aqua': 'Aqua',
  'RustRover': 'RustRover',
}

function ideaChannelLabel(dirName) {
  var text = trim(dirName)
  if (!text) {
    return 'IntelliJ 系 IDE'
  }
  for (var prefix in IDE_PRODUCT_NAMES) {
    if (text.indexOf(prefix) === 0) {
      var rest = trim(text.slice(prefix.length))
      return IDE_PRODUCT_NAMES[prefix] + (rest ? ' ' + rest : '')
    }
  }
  return text
}

// ------------------------------------------------------------ Trae（storage.json）

/**
 * 各发行版的数据目录；装了哪个就扫哪个。
 *
 * `source` 决定这个目录里的账号导入到哪个来源：国际版与国内版是两个来源
 * （登录/余量打不同站点），Solo 只是同一发行版的另一条产品线，区域不变。
 */
var TRAE_ROOTS = [
  { root: '%APPDATA%\\Trae', label: 'Trae', source: 'trae' },
  { root: '%APPDATA%\\Trae CN', label: 'Trae CN', source: 'trae-cn' },
  { root: '%APPDATA%\\Trae Solo', label: 'Trae Solo', source: 'trae' },
  { root: '%APPDATA%\\Trae CN Solo', label: 'Trae CN Solo', source: 'trae-cn' },
]

/** 单个 storage.json 超过这个量级就不碰：整文件序列化会拖住调用，也有写坏的风险 */
var TRAE_MAX_BYTES = 2 * 1024 * 1024

function traeStoragePath(root) {
  return root + '\\User\\globalStorage\\storage.json'
}

/** 是否是 Trae 的用户登录态键（排除 usertag 与设备键） */
function isTraeAuthKey(key) {
  return key.indexOf('iCubeAuthInfo://') === 0
    && key !== 'iCubeAuthInfo://usertag'
    && key.indexOf('icube-dc:') < 0
}

/** 从 storage.json 文本里取登录态 */
function traeAuthOf(text) {
  var doc = null
  try {
    doc = JSON.parse(text)
  }
  catch (e) {
    return null
  }
  if (!doc || typeof doc !== 'object') {
    return null
  }
  for (var key in doc) {
    if (!isTraeAuthKey(key)) {
      continue
    }
    var value = doc[key]
    if (!value || typeof value !== 'object') {
      continue
    }
    var token = normalizeIdeaToken(value.accessToken || value.token)
    if (!token) {
      continue
    }
    return {
      key: key,
      token: token,
      name: trim(value.email) || trim(value.userId) || claimsLabel(token),
    }
  }
  return null
}

/** 扫描本机安装的各个 Trae 发行版 */
function scanTraeAuth() {
  var out = []
  for (var i = 0; i < TRAE_ROOTS.length; i++) {
    var file = traeStoragePath(TRAE_ROOTS[i].root)
    if (!toolbox.fs.exists(file)) {
      continue
    }
    var auth = null
    try {
      auth = traeAuthOf(toolbox.fs.readText(file))
    }
    catch (e) {
      auth = null
    }
    if (!auth) {
      continue
    }
    out.push({
      kind: 'trae',
      token: auth.token,
      file: file,
      key: auth.key,
      channel: TRAE_ROOTS[i].label,
      // 前端按这个字段把国际版/国内版分别导入对应来源
      source: TRAE_ROOTS[i].source,
      // 位置所属产品：国际版与国内版各自独立的目录，不能互写
      product: TRAE_ROOTS[i].source,
      name: auth.name,
    })
  }
  return out
}

/** 把 token 写回 Trae 的 storage.json，只动凭据字段 */
function writeTraeAuth(file, token) {
  var text = toolbox.fs.readText(file)
  if (text.length > TRAE_MAX_BYTES) {
    throw new Error('storage.json 体积过大，暂不支持自动切换')
  }
  var doc = null
  try {
    doc = JSON.parse(text)
  }
  catch (e) {
    throw new Error('storage.json 不是合法 JSON，已跳过')
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error('storage.json 结构异常，已跳过')
  }

  var key = null
  for (var k in doc) {
    if (isTraeAuthKey(k) && doc[k] && typeof doc[k] === 'object') {
      key = k
      break
    }
  }
  if (!key) {
    throw new Error('storage.json 里没有登录态条目，请先在 Trae 里登录一次')
  }

  var value = doc[key]
  value.accessToken = token
  value.token = token
  doc[key] = value
  // fileName 传空串：file 本身就是文件路径
  toolbox.fs.writeAs(file, '', JSON.stringify(doc))
}

/** 扫描本机各客户端的登录态，按 token 去重 */
toolbox.handler('scanLocalAuth', function () {
  var results = []
  var seen = {}
  var skipped = []

  // JetBrains 系：options/secret-storage.xml，明文 JSON 套 XML 转义
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
        var found = tokensFromSecretStorage(xml, ideaChannelLabel(dirs[i]))
        for (var j = 0; j < found.length; j++) {
          if (seen[found[j].token]) {
            continue
          }
          seen[found[j].token] = true
          results.push({
            kind: 'jetbrains',
            token: found[j].token,
            channel: found[j].channel,
            // JetBrains 里只认 CodeBuddy 系插件的键（见 isCopilotKey），
            // 但 CN / WorkBuddy 用的是同一个键，无法从键名区分，故按「同族」处理
            product: 'codebuddy-family',
            file: file,
            key: found[j].key,
            // 优先用登录态文件里带的账号标识，其次从 token 的 JWT 声明里取
            name: trim(found[j].name) || trim(found[j].email) || claimsLabel(found[j].token),
          })
        }
      }
      catch (e) {
        // 读不了的目录直接跳过，不影响其它渠道
      }
    }
  }

  // VSCode 系（CodeBuddy / 国内版 / WorkBuddy）：state.vscdb 里的加密 secret，
  // 解密与 SQL 都在宿主侧，这里只拿明文 token
  try {
    var targets = toolbox.agentAuth.list() || []
    for (var k = 0; k < targets.length; k++) {
      var target = targets[k] || {}
      var targetId = trim(target.id)
      if (!targetId) {
        continue
      }
      var token = ''
      try {
        token = trim(toolbox.agentAuth.read(targetId))
      }
      catch (e) {
        toolbox.log('[scanLocalAuth] 读取 ' + targetId + ' 失败：' + (e && e.message ? e.message : String(e)))
        continue
      }
      if (!token || seen[token]) {
        continue
      }
      seen[token] = true
      results.push({
        // 宿主会说明这个位置是什么形态：vscode / zed 等
        kind: trim(target.kind) || 'vscode',
        id: targetId,
        token: token,
        channel: trim(target.label) || targetId,
        // 宿主给了所属产品（codebuddy / cursor / qoder …），前端据此只列同产品的位置
        product: trim(target.product),
        name: claimsLabel(token),
      })
    }
  }
  catch (e) {
    // 宿主版本偏旧或未授权时静默跳过，不影响 XML 那部分
    toolbox.log('[scanLocalAuth] 客户端登录态不可用：' + (e && e.message ? e.message : String(e)))
  }

  // Trae：登录态在 storage.json，由插件直接读写
  try {
    var traeList = scanTraeAuth()
    for (var t = 0; t < traeList.length; t++) {
      if (seen[traeList[t].token]) {
        continue
      }
      seen[traeList[t].token] = true
      results.push(traeList[t])
    }
  }
  catch (e) {
    toolbox.log('[scanLocalAuth] Trae 登录态读取失败：' + (e && e.message ? e.message : String(e)))
  }

  // Codex：登录态是明文 JSON，插件直接读
  try {
    var codex = scanCodexAuth()
    if (codex && !seen[codex.token]) {
      seen[codex.token] = true
      results.push(codex)
    }
  }
  catch (e) {
    toolbox.log('[scanLocalAuth] Codex 登录态读取失败：' + (e && e.message ? e.message : String(e)))
  }

  return { accounts: results, pending: skipped }
})

// ------------------------------------------------------------ Codex

/** Codex 把 token 写在 ~/.codex/auth.json */
var CODEX_AUTH_FILE = '%USERPROFILE%\\.codex\\auth.json'

function scanCodexAuth() {
  if (!toolbox.fs.exists(CODEX_AUTH_FILE)) {
    return null
  }
  var doc = null
  try {
    doc = JSON.parse(toolbox.fs.readText(CODEX_AUTH_FILE))
  }
  catch (e) {
    return null
  }
  if (!doc || typeof doc !== 'object') {
    return null
  }
  var tokens = objectOf(doc.tokens)
  var token = trim(tokens.access_token) || trim(doc.OPENAI_API_KEY)
  if (!token) {
    return null
  }
  // id_token 是 JWT，里面有邮箱；access_token 是不透明串
  var claims = jwtClaims(trim(tokens.id_token)) || {}
  return {
    kind: 'codex',
    token: token,
    file: CODEX_AUTH_FILE,
    channel: 'Codex',
    name: trim(claims.email) || trim(claims.name) || '',
  }
}

/** 扫 JetBrains 各版本，返回 IDEA 当前登录的 token（已 normalize） */
function scanCurrentIdeaToken() {
  var roots = ['%APPDATA%\\JetBrains', '%LOCALAPPDATA%\\JetBrains']
  for (var r = 0; r < roots.length; r++) {
    var dirs = []
    try {
      dirs = toolbox.fs.list(roots[r]) || []
    }
    catch (e) {
      dirs = []
    }
    for (var i = 0; i < dirs.length; i++) {
      var file = roots[r] + '\\' + dirs[i] + '\\options\\secret-storage.xml'
      if (!toolbox.fs.exists(file)) {
        continue
      }
      try {
        var found = tokensFromSecretStorage(toolbox.fs.readText(file), '')
        if (found.length > 0) {
          return found[0].token
        }
      }
      catch (e) {
        // 读不了就跳过，不影响其它版本
      }
    }
  }
  return ''
}

/** 当前 IDEA 登录 token 的短缓存：stateSnapshot 调用频繁，不值得每次都读盘 */
var ideaTokenCache = { at: 0, token: '' }

function currentIdeaToken() {
  var now = new Date().getTime()
  if (ideaTokenCache.at > 0 && now - ideaTokenCache.at < 1500) {
    return ideaTokenCache.token
  }
  var token = ''
  try {
    token = scanCurrentIdeaToken()
  }
  catch (e) {
    token = ''
  }
  ideaTokenCache = { at: now, token: token }
  return token
}

/** 写入后让缓存失效，下次读到的就是新值 */
function invalidateIdeaTokenCache() {
  ideaTokenCache = { at: 0, token: '' }
}

// ------------------------------------------------------------ 写入登录态

/** 反向转义：写回 XML 属性值 */
function escapeXml(text) {
  return String(text)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&apos;')
}

/**
 * 在 IDEA 已有会话上改写凭据字段。
 *
 * 结构遵循 IDEA 侧插件的会话格式：
 * - token 与 accessToken 是 "<uid>+<jwt>"，插件按前缀区分用户
 * - auth.accessToken 是纯 jwt
 * - account 里放 uid / label 等展示信息
 *
 * 只在已有会话上改，保留插件自己写的其它字段。
 */
function buildIdeaSession(existingRaw, token) {
  var session = null
  if (existingRaw) {
    try {
      var parsed = JSON.parse(existingRaw)
      if (parsed && typeof parsed === 'object') {
        session = parsed
      }
    }
    catch (e) {
      session = null
    }
  }
  if (!session) {
    session = {}
  }

  var auth = session.auth && typeof session.auth === 'object' ? session.auth : {}
  var account = session.account && typeof session.account === 'object' ? session.account : {}
  // uid 优先沿用原来的，其次问 JWT 要
  var uid = trim(account.uid || account.id) || trim(auth.uid) || claimsUid(token)
  var packed = uid ? uid + '+' + token : token
  var now = new Date().getTime()

  session.token = packed
  session.accessToken = packed
  if (!session.refreshToken) {
    session.refreshToken = ''
  }
  if (!session.domain) {
    session.domain = ''
  }

  auth.accessToken = token
  if (!auth.refreshToken) {
    auth.refreshToken = ''
  }
  if (!auth.tokenType) {
    auth.tokenType = 'Bearer'
  }
  if (!auth.expiresAt) {
    auth.expiresAt = 0
  }
  if (!auth.expiresIn) {
    auth.expiresIn = auth.expiresAt
  }
  auth.lastRefreshTime = now
  session.auth = auth

  if (uid) {
    account.id = uid
    account.uid = uid
  }
  var label = claimsLabel(token)
  if (label) {
    account.label = label
    if (!account.nickname) {
      account.nickname = label
    }
  }
  account.lastLogin = true
  session.account = account

  return JSON.stringify(session)
}

/**
 * 把 token 写进 secret-storage.xml 里指定的 Entry。
 * 用字符串定位而不是正则：键名里有 `.` 和 `-`，构造正则容易误匹配。
 * value 是转义过的会话 JSON，这里整体改写成 IDEA 认的结构后写回。
 */
function writeTokenToXml(xml, key, token) {
  var text = String(xml)
  var marker = 'key="' + key + '"'
  var at = text.indexOf(marker)
  if (at < 0) {
    throw new Error('登录态文件里没有找到键 ' + key)
  }
  var valueAt = text.indexOf('value="', at)
  if (valueAt < 0) {
    throw new Error('登录态条目不完整：' + key)
  }
  var start = valueAt + 'value="'.length
  var end = text.indexOf('"', start)
  if (end < 0) {
    throw new Error('登录态条目不完整：' + key)
  }

  var existing = ''
  try {
    existing = unescapeXml(text.slice(start, end))
  }
  catch (e) {
    existing = ''
  }
  var encoded = escapeXml(buildIdeaSession(existing, token))
  return text.slice(0, start) + encoded + text.slice(end)
}

/** 记住这个账号要应用到哪些位置（只存选择，不写文件） */
toolbox.handler('setTargets', function (input) {
  var id = trim(input && input.id)
  var targets = (input && input.targets) || []
  var list = loadAccounts()
  var account = findAccount(list, id)
  if (!account) {
    throw new Error('账号不存在')
  }
  account.targets = targets
  account.updatedAt = nowISO()
  saveAccounts(list)
  return stateSnapshot()
})

/**
 * 登录态位置与账号是否属于同一产品。
 *
 * 位置上的 `product` 由扫描给出（VSCode 系来自宿主，Trae 来自发行版目录）；
 * 老数据没有该字段时放行，避免升级后旧勾选突然失效。
 * `codebuddy-family` 是 JetBrains 的归并值：插件键名无法区分 CodeBuddy / CN / WorkBuddy。
 */
function targetMatchesProduct(target, sourceId) {
  var product = trim(target && target.product)
  if (!product) {
    return true
  }
  if (product === sourceId) {
    return true
  }
  if (product === 'codebuddy-family') {
    return sourceId === 'codebuddy' || sourceId === 'codebuddy-cn' || sourceId === 'workbuddy'
  }
  return false
}

/** 把账号的 token 写入勾选的登录态位置 */
toolbox.handler('applyAccount', function (input) {
  var id = trim(input && input.id)
  var list = loadAccounts()
  var account = findAccount(list, id)
  if (!account) {
    throw new Error('账号不存在')
  }
  var targets = (input && input.targets) || account.targets || []
  if (!targets.length) {
    throw new Error('没有选择要应用的登录态位置')
  }

  var results = []
  var applied = []
  for (var i = 0; i < targets.length; i++) {
    var target = targets[i] || {}
    var kind = trim(target.kind)
    var channel = trim(target.channel)

    // 位置必须和账号属于同一产品：老版本允许把 Token 写进任意应用，
    // 会把一个产品的令牌塞进另一个应用的登录态里（写坏对方登录态）。
    if (!targetMatchesProduct(target, account.source)) {
      results.push({
        kind: kind,
        channel: channel,
        ok: false,
        error: '该位置属于其他产品，已跳过',
      })
      continue
    }

    // VSCode 系：加密与 SQL 都在宿主侧，这里只传 token
    if (kind === 'vscode') {
      var vscodeId = trim(target.id)
      if (!vscodeId) {
        results.push({ kind: kind, channel: channel, ok: false, error: '位置信息不完整' })
        continue
      }
      try {
        var label = toolbox.agentAuth.write(vscodeId, account.token)
        results.push({ kind: kind, id: vscodeId, channel: label || channel, ok: true })
        applied.push({ kind: 'vscode', id: vscodeId, channel: label || channel })
      }
      catch (e) {
        var vscodeMessage = e && e.message ? e.message : String(e)
        toolbox.log('[applyAccount] 写入 ' + vscodeId + ' 失败：' + vscodeMessage)
        results.push({ kind: kind, id: vscodeId, channel: channel, ok: false, error: vscodeMessage })
      }
      continue
    }

    // Trae：改 storage.json 里的凭据字段
    if (kind === 'trae') {
      var traeFile = trim(target.file)
      if (!traeFile) {
        results.push({ kind: kind, channel: channel, ok: false, error: '位置信息不完整' })
        continue
      }
      try {
        writeTraeAuth(traeFile, account.token)
        results.push({ kind: kind, file: traeFile, channel: channel, ok: true })
        applied.push({ kind: 'trae', file: traeFile, channel: channel })
      }
      catch (e) {
        var traeMessage = e && e.message ? e.message : String(e)
        toolbox.log('[applyAccount] 写入 Trae 失败 ' + traeFile + '：' + traeMessage)
        results.push({ kind: kind, file: traeFile, channel: channel, ok: false, error: traeMessage })
      }
      continue
    }

    // Zed / Codex 的登录态是客户端自有结构，只支持导入查看
    if (kind === 'zed' || kind === 'codex') {
      results.push({
        kind: kind,
        channel: channel,
        ok: false,
        error: '该客户端登录态暂不支持自动切换，只能导入查看',
      })
      continue
    }

    // JetBrains 系：改 secret-storage.xml
    var file = trim(target.file)
    var key = trim(target.key)
    if (!file || !key) {
      results.push({ file: file, key: key, channel: channel, ok: false, error: '位置信息不完整' })
      continue
    }
    try {
      var next = writeTokenToXml(toolbox.fs.readText(file), key, account.token)
      // fileName 传空串：file 本身就是文件路径
      toolbox.fs.writeAs(file, '', next)
      results.push({ kind: 'jetbrains', file: file, key: key, channel: channel, ok: true })
      applied.push({ kind: 'jetbrains', file: file, key: key, channel: channel })
    }
    catch (e) {
      var ideaMessage = e && e.message ? e.message : String(e)
      toolbox.log('[applyAccount] 写入失败 ' + file + '：' + ideaMessage)
      results.push({ kind: 'jetbrains', file: file, key: key, channel: channel, ok: false, error: ideaMessage })
    }
  }

  if (applied.length > 0) {
    account.targets = applied
    account.updatedAt = nowISO()
    saveAccounts(list)
    // 刚写过文件，缓存要失效，否则卡片上的「IDEA 当前」还是旧账号
    invalidateIdeaTokenCache()
  }

  return { results: results, state: stateSnapshot() }
})
