#!/usr/bin/env node
/**
 * 对 registry.json 生成分离式签名 registry.json.sig，或校验既有签名。
 *
 * 用法：
 *   node scripts/sign.mjs            生成签名（没有私钥即失败）
 *   node scripts/sign.mjs --verify   用私钥推导出的公钥校验现有签名
 *
 * 私钥来源（按优先级）：
 *   1. 环境变量 REGISTRY_SIGNING_KEY（CI 用）
 *   2. keys/registry-signing.key（本地开发用）
 *
 * 与旧实现的区别：找不到私钥时**直接失败**。
 * 「签名失败但流水线继续成功」会产出一个看似官方、实际未验签的索引，
 * 而宿主只能把它当作不可信来源 —— 这种半成品状态必须暴露，不能被跳过。
 *
 * 签名覆盖的是 registry.json 的**原始字节**，因此签名必须在索引文件
 * 最终落盘之后执行，中间不能再格式化或改写它。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY_PATH = path.join(ROOT, 'registry.json')
const SIGNATURE_PATH = path.join(ROOT, 'registry.json.sig')
const LOCAL_KEY_PATH = path.join(ROOT, 'keys/registry-signing.key')

const verifyOnly = process.argv.includes('--verify')

if (!fs.existsSync(REGISTRY_PATH)) {
  console.error('registry.json 不存在，请先执行 node scripts/build.mjs --tag <发布批次>')
  process.exit(1)
}

const keyBase64 = (process.env.REGISTRY_SIGNING_KEY || '').trim()
  || (fs.existsSync(LOCAL_KEY_PATH) ? fs.readFileSync(LOCAL_KEY_PATH, 'utf8').trim() : '')

if (!keyBase64) {
  console.error(
    '未找到签名私钥。\n'
    + '  · CI：请配置仓库 Secret REGISTRY_SIGNING_KEY\n'
    + '  · 本地：先执行 node scripts/keygen.mjs 生成 keys/registry-signing.key\n'
    + '发布流程不允许跳过签名：未验签的索引在宿主侧只能按不可信来源处理。',
  )
  process.exit(1)
}

let privateKey
try {
  privateKey = crypto.createPrivateKey({
    key: Buffer.from(keyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
}
catch (error) {
  console.error(`签名私钥无法解析（应为 PKCS8 DER 的 base64）: ${error.message}`)
  process.exit(1)
}

// 从私钥推导公钥（raw 32 字节），用于自检
const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
const rawPublicKey = spki.subarray(spki.length - 32)
const registryBuffer = fs.readFileSync(REGISTRY_PATH)

if (verifyOnly) {
  if (!fs.existsSync(SIGNATURE_PATH)) {
    console.error('registry.json.sig 不存在，无法校验')
    process.exit(1)
  }
  const signature = Buffer.from(fs.readFileSync(SIGNATURE_PATH, 'utf8').trim(), 'base64')
  const ok = crypto.verify(null, registryBuffer, crypto.createPublicKey(privateKey), signature)
  if (!ok) {
    console.error('索引签名校验失败：registry.json 与 registry.json.sig 不一致')
    process.exit(1)
  }
  console.log(`索引签名校验通过（公钥 ${rawPublicKey.toString('base64')}）`)
  process.exit(0)
}

const signature = crypto.sign(null, registryBuffer, privateKey)
fs.writeFileSync(SIGNATURE_PATH, signature.toString('base64'), 'utf8')

// 写完立刻回读校验：签名文件被截断、编码错误都应当在这里暴露
const written = Buffer.from(fs.readFileSync(SIGNATURE_PATH, 'utf8').trim(), 'base64')
if (!crypto.verify(null, registryBuffer, crypto.createPublicKey(privateKey), written)) {
  console.error('刚写入的签名无法通过校验，请检查磁盘写入是否正常')
  process.exit(1)
}

console.log(`已生成并校验 registry.json.sig（${signature.length} 字节）`)
console.log(`对应公钥（base64）—— 宿主构建时通过 -ldflags 注入 RegistryPublicKey：`)
console.log(rawPublicKey.toString('base64'))
