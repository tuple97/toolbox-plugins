/**
 * 插件清单协议（插件仓库侧的权威校验实现）。
 *
 * 与宿主 app/internal/plugin/manifest.go 一一对应：
 * 同一个清单必须在两侧得到相同的结论，否则会出现
 * 「构建通过、安装被拒」或反过来的情况。
 *
 * 主程序不允许只依赖插件源码仓库的目录结构来安装插件，插件仓库也不允许
 * 产出宿主不认识的清单。schema/manifest.schema.json 是同一份协议的
 * 机器可读描述，供编辑器补全与第三方工具使用。
 */

import { isValidVersion, parseConstraint, satisfies } from './semver.mjs'

/** 当前清单格式版本 */
export const MANIFEST_VERSION = 1

/** 宿主提供的插件 API 版本 */
export const PLUGIN_API_VERSION = '1.0.0'

const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
const TOOL_TYPE_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/
const PUBLISHER_RE = /^[a-z0-9][a-z0-9-]*$/
const HANDLER_RE = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/

const LIMITS = {
  id: 128,
  name: 64,
  description: 512,
  contributions: 64,
  dependencies: 64,
  exports: 64,
}

/** 允许出现在清单里的顶层字段 */
const KNOWN_FIELDS = new Set([
  'manifestVersion', 'id', 'name', 'version', 'publisher', 'description',
  'author', 'homepage', 'license', 'icon', 'keywords',
  'engines', 'dependencies', 'permissions', 'runtime', 'contributes',
])

/** 清单校验失败 */
export class ManifestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ManifestError'
  }
}

function fail(message) {
  throw new ManifestError(message)
}

/**
 * 校验清单对象。
 *
 * @param {unknown} manifest 已解析的清单
 * @param {{ where?: string }} [context] 出错时用于定位的信息
 * @returns {object} 同一个清单对象（便于链式使用）
 */
export function validateManifest(manifest, context = {}) {
  const where = context.where ? `${context.where}: ` : ''
  const bad = (message) => fail(`${where}${message}`)

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    bad('清单必须是 JSON 对象')
  }

  // 未知字段必须暴露：清单是信任输入，拼写错误不能被静默忽略
  for (const key of Object.keys(manifest)) {
    if (!KNOWN_FIELDS.has(key)) {
      bad(`未知字段 ${key}`)
    }
  }

  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    bad(`不支持的清单格式版本: ${JSON.stringify(manifest.manifestVersion)}（当前支持 ${MANIFEST_VERSION}）`)
  }
  if (typeof manifest.id !== 'string' || manifest.id === '') {
    bad('缺少 id')
  }
  if (manifest.id.length > LIMITS.id) {
    bad(`id 过长（> ${LIMITS.id}）`)
  }
  if (!ID_RE.test(manifest.id)) {
    bad(`id 非法（需为反向域名风格，如 com.example.hello）: ${JSON.stringify(manifest.id)}`)
  }
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    bad('缺少 name')
  }
  if ([...manifest.name].length > LIMITS.name) {
    bad(`name 过长（> ${LIMITS.name} 字符）`)
  }
  if (typeof manifest.version !== 'string' || !isValidVersion(manifest.version)) {
    bad(`版本号非法: ${JSON.stringify(manifest.version)}`)
  }
  if (typeof manifest.publisher !== 'string' || manifest.publisher === '') {
    bad('缺少 publisher')
  }
  if (!PUBLISHER_RE.test(manifest.publisher)) {
    bad(`publisher 非法（小写字母数字与连字符）: ${JSON.stringify(manifest.publisher)}`)
  }
  if (manifest.description !== undefined) {
    if (typeof manifest.description !== 'string') {
      bad('description 必须是字符串')
    }
    if ([...manifest.description].length > LIMITS.description) {
      bad(`description 过长（> ${LIMITS.description} 字符）`)
    }
  }

  validateEngines(manifest.engines, bad)
  validateDependencies(manifest, bad)
  validatePermissions(manifest.permissions, bad)
  validateRuntime(manifest.runtime, bad)
  validateContributions(manifest.contributes, manifest.id, bad)

  return manifest
}

