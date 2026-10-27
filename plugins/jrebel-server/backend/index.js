/**
 * JRebel 激活服务：在 127.0.0.1 上跑一个 JRebel License Server。
 *
 * 协议实现参照 yu-xiaoyao/jrebel-license-active-server：
 *   POST /{guid}/jrebel/leases        发放 lease（核心）
 *   POST /{guid}/agent/leases         同上（新客户端走这条）
 *   POST /{guid}/jrebel/leases/1      简化版 lease
 *   POST /{guid}/jrebel/validate-connection  连接校验
 *   GET  /                            首页，方便用浏览器确认服务在跑
 *
 * 只用 ES5 语法：后端跑在 goja 里，没有 Node 生态，也没有模块系统。
 */

var SERVER_GUID = 'a1b4aea8-b031-4302-b602-670a990272cb'
var CHARSET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'
var EMAIL_DOMAINS = ['example.com', 'mail.com', 'test.com', 'inbox.com']

// JRebel 官方（同 yu-xiaoyao 项目）的签名私钥：SHA1 with RSA，仅用于 leases 签名。
var PRIVATE_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIICdgIBADANBgkqhkiG9w0BAQEFAASCAmAwggJcAgEAAoGBAND3cI/pKMSd4OLMIXU/8xoEZ/nz',
  'a+g00Vy7ygyGB1Nn83qpro7tckOvUVILJoN0pKw8J3E8rtjhSyr9849qzaQKBhxFL+J5uu08QVn/',
  'tMt+Tf0cu5MSPOjT8I2+NWyBZ6H0FjOcVrEUMvHt8sqoJDrDU4pJyex2rCOlpfBeqK6XAgMBAAEC',
  'gYBM5C+8FIxWxM1CRuCs1yop0aM82vBC0mSTXdo7/3lknGSAJz2/A+o+s50Vtlqmll4drkjJJw4j',
  'acsR974OcLtXzQrZ0G1ohCM55lC3kehNEbgQdBpagOHbsFa4miKnlYys537Wp+Q61mhGM1weXzos',
  'gCH/7e/FjJ5uS6DhQc0Y+QJBAP43hlSSEo1BbuanFfp55yK2Y503ti3Rgf1SbE+JbUvIIRsvB24x',
  'Ha1/IZ+ttkAuIbOUomLN7fyyEYLWphIy9kUCQQDSbqmxZaJNRa1o4ozGRORxR2KBqVn3EVISXqNc',
  'UH3gAP52U9LcnmA3NMSZs8tzXhUhYkWQ75Q6umXvvDm4XZ0rAkBoymyWGeyJy8oyS/fUW0G63mIr',
  'oZZ4Rp+F098P3j9ueJ2k/frbImXwabJrhwjUZe/Afel+PxL2ElUDkQW+BMHdAkEAk/U7W4Aanjpf',
  's1+Xm9DUztFicciheRa0njXspvvxhY8tXAWUPYseG7L+iRPh+Twtn0t5nm7VynVFN0shSoCIAQJA',
  'Ljo7A6bzsvfnJpV+lQiOqD/WCw3A2yPwe+1d0X/13fQkgzcbB3K0K81Euo/fkKKiBv0A7yR7wvrN',
  'jzefE9sKUw==',
  '-----END PRIVATE KEY-----',
].join('\n')

var DEFAULTS = {
  port: 12345,
  autoStart: true,
  offlineDays: 30,
  email: '',
}

// ------------------------------------------------------------ 配置

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

function normalizeConfig(raw) {
  var next = {}
  for (var key in DEFAULTS) {
    next[key] = (raw && raw[key] !== undefined) ? raw[key] : DEFAULTS[key]
  }
  next.port = Number(next.port) || DEFAULTS.port
  next.offlineDays = Math.min(180, Math.max(1, Number(next.offlineDays) || DEFAULTS.offlineDays))
  next.autoStart = Boolean(next.autoStart)
  next.email = String(next.email || '')
  return next
}

var config = normalizeConfig(readJSON('config', null))

// 激活地址里的 UUID：生成一次就固定，重装/重启后地址不变
var uuid = String(readJSON('uuid', '') || '')
if (!uuid) {
  uuid = newUuid()
  writeJSON('uuid', uuid)
}
if (!config.email) {
  config.email = newEmail()
  writeJSON('config', config)
}

function saveConfig() {
  config = normalizeConfig(config)
  writeJSON('config', config)
}

// ------------------------------------------------------------ 随机

