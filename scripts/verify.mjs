#!/usr/bin/env node
/**
 * 发布前的独立校验入口。
 *
 * 用法：
 *   node scripts/verify.mjs
 *
 * 校验内容：
 *   1. registry.json 结构合法：条目字段完整、无重复、依赖可解析、下载地址不可变；
 *   2. release/ 下的每个 zip 与索引条目一一对应（摘要一致、清单一致、入口齐备）；
 *   3. 工作区里的插件源码清单与索引记录一致（防止「只改了源码没重新发布」）。
 *
 * 环境变量：
 *   REGISTRY_SIGNING_KEY  提供时顺带校验 registry.json.sig 的签名
 *
 * CI 会在构建与签名之后跑它；任何一项失败都退出码非 0，
 * 从而阻止「索引已更新但产物不可用」的发布。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseManifest } from '../packages/build-tools/manifest.mjs'
import { entryKey, loadRegistry, validateRegistry } from '../packages/build-tools/registry.mjs'
import { verifyRelease } from '../packages/build-tools/verify.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY_PATH = path.join(ROOT, 'registry.json')
const SIGNATURE_PATH = path.join(ROOT, 'registry.json.sig')
const RELEASE_DIR = path.join(ROOT, 'release')
const DIST_DIR = path.join(ROOT, 'dist')
const PLUGINS_DIR = path.join(ROOT, 'plugins')

const problems = []

function check(condition, message) {
  if (!condition) {
    problems.push(message)
  }
}

function verifySignature() {
  const keyBase64 = (process.env.REGISTRY_SIGNING_KEY || '').trim()
  if (!keyBase64) {
    console.log('· 未提供 REGISTRY_SIGNING_KEY，跳过索引签名校验')
    return
  }
  if (!fs.existsSync(SIGNATURE_PATH)) {
    problems.push('registry.json.sig 缺失：发布产物必须带索引签名')
    return
  }
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(keyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  const signature = Buffer.from(fs.readFileSync(SIGNATURE_PATH, 'utf8').trim(), 'base64')
  const ok = crypto.verify(null, fs.readFileSync(REGISTRY_PATH), crypto.createPublicKey(privateKey), signature)
  check(ok, 'registry.json.sig 与 registry.json 不一致')
  if (ok) {
    const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
    console.log(`· 索引签名校验通过（公钥 ${spki.subarray(spki.length - 32).toString('base64')}）`)
  }
}

/** 源码目录清单与索引记录比对 */
function verifySourceConsistency(registry) {
  const byKey = new Map(registry.plugins.map(entry => [entryKey(entry), entry]))
  for (const dir of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) {
      continue
    }
    const manifestPath = path.join(PLUGINS_DIR, dir.name, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
      problems.push(`plugins/${dir.name} 缺少 manifest.json`)
      continue
    }
    let manifest
    try {
      manifest = parseManifest(fs.readFileSync(manifestPath, 'utf8'), {
        where: `plugins/${dir.name}/manifest.json`,
      })
    }
    catch (error) {
      problems.push(error.message)
      continue
    }

    const entry = byKey.get(`${manifest.id}@${manifest.version}`)
    if (!entry) {
      // 源码版本尚未发布不算错误，但要明确告知，避免误以为已经上线
      console.log(`· plugins/${dir.name} 的 ${manifest.id}@${manifest.version} 尚未进入索引`)
      continue
    }
    check(
      entry.sourceDir === dir.name,
      `索引里 ${entryKey(entry)} 的 sourceDir=${entry.sourceDir} 与源码目录 ${dir.name} 不一致`,
    )
    for (const field of ['engines', 'dependencies', 'permissions', 'runtime', 'contributes']) {
      const left = JSON.stringify(entry[field] ?? null)
      const right = JSON.stringify(manifest[field] ?? null)
      check(left === right, `${entryKey(entry)} 的 ${field} 与源码清单不一致`)
    }
  }
}

function main() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error('registry.json 不存在：请先执行 node scripts/build.mjs --tag <发布批次>')
    process.exit(1)
  }

  const registry = loadRegistry(REGISTRY_PATH)
  try {
    validateRegistry(registry)
  }
  catch (error) {
    problems.push(error.message)
  }

  verifySignature()
  verifySourceConsistency(registry)

  if (fs.existsSync(RELEASE_DIR)) {
    try {
      const results = verifyRelease({ registry, releaseDir: RELEASE_DIR, distDir: DIST_DIR })
      console.log(`· 已校验 ${results.length} 个发布包（摘要、清单与入口均一致）`)
    }
    catch (error) {
      problems.push(error.message)
    }
  }
  else {
    console.log('· release/ 目录不存在，跳过发布包校验')
  }

  if (problems.length > 0) {
    console.error('\n校验未通过：')
    for (const problem of problems) {
      console.error(`  ✗ ${problem}`)
    }
    process.exit(1)
  }
  console.log('\n校验通过。')
}

main()
