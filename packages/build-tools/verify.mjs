/**
 * 发布产物校验。
 *
 * 「构建脚本打印了成功」不等于产物正确。这里实际打开产物做四件事：
 *
 *   1. release/*.zip 的摘要与索引记录一致；
 *   2. zip 内的目录结构正确（清单在根、入口文件存在）；
 *   3. zip 内清单与索引记录逐字段一致（不存在「索引说 A、包里是 B」）；
 *   4. 索引自身合法（条目完整、无重复、依赖可解析、地址不可变）。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { parseManifest, requiredEntries } from './manifest.mjs'
import { entryKey, validateRegistry } from './registry.mjs'
import { listZipEntries } from './zip-read.mjs'

/** 计算 sha256 摘要 */
export function sha256(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`
}

/** 参与比对的关键字段 */
const COMPARED_FIELDS = [
  'id', 'name', 'version', 'publisher', 'description',
  'engines', 'dependencies', 'permissions', 'runtime', 'contributes',
]

function stable(value) {
  if (value === undefined || value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map(key => `${key}:${stable(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * 校验单个发布包。
 *
 * @param {{ zipPath: string, entry: object, distDir?: string }} params
 */
export function verifyReleasePackage({ zipPath, entry, distDir }) {
  const key = entryKey(entry)
  if (!fs.existsSync(zipPath)) {
    throw new Error(`缺少发布包: ${zipPath}`)
  }
  const buffer = fs.readFileSync(zipPath)
  const checksum = sha256(buffer)
  if (checksum !== entry.checksum) {
    throw new Error(
      `发布包 ${path.basename(zipPath)} 的摘要与索引不一致：`
      + `索引 ${entry.checksum}，实际 ${checksum}`,
    )
  }

  const names = listZipEntries(buffer)
  if (!names.includes('manifest.json')) {
    throw new Error(`发布包 ${path.basename(zipPath)} 内缺少 manifest.json`)
  }
  // 路径穿越与绝对路径一律拒绝
  for (const name of names) {
    if (name.startsWith('/') || name.split('/').includes('..') || /^[A-Za-z]:/.test(name)) {
      throw new Error(`发布包 ${path.basename(zipPath)} 内含非法路径: ${name}`)
    }
  }

  const manifest = parseManifest(readZipEntry(buffer, names, 'manifest.json'), {
    where: path.basename(zipPath),
  })
  for (const field of COMPARED_FIELDS) {
    if (stable(manifest[field]) !== stable(entry[field])) {
      throw new Error(
        `发布包 ${path.basename(zipPath)} 内的 ${field} 与索引记录不一致：`
        + `索引 ${stable(entry[field])}，包内 ${stable(manifest[field])}`,
      )
    }
  }

  for (const required of requiredEntries(manifest)) {
    if (!names.includes(required)) {
      throw new Error(`发布包 ${path.basename(zipPath)} 缺少入口文件 ${required}`)
    }
  }

  if (distDir) {
    if (!fs.existsSync(distDir)) {
      throw new Error(`缺少解包目录: ${distDir}`)
    }
    for (const required of requiredEntries(manifest)) {
      if (!fs.existsSync(path.join(distDir, required))) {
        throw new Error(`解包目录 ${distDir} 缺少入口文件 ${required}`)
      }
    }
  }

  return { key, bytes: buffer.length, entries: names.length }
}

/** 读取 zip 内单个条目的内容（仅支持 store / deflate） */
export function readZipEntry(buffer, names, target) {
  const index = names.indexOf(target)
  if (index < 0) {
    throw new Error(`zip 内不存在条目 ${target}`)
  }

  // 从本地文件头开始顺序扫描，找到匹配的条目
  let cursor = 0
  while (cursor + 30 <= buffer.length && buffer.readUInt32LE(cursor) === 0x04034b50) {
    const method = buffer.readUInt16LE(cursor + 8)
    const compressedSize = buffer.readUInt32LE(cursor + 18)
    const uncompressedSize = buffer.readUInt32LE(cursor + 22)
    const nameLength = buffer.readUInt16LE(cursor + 26)
    const extraLength = buffer.readUInt16LE(cursor + 28)
    const nameStart = cursor + 30
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8')
    const dataStart = nameStart + nameLength + extraLength

    if (name === target) {
      const payload = buffer.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) {
        return payload
      }
      if (method === 8) {
        const inflated = inflateRawSync(payload)
        if (inflated.length !== uncompressedSize) {
          throw new Error(`zip 条目 ${target} 解压后长度不符`)
        }
        return inflated
      }
      throw new Error(`zip 条目 ${target} 使用了不支持的压缩方法 ${method}`)
    }
    cursor = dataStart + compressedSize
  }
  throw new Error(`zip 内不存在条目 ${target}`)
}

/**
 * 校验整份索引与磁盘上的发布产物。
 *
 * @param {{ registry: object, releaseDir: string, distDir: string }} params
 */
export function verifyRelease({ registry, releaseDir, distDir }) {
  validateRegistry(registry)

  const results = []
  for (const entry of registry.plugins) {
    const zipPath = path.join(releaseDir, `${entry.id}-${entry.version}.zip`)
    const pluginDist = distDir
      ? path.join(distDir, entry.id, entry.version)
      : undefined
    results.push(verifyReleasePackage({
      zipPath,
      entry,
      // 历史版本可能没有本地解包目录，此时只校验 zip
      distDir: pluginDist && fs.existsSync(pluginDist) ? pluginDist : undefined,
    }))
  }
  return results
}

export default { verifyRelease, verifyReleasePackage, sha256, listZipEntries }