function randomInt(max) {
  return Math.floor(Math.random() * max)
}

function randomFrom(chars, count) {
  var out = ''
  for (var i = 0; i < count; i++) {
    out += chars.charAt(randomInt(chars.length))
  }
  return out
}

function newUuid() {
  var hex = '0123456789abcdef'
  var groups = [8, 4, 4, 4, 12]
  var parts = []
  for (var g = 0; g < groups.length; g++) {
    parts.push(randomFrom(hex, groups[g]))
  }
  return parts.join('-')
}

function newEmail() {
  var name = 'user' + randomFrom(CHARSET.toLowerCase(), 6)
  var domain = EMAIL_DOMAINS[randomInt(EMAIL_DOMAINS.length)]
  return name + '@' + domain
}

/** JRebel 要求 11 位随机 + 结尾一个 '='，共 12 字符 */
function newServerRandomness() {
  return randomFrom(CHARSET, 11) + '='
}

// ------------------------------------------------------------ 协议

function endsWith(text, suffix) {
  return text.length >= suffix.length && text.indexOf(suffix, text.length - suffix.length) !== -1
}

/** application/x-www-form-urlencoded → 对象 */
function parseForm(body) {
  var out = {}
  if (!body) {
    return out
  }
  var pairs = String(body).split('&')
  for (var i = 0; i < pairs.length; i++) {
    if (!pairs[i]) {
      continue
    }
    var index = pairs[i].indexOf('=')
    var key = index < 0 ? pairs[i] : pairs[i].substring(0, index)
    var value = index < 0 ? '' : pairs[i].substring(index + 1)
    out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '))
  }
  return out
}

function jsonResponse(payload) {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  }
}

function resolveOffline(params) {
  if (params.product === 'XRebel') {
    return false
  }
  return String(params.offline) === 'true'
}

function leaseSignature(clientRandomness, serverRandomness, guid, offline, validFrom, validUntil) {
  var data = offline
    ? clientRandomness + ';' + serverRandomness + ';' + guid + ';' + offline + ';' + validFrom + ';' + validUntil
    : clientRandomness + ';' + serverRandomness + ';' + guid + ';' + offline
  return toolbox.crypto.sign({ algorithm: 'RSA-SHA1', key: PRIVATE_KEY, data: data })
}

function handleLeases(params) {
  var clientRandomness = params.randomness || ''
  var username = params.username || ''
  var guid = params.guid || ''
  if (!clientRandomness || !username || !guid) {
    return { status: 403, headers: { 'Content-Type': 'text/plain' }, body: '' }
  }

  var offline = resolveOffline(params)
  var validFromNum = 0
  var validUntilNum = 0
  var validFrom = ''
  var validUntil = ''
  if (offline) {
    var startTime = parseInt(params.clientTime, 10)
    if (isNaN(startTime)) {
      startTime = Math.floor(new Date().getTime() / 1000) * 1000
    }
    var offlineDays = parseInt(params.offlineDays, 10)
    if (isNaN(offlineDays)) {
      offlineDays = config.offlineDays
    }
    var expireTime = startTime + offlineDays * 24 * 60 * 60 * 1000
    validFromNum = startTime
    validUntilNum = expireTime
    validFrom = params.clientTime || String(startTime)
    validUntil = String(expireTime)
  }

  var serverRandomness = newServerRandomness()
  var signature = leaseSignature(clientRandomness, serverRandomness, guid, offline, validFrom, validUntil)

  return jsonResponse({
    serverVersion: '3.2.4',
    serverProtocolVersion: '1.1',
    serverGuid: SERVER_GUID,
    groupType: 'managed',
    id: 1,
    licenseType: 1,
    evaluationLicense: false,
    signature: signature,
    serverRandomness: serverRandomness,
    seatPoolType: 'standalone',
    statusCode: 'SUCCESS',
    offline: offline,
    validFrom: offline ? validFromNum : null,
    validUntil: offline ? validUntilNum : null,
    company: username,
    orderId: '',
    zeroIds: [],
    licenseValidFrom: 1490544001000,
    licenseValidUntil: 1891839999000,
  })
}

function handleLeases1(params) {
  var payload = {
    serverVersion: '3.2.4',
    serverProtocolVersion: '1.1',
    serverGuid: SERVER_GUID,
    groupType: 'managed',
    statusCode: 'SUCCESS',
    msg: null,
    statusMessage: null,
    signature: 'dGVzdA==',
  }
  if (params.username) {
    payload.company = params.username
  }
  return jsonResponse(payload)
}