function validateEngines(engines, bad) {
  if (!engines || typeof engines !== 'object') {
    bad('缺少 engines')
  }
  if (typeof engines.toolbox !== 'string' || engines.toolbox === '') {
    bad('缺少 engines.toolbox（宿主版本兼容范围）')
  }
  if (!parseConstraint(engines.toolbox)) {
    bad(`engines.toolbox 约束非法: ${JSON.stringify(engines.toolbox)}`)
  }
  if (typeof engines.pluginApi !== 'string' || engines.pluginApi === '') {
    bad('缺少 engines.pluginApi（插件 API 兼容范围）')
  }
  if (!parseConstraint(engines.pluginApi)) {
    bad(`engines.pluginApi 约束非法: ${JSON.stringify(engines.pluginApi)}`)
  }
  for (const key of Object.keys(engines)) {
    if (key !== 'toolbox' && key !== 'pluginApi') {
      bad(`engines 中存在未知字段 ${key}`)
    }
  }
}

function validateDependencies(manifest, bad) {
  const dependencies = manifest.dependencies
  if (dependencies === undefined) {
    return
  }
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    bad('dependencies 必须是对象')
  }
  const ids = Object.keys(dependencies)
  if (ids.length > LIMITS.dependencies) {
    bad(`依赖数量过多（> ${LIMITS.dependencies}）`)
  }
  for (const id of ids) {
    if (!ID_RE.test(id)) {
      bad(`依赖 id 非法: ${JSON.stringify(id)}`)
    }
    if (id === manifest.id) {
      bad(`插件不能依赖自身: ${JSON.stringify(id)}`)
    }
    if (!parseConstraint(dependencies[id])) {
      bad(`依赖 ${id} 的约束非法: ${JSON.stringify(dependencies[id])}`)
    }
  }
}

const ALLOWED_PERMISSION_FIELDS = new Set(['network', 'storage', 'db', 'events'])
const DB_CAPS = new Set(['read', 'write'])

function validatePermissions(permissions, bad) {
  if (permissions === undefined) {
    return
  }
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    bad('permissions 必须是对象')
  }
  for (const key of Object.keys(permissions)) {
    if (!ALLOWED_PERMISSION_FIELDS.has(key)) {
      bad(`permissions 中存在未实现的权限字段 ${key}（协议只保留宿主真正强制执行的能力）`)
    }
  }
  if (permissions.network !== undefined) {
    if (!Array.isArray(permissions.network)) {
      bad('permissions.network 必须是数组')
    }
    const seen = new Set()
    for (const host of permissions.network) {
      if (typeof host !== 'string' || host.trim() === '') {
        bad('permissions.network 存在空条目')
      }
      if (/[/\\]/.test(host)) {
        bad(`permissions.network 只允许主机名，不能包含路径: ${JSON.stringify(host)}`)
      }
      if (host.includes('://')) {
        bad(`permissions.network 只允许主机名，不能包含协议: ${JSON.stringify(host)}`)
      }
      if (/[\s:]/.test(host)) {
        bad(`permissions.network 不能包含端口或空格: ${JSON.stringify(host)}`)
      }
      if (host.startsWith('*.')) {
        if (host.length <= 2) {
          bad(`permissions.network 通配条目非法: ${JSON.stringify(host)}`)
        }
      }
      else if (host.includes('*')) {
        bad(`permissions.network 只支持 *. 前缀通配: ${JSON.stringify(host)}`)
      }
      const key = host.toLowerCase()
      if (seen.has(key)) {
        bad(`permissions.network 条目重复: ${JSON.stringify(host)}`)
      }
      seen.add(key)
    }
  }
  if (permissions.storage !== undefined && typeof permissions.storage !== 'boolean') {
    bad('permissions.storage 必须是布尔值')
  }
  if (permissions.events !== undefined && typeof permissions.events !== 'boolean') {
    bad('permissions.events 必须是布尔值')
  }
  if (permissions.db !== undefined) {
    if (!Array.isArray(permissions.db)) {
      bad('permissions.db 必须是数组')
    }
    const seen = new Set()
    for (const capability of permissions.db) {
      if (typeof capability !== 'string' || !DB_CAPS.has(capability.toLowerCase())) {
        bad(`permissions.db 取值非法（仅支持 read / write）: ${JSON.stringify(capability)}`)
      }
      const key = capability.toLowerCase()
      if (seen.has(key)) {
        bad(`permissions.db 重复声明: ${JSON.stringify(capability)}`)
      }
      seen.add(key)
    }
  }
}

