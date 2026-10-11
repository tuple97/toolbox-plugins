/**
 * 插件索引（registry.json）的读写、历史保留与一致性校验。
 *
 * 索引是宿主安装插件的唯一依据，因此有三条硬规则：
 *
 *   1. 同一个 id + version 只能有一条记录；
 *   2. 同一版本一旦发布，其摘要不允许被悄悄改写；
 *   3. 历史版本条目必须保留 —— 否则用户无法安装旧版本、无法回滚，
 *      依赖解析也会因为「旧版本消失」而失败。
 *
 * 旧实现每次构建都用当前源码版本从零重建索引，正好破坏了第 3 条。
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseConstraint, satisfies } from './semver.mjs'
import { ManifestError, validateManifest } from './manifest.mjs'

/** 索引格式版本，必须与宿主 plugin.RegistrySchemaVersion 一致 */
export const REGISTRY_SCHEMA_VERSION = 2

/** 读取索引；不存在或内容损坏时返回空索引 */
export function loadRegistry(filePath) {
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, updatedAt: '', plugins: [] }
  }
  const raw = fs.readFileSync(filePath, 'utf8').trim()
  if (raw === '') {
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, updatedAt: '', plugins: [] }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  }
  catch (error) {
    throw new Error(`现有 registry.json 不是合法 JSON，请先修复再发布：${error.message}`)
  }
  if (parsed.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `现有 registry.json 的 schemaVersion=${parsed.schemaVersion}，`
      + `当前支持 ${REGISTRY_SCHEMA_VERSION}；请手动迁移后再发布`,
    )
  }
  if (!Array.isArray(parsed.plugins)) {
    throw new Error('现有 registry.json 缺少 plugins 数组')
  }
  return parsed
}

/** 序列化索引（固定格式，便于签名与 diff） */
export function serializeRegistry(registry) {
  const sorted = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    updatedAt: registry.updatedAt,
    plugins: [...registry.plugins].sort(compareEntries),
  }
  return `${JSON.stringify(sorted, null, 2)}\n`
}

function compareEntries(left, right) {
  if (left.id !== right.id) {
    return left.id < right.id ? -1 : 1
  }
  if (left.version === right.version) {
    return 0
  }
  // 版本降序：同 id 下最新的排前面，界面直接取第一条即可
  const leftParts = left.version.split('.').map(Number)
  const rightParts = right.version.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (leftParts[i] !== rightParts[i]) {
      return rightParts[i] - leftParts[i]
    }
  }
  return 0
}

/** 索引条目的唯一键 */
export function entryKey(entry) {
  return `${entry.id}@${entry.version}`
}

/**
 * 把本次构建的条目合并进现有索引。
 *
 * @param {object} existing 现有索引
 * @param {Array<object>} entries 本次构建产出的条目
 * @param {{ allowRepublish?: boolean }} [options]
 * @returns {{ registry: object, added: string[], unchanged: string[], retained: string[] }}
 */
export function mergeRegistry(existing, entries, options = {}) {
  const { allowRepublish = false } = options
  const byKey = new Map()
  for (const entry of existing.plugins ?? []) {
    byKey.set(entryKey(entry), entry)
  }

  const added = []
  const unchanged = []

  for (const entry of entries) {
    const key = entryKey(entry)
    const previous = byKey.get(key)
    if (previous) {
      if (previous.checksum !== entry.checksum) {
        // 同一版本两种内容会让「用户装到的是哪个版本」变得无法回答
        if (!allowRepublish) {
          throw new Error(
            `${key} 已经发布过，但本次构建的摘要发生了变化`
            + `（已发布 ${previous.checksum}，本次 ${entry.checksum}）。\n`
            + '请提升插件版本号；如确实要重新发布同一版本，请显式加 --allow-republish。',
          )
        }
        console.warn(`⚠ ${key} 摘要变化已按 --allow-republish 覆盖`)
        byKey.set(key, entry)
        added.push(key)
        continue
      }
      unchanged.push(key)
      byKey.set(key, entry)
      continue
    }
    byKey.set(key, entry)
    added.push(key)
  }

  const retained = []
  for (const key of byKey.keys()) {
    if (!added.includes(key) && !unchanged.includes(key)) {
      retained.push(key)
    }
  }

  return {
    registry: {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      plugins: [...byKey.values()],
    },
    added,
    unchanged,
    retained,
  }
}