function validateJson() {
  return {
    serverVersion: '3.2.4',
    serverProtocolVersion: '1.1',
    serverGuid: SERVER_GUID,
    groupType: 'managed',
    statusCode: 'SUCCESS',
    company: 'Administrator',
    canGetLease: true,
    licenseType: 1,
    evaluationLicense: false,
    seatPoolType: 'standalone',
  }
}

function indexHtml() {
  var running = toolbox.server.status()
  var url = activationUrl(running.port)
  return [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">',
    '<title>JRebel License Server</title>',
    '<style>body{font-family:Segoe UI,Tahoma,sans-serif;background:#f5f7fa;color:#333;padding:32px}',
    '.card{max-width:720px;margin:0 auto;background:#fff;border-radius:10px;padding:28px;',
    'box-shadow:0 4px 16px rgba(0,0,0,.08)}h1{color:#4a6bff;font-size:22px;margin-top:0}',
    '.url{display:block;margin:12px 0;padding:12px;background:#f0f2f7;border-radius:6px;',
    'word-break:break-all;font-family:Consolas,monospace}</style></head><body><div class="card">',
    '<h1>JRebel License Server</h1><p>服务运行正常，端口 <b>' + String(running.port) + '</b>。</p>',
    '<p>JRebel 2018.1 及之后版本的激活地址（邮箱任意填写）：</p>',
    '<span class="url">' + url + '</span>',
    '</div></body></html>',
  ].join('')
}

// ------------------------------------------------------------ 路由

toolbox.server.onRequest(function (req) {
  var path = req.path || ''
  if (path === '/' || path === '') {
    return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: indexHtml() }
  }
  if (endsWith(path, '/jrebel/validate-connection')) {
    return jsonResponse(validateJson())
  }
  if (endsWith(path, '/jrebel/leases/1') || endsWith(path, '/agent/leases/1')) {
    return handleLeases1(parseForm(req.body))
  }
  if (endsWith(path, '/jrebel/leases') || endsWith(path, '/agent/leases')) {
    return handleLeases(parseForm(req.body))
  }
  // /{uuid} 之类：返回首页，方便浏览器里确认
  return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: indexHtml() }
})

// ------------------------------------------------------------ 宿主 handler

function activationUrl(port) {
  return 'http://localhost:' + String(port) + '/' + uuid
}

function snapshot() {
  var running = toolbox.server.status()
  return {
    running: running.running,
    port: running.running ? running.port : config.port,
    config: config,
    uuid: uuid,
    activationUrl: activationUrl(running.running ? running.port : config.port),
  }
}

toolbox.handler('status', function () {
  return snapshot()
})

toolbox.handler('start', function () {
  try {
    var started = toolbox.server.start(config.port)
    return { ok: true, port: started.port }
  }
  catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
})

toolbox.handler('stop', function () {
  toolbox.server.stop()
  return { ok: true }
})

toolbox.handler('save', function (input) {
  var wasRunning = toolbox.server.status().running
  config.port = Number(input && input.port) || config.port
  config.offlineDays = Number(input && input.offlineDays) || config.offlineDays
  if (input && input.autoStart !== undefined) {
    config.autoStart = Boolean(input.autoStart)
  }
  saveConfig()

  // 端口变了且正在运行：按新配置重启，否则用户会以为改了没生效
  if (wasRunning) {
    toolbox.server.stop()
    try {
      toolbox.server.start(config.port)
    }
    catch (e) {
      toolbox.log('按新端口重启失败: ' + String(e))
    }
  }
  return snapshot()
})

toolbox.handler('logs', function (input) {
  var since = (input && Number(input.since)) || 0
  return toolbox.server.logs({ since: since })
})

toolbox.handler('regenerateEmail', function () {
  config.email = newEmail()
  saveConfig()
  return { email: config.email }
})

toolbox.handler('regenerateUuid', function () {
  uuid = newUuid()
  writeJSON('uuid', uuid)
  return { uuid: uuid, activationUrl: snapshot().activationUrl }
})

// ------------------------------------------------------------ 启动

// 「跟随应用启动」：插件在应用启动时加载，这里直接起服务即可
if (config.autoStart) {
  try {
    toolbox.server.start(config.port)
    toolbox.log('JRebel 激活服务已随应用启动，端口 ' + String(config.port))
  }
  catch (e) {
    toolbox.log('JRebel 激活服务自动启动失败: ' + String(e))
  }
}