const ALLOWED_RUNTIME_FIELDS = new Set(['backend', 'entry', 'frontend', 'exports'])

function validateRuntime(runtime, bad) {
  if (runtime === undefined) {
    return
  }
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    bad('runtime 必须是对象')
  }
  for (const key of Object.keys(runtime)) {
    if (!ALLOWED_RUNTIME_FIELDS.has(key)) {
      bad(`runtime 中存在未知字段 ${key}`)
    }
  }

  const backend = runtime.backend === undefined ? 'js' : runtime.backend
  if (backend !== 'js' && backend !== 'none') {
    bad(`runtime.backend 非法（仅支持 js / none）: ${JSON.stringify(runtime.backend)}`)
  }
  if (runtime.entry !== undefined && backend === 'none') {
    bad('runtime.backend = none 时不允许声明 runtime.entry')
  }
  for (const key of ['entry', 'frontend']) {
    if (runtime[key] !== undefined) {
      validateRelPath(runtime[key], `runtime.${key}`, bad)
    }
  }
  if (runtime.exports !== undefined) {
    if (!Array.isArray(runtime.exports)) {
      bad('runtime.exports 必须是数组')
    }
    if (runtime.exports.length > LIMITS.exports) {
      bad(`runtime.exports 数量过多（> ${LIMITS.exports}）`)
    }
    if (runtime.exports.length > 0 && backend !== 'js') {
      bad('只有 runtime.backend = js 的插件才能声明 runtime.exports')
    }
    const seen = new Set()
    for (const name of runtime.exports) {
      if (typeof name !== 'string' || !HANDLER_RE.test(name)) {
        bad(`runtime.exports 中的 handler 名非法: ${JSON.stringify(name)}`)
      }
      if (seen.has(name)) {
        bad(`runtime.exports 中 handler 名重复: ${JSON.stringify(name)}`)
      }
      seen.add(name)
    }
  }
}

const ALLOWED_CONTRIBUTION_FIELDS = new Set([
  'sidebar', 'tools', 'commands', 'settings', 'settingsPanels', 'mcp',
])
const SETTING_TYPES = new Set(['string', 'number', 'boolean', 'select', 'json'])