/** 索引条目到清单对象的映射（用于复用同一套协议校验） */
export function entryToManifest(entry) {
  return {
    manifestVersion: 1,
    id: entry.id,
    name: entry.name,
    version: entry.version,
    publisher: entry.publisher,
    description: entry.description ?? '',
    author: entry.author ?? '',
    homepage: entry.homepage ?? '',
    license: entry.license ?? '',
    icon: entry.icon ?? '',
    engines: entry.engines,
    dependencies: entry.dependencies ?? {},
    permissions: entry.permissions ?? {},
    runtime: entry.runtime ?? {},
    contributes: entry.contributes ?? {},
  }
}

/** 校验索引条目自身的字段完整性 */
export function validateEntry(entry) {
  const key = entryKey(entry)
  try {
    validateManifest(entryToManifest(entry), { where: `索引条目 ${key}` })
  }
  catch (error) {
    if (error instanceof ManifestError) {
      throw new Error(error.message)
    }
    throw error
  }

  if (typeof entry.download !== 'string' || entry.download === '') {
    throw new Error(`索引条目 ${key} 缺少 download`)
  }
  let url
  try {
    url = new URL(entry.download)
  }
  catch {
    throw new Error(`索引条目 ${key} 的 download 不是合法地址: ${entry.download}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`索引条目 ${key} 的 download 协议不受支持: ${entry.download}`)
  }
  if (typeof entry.checksum !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(entry.checksum)) {
    throw new Error(`索引条目 ${key} 的 checksum 不是合法 sha256: ${entry.checksum}`)
  }
  return entry
}

/**
 * 下载地址必须是「不可变地址」。
 *
 * 指向 releases/latest 的地址会被后续发布覆盖，同一个索引条目会随时间
 * 指向不同内容，摘要校验因此失去意义。
 */
export function assertImmutableDownload(entry) {
  const url = new URL(entry.download)
  const segments = url.pathname.split('/').filter(Boolean)
  const index = segments.indexOf('download')
  if (index < 0 || index + 1 >= segments.length) {
    throw new Error(
      `索引条目 ${entryKey(entry)} 的 download 不是发布产物地址（应形如 `
      + `/releases/download/<发布批次>/<文件>）: ${entry.download}`,
    )
  }
  const tag = segments[index + 1]
  if (tag === 'latest' || tag === 'head') {
    throw new Error(
      `索引条目 ${entryKey(entry)} 的 download 指向可变地址 ${tag}，`
      + '同一版本会随时间指向不同内容；请使用不可变的发布批次 tag',
    )
  }
  return entry
}

/**
 * 校验整份索引：条目合法性、重复、依赖可解析、下载地址不可变。
 *
 * 「依赖可解析」是发布前的最后一道闸门：一个依赖了不存在插件的版本
 * 一旦进入索引，用户装到一半就会失败。
 */
export function validateRegistry(registry) {
  const seen = new Map()
  const versionsById = new Map()

  for (const entry of registry.plugins) {
    validateEntry(entry)
    assertImmutableDownload(entry)
    const key = entryKey(entry)
    if (seen.has(key)) {
      throw new Error(`索引中存在重复条目: ${key}`)
    }
    seen.set(key, entry)
    if (!versionsById.has(entry.id)) {
      versionsById.set(entry.id, [])
    }
    versionsById.get(entry.id).push(entry.version)
  }

  for (const entry of registry.plugins) {
    const dependencies = entry.dependencies ?? {}
    for (const [depId, constraint] of Object.entries(dependencies)) {
      if (!parseConstraint(constraint)) {
        throw new Error(`索引条目 ${entryKey(entry)} 的依赖 ${depId} 约束非法: ${constraint}`)
      }
      const versions = versionsById.get(depId)
      if (!versions || versions.length === 0) {
        throw new Error(
          `索引条目 ${entryKey(entry)} 依赖 ${depId}，但索引中没有该插件的任何版本`,
        )
      }
      const satisfiable = versions.some(version => satisfies(version, constraint))
      if (!satisfiable) {
        throw new Error(
          `索引条目 ${entryKey(entry)} 依赖 ${depId}@${constraint}，`
          + `但索引中可用的版本 ${versions.join('、')} 都不满足该约束`,
        )
      }
    }
  }
  return registry
}

/** 读取磁盘上索引对应条目的清单（用于与源码清单比对） */
export function writeRegistry(filePath, registry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, serializeRegistry(registry), 'utf8')
}

export default {
  REGISTRY_SCHEMA_VERSION,
  loadRegistry,
  writeRegistry,
  serializeRegistry,
  mergeRegistry,
  validateRegistry,
  validateEntry,
  assertImmutableDownload,
  entryKey,
  entryToManifest,
}
