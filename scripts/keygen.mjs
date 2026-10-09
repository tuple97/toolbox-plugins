#!/usr/bin/env node
/**
 * 生成插件索引的 Ed25519 签名密钥对。
 *
 * 用法：node scripts/keygen.mjs
 *
 * 产出：
 *   keys/registry-signing.key   私钥（PKCS8 DER 的 base64，已 gitignore）
 *   终端输出公钥                 填入宿主的 app/internal/plugin/trust.go
 *
 * 私钥在 CI 中通过 GitHub Secret（REGISTRY_SIGNING_KEY）注入，
 * 绝不入库；公钥硬编码在宿主里，因此索引一旦被篡改，验签必然失败。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KEY_DIR = path.join(ROOT, 'keys')
const KEY_PATH = path.join(KEY_DIR, 'registry-signing.key')

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')

// 宿主校验的是 raw 32 字节公钥；SPKI DER 的末 32 字节正是它
const spki = publicKey.export({ type: 'spki', format: 'der' })
const rawPublicKey = spki.subarray(spki.length - 32)
const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' })

fs.mkdirSync(KEY_DIR, { recursive: true })
fs.writeFileSync(KEY_PATH, pkcs8.toString('base64'), 'utf8')

console.log('公钥（base64）—— 填入宿主 app/internal/plugin/trust.go 的 RegistryPublicKey：\n')
console.log(rawPublicKey.toString('base64'))
console.log('\n私钥已写入 keys/registry-signing.key（已在 .gitignore 中）')
console.log('CI 请把它配置为仓库 Secret：REGISTRY_SIGNING_KEY')