function validateContributions(contributes, pluginId, bad) {
  if (contributes === undefined) {
    return
  }
  if (!contributes || typeof contributes !== 'object' || Array.isArray(contributes)) {
    bad('contributes 必须是对象')
  }
  for (const key of Object.keys(contributes)) {
    if (!ALLOWED_CONTRIBUTION_FIELDS.has(key)) {
      bad(`contributes 中存在未知字段 ${key}`)
    }
  }

  const groups = contributes.sidebar?.groups ?? []
  if (!Array.isArray(groups)) {
    bad('contributes.sidebar.groups 必须是数组')
  }
  const groupIds = new Set()
  for (const group of groups) {
    if (!group || typeof group !== 'object') {
      bad('contributes.sidebar.groups 的元素必须是对象')
    }
    if (typeof group.id !== 'string' || group.id === '') {
      bad('侧栏分组缺少 id')
    }
    if (groupIds.has(group.id)) {
      bad(`侧栏分组 id 重复: ${JSON.stringify(group.id)}`)
    }
    groupIds.add(group.id)
  }
  if (contributes.sidebar !== undefined) {
    for (const key of Object.keys(contributes.sidebar)) {
      if (key !== 'groups') {
        bad(`contributes.sidebar 中存在未知字段 ${key}`)
      }
    }
  }

  const tools = contributes.tools ?? []
  if (!Array.isArray(tools)) {
    bad('contributes.tools 必须是数组')
  }
  const toolTypes = new Set()
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      bad('contributes.tools 的元素必须是对象')
    }
    if (typeof tool.type !== 'string' || !TOOL_TYPE_RE.test(tool.type)) {
      bad(`工具类型非法（小写字母数字与连字符）: ${JSON.stringify(tool.type)}`)
    }
    if (toolTypes.has(tool.type)) {
      bad(`工具类型重复: ${JSON.stringify(tool.type)}`)
    }
    toolTypes.add(tool.type)
    if (typeof tool.label !== 'string' || tool.label === '') {
      bad(`工具 ${tool.type} 缺少 label`)
    }
    // 声明了分组表时，工具的 group 必须引用其中的 id —— 避免
    // 「一处用 id、一处用展示名」两套事实并存
    if (tool.group !== undefined && groupIds.size > 0 && !groupIds.has(tool.group)) {
      bad(`工具 ${tool.type} 的 group=${JSON.stringify(tool.group)} 未在 contributes.sidebar.groups 中声明`)
    }
  }

  const commands = contributes.commands ?? []
  if (!Array.isArray(commands)) {
    bad('contributes.commands 必须是数组')
  }
  const commandIds = new Set()
  for (const command of commands) {
    if (!command || typeof command !== 'object' || typeof command.id !== 'string' || command.id === '') {
      bad('contributes.commands 的元素必须带 id')
    }
    if (!command.id.startsWith(`${pluginId}.`) || command.id.length <= pluginId.length + 1) {
      bad(`命令 id 必须以插件 id 为前缀（形如 ${pluginId}.命令名）: ${JSON.stringify(command.id)}`)
    }
    if (commandIds.has(command.id)) {
      bad(`命令 id 重复: ${JSON.stringify(command.id)}`)
    }
    commandIds.add(command.id)
  }

  const settings = contributes.settings ?? []
  if (!Array.isArray(settings)) {
    bad('contributes.settings 必须是数组')
  }
  const settingKeys = new Set()
  for (const setting of settings) {
    if (!setting || typeof setting !== 'object' || typeof setting.key !== 'string' || setting.key === '') {
      bad('contributes.settings 的元素必须带 key')
    }
    if (settingKeys.has(setting.key)) {
      bad(`配置项 key 重复: ${JSON.stringify(setting.key)}`)
    }
    settingKeys.add(setting.key)
    if (!SETTING_TYPES.has(setting.type)) {
      bad(`配置项 ${setting.key} 的类型非法: ${JSON.stringify(setting.type)}`)
    }
    if (setting.type === 'select' && (!Array.isArray(setting.options) || setting.options.length === 0)) {
      bad(`配置项 ${setting.key} 是 select 类型，必须提供 options`)
    }
    if (typeof setting.title !== 'string' || setting.title === '') {
      bad(`配置项 ${setting.key} 缺少 title`)
    }
  }

  const panels = contributes.settingsPanels ?? []
  if (!Array.isArray(panels)) {
    bad('contributes.settingsPanels 必须是数组')
  }
  const panelIds = new Set()
  for (const panel of panels) {
    if (!panel || typeof panel !== 'object' || typeof panel.id !== 'string' || panel.id === '') {
      bad('contributes.settingsPanels 的元素必须带 id')
    }
    if (panelIds.has(panel.id)) {
      bad(`设置面板 id 重复: ${JSON.stringify(panel.id)}`)
    }
    panelIds.add(panel.id)
  }

  const mcpTools = contributes.mcp?.tools ?? []
  if (!Array.isArray(mcpTools)) {
    bad('contributes.mcp.tools 必须是数组')
  }
  const mcpNames = new Set()
  for (const tool of mcpTools) {
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || tool.name === '') {
      bad('contributes.mcp.tools 的元素必须带 name')
    }
    if (mcpNames.has(tool.name)) {
      bad(`MCP 工具名重复: ${JSON.stringify(tool.name)}`)
    }
    mcpNames.add(tool.name)
    if (tool.handler !== undefined && !HANDLER_RE.test(tool.handler)) {
      bad(`MCP 工具 ${tool.name} 的 handler 名非法: ${JSON.stringify(tool.handler)}`)
    }
  }

  const total = tools.length + commands.length + settings.length + panels.length
    + groups.length + mcpTools.length
  if (total > LIMITS.contributions) {
    bad(`扩展点数量过多（> ${LIMITS.contributions}）`)
  }
}

