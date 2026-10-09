#!/usr/bin/env node
/**
 * 对 registry.json 生成分离式签名 registry.json.sig。
 *
 * 用法：node scripts/sign.mjs
 *
 * 私钥来源（按优先级）：
 *   1. 环境变量 REGISTRY_SIGNING_KEY（CI 用）
 *   2. keys/registry-signing.key（本地开发用）
 *
 * 找不到密钥时只告警并成功退出：允许在未配置签名的仓库里跑完整构建流程，
 * 宿主侧会据此提示「来源校验强度较低」。
 *
 * 注意签名覆盖的是 registry.json 的**原始字节**，因此签名必须在
 * 索引文件最终落盘之后执行，中间不能再格式化或改写。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY_PATH = path.join(ROOT, 'registry.json')
const SIGNATURE_PATH = path.join(ROOT, 'registry.json.sig')
const LOCAL_KEY_PATH = path.join(ROOT, 'keys/registry-signing.key')

if (!fs.existsSync(REGISTRY_PATH)) {
  console.error('registry.json 不存在，请先执行 node scripts/build.mjs')
  process.exit(1)
}

const keyBase64 = (process.env.REGISTRY_SIGNING_KEY || '').trim()
  || (fs.existsSync(LOCAL_KEY_PATH) ? fs.readFileSync(LOCAL_KEY_PATH, 'utf8').trim() : '')

if (!keyBase64) {
  console.warn('未找到签名私钥（REGISTRY_SIGNING_KEY 或 keys/registry-signing.key），已跳过签名')
  process.exit(0)
}

const registryBuffer = fs.readFileSync(REGISTRY_PATH)
const privateKey = crypto.createPrivateKey({
  key: Buffer.from(keyBase64, 'base64'),
  format: 'der',
  type: 'pkcs8',
})

const signature = crypto.sign(null, registryBuffer, privateKey)
fs.writeFileSync(SIGNATURE_PATH, signature.toString('base64'), 'utf8')

console.log(`已生成 registry.json.sig（${signature.length} 字节）`)