/** 校验插件内相对路径，拒绝绝对路径与穿越 */
export function validateRelPath(value, label, bad = (message) => fail(message)) {
  if (typeof value !== 'string' || value === '') {
    bad(`${label} 必须是非空字符串`)
  }
  const slashed = value.replace(/\\/g, '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
    bad(`${label} 不允许为绝对路径: ${JSON.stringify(value)}`)
  }
  if (slashed.startsWith('./')) {
    bad(`${label} 不允许以 ./ 开头: ${JSON.stringify(value)}`)
  }
  const segments = slashed.split('/')
  if (segments.some(segment => segment === '..')) {
    bad(`${label} 不允许越出插件目录: ${JSON.stringify(value)}`)
  }
}

/** 归一化后端运行时类型 */
export function backendKind(manifest) {
  const backend = manifest.runtime?.backend
  if (backend === undefined || backend === null || backend === '') {
    return 'js'
  }
  return String(backend).toLowerCase()
}

/** 后端入口相对路径（未声明时使用默认值） */
export function backendEntry(manifest) {
  if (manifest.runtime?.entry) {
    return manifest.runtime.entry
  }
  return backendKind(manifest) === 'none' ? '' : 'backend/index.js'
}

/** 插件是否需要前端产物 */
export function hasFrontend(manifest) {
  if (manifest.runtime?.frontend) {
    return true
  }
  const contributes = manifest.contributes ?? {}
  return (contributes.tools?.length ?? 0) > 0
    || (contributes.settingsPanels?.length ?? 0) > 0
}

/** 前端入口相对路径（不需要前端时返回空串） */
export function frontendEntry(manifest) {
  if (manifest.runtime?.frontend) {
    return manifest.runtime.frontend
  }
  return hasFrontend(manifest) ? 'frontend/index.js' : ''
}

/** 插件需要产出的全部入口文件（相对路径） */
export function requiredEntries(manifest) {
  const entries = []
  const frontend = frontendEntry(manifest)
  if (frontend) {
    entries.push(frontend)
  }
  if (backendKind(manifest) === 'js') {
    const backend = backendEntry(manifest)
    if (backend) {
      entries.push(backend)
    }
  }
  return entries
}

/** 解析清单文件内容（字符串或 Buffer） */
export function parseManifest(raw, context = {}) {
  let parsed
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
  }
  catch (error) {
    const where = context.where ? `${context.where}: ` : ''
    fail(`${where}清单不是合法 JSON: ${error.message}`)
  }
  return validateManifest(parsed, context)
}

/** 该依赖约束是否被某个已发布版本满足 */
export function constraintSatisfiedBy(versions, constraint) {
  return versions.some(version => satisfies(version, constraint))
}

export default {
  MANIFEST_VERSION,
  PLUGIN_API_VERSION,
  ManifestError,
  parseManifest,
  validateManifest,
  validateRelPath,
  backendKind,
  backendEntry,
  frontendEntry,
  hasFrontend,
  requiredEntries,
  constraintSatisfiedBy,
}
