#!/usr/bin/env node
/**
 * 构建全部插件并生成插件索引（registry.json）。
 *
 * 产出：
 *   dist/<插件id>/<版本>/            解包后的插件内容（可直接拖进工具箱验证）
 *   release/<插件id>-<版本>.zip      可离线分发的安装包
 *   registry.json                    宿主读取的插件索引
 *
 * 用法：
 *   node scripts/build.mjs                  构建全部
 *   node scripts/build.mjs --only dictionary 只构建某个插件目录
 *
 * 环境变量：
 *   RELEASE_TAG       发布批次 tag（CI 注入）。registry 里的下载地址会带上它。
 *   RELEASE_BASE_URL  下载地址前缀，默认指向本仓库的 GitHub Release。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'
import { hostImports } from '../packages/build-tools/host-imports.mjs'
import { createZip } from '../packages/build-tools/zip.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = path.join(ROOT, 'plugins')
const DIST_DIR = path.join(ROOT, 'dist')
const RELEASE_DIR = path.join(ROOT, 'release')
const VUE_SHIM = path.join(ROOT, 'packages/build-tools/vue-shim.mjs')

const REPO = 'https://github.com/tuple97/toolbox-plugins'
const RELEASE_TAG = process.env.RELEASE_TAG || 'latest'
const RELEASE_BASE_URL = process.env.RELEASE_BASE_URL || `${REPO}/releases/download`
const DOWNLOAD_BASE = `${RELEASE_BASE_URL}/${RELEASE_TAG}`

/** 递归列出目录下全部文件（返回相对路径与绝对路径） */
function walkFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(full, base, out)
      continue
    }
    out.push({
      name: path.relative(base, full).replace(/\\/g, '/'),
      full,
    })
  }
  return out
}

/** 计算 sha256 摘要 */
function sha256(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`
}

/** 读取并校验插件清单 */
function readManifest(pluginDir) {
  const manifestPath = path.join(pluginDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`缺少 manifest.json: ${pluginDir}`)
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  for (const field of ['id', 'name', 'version', 'publisher']) {
    if (!manifest[field]) {
      throw new Error(`${manifestPath} 缺少字段 ${field}`)
    }
  }
  return manifest
}

/**
 * 用 Vite 构建插件的 SFC/TS 源码。
 *
 * 输出单文件 ESM：
 *   - 关闭代码分割，插件产物必须是一个能被宿主 import 的文件；
 *   - `vue` 走 shim，避免打包第二份运行时；
 *   - `@/xxx` 由 host-imports 改写成从宿主内核取值。
 */
async function buildFrontend(pluginDir, outDir, pluginId) {
  await build({
    configFile: false,
    root: pluginDir,
    logLevel: 'warn',
    plugins: [hostImports(), vue()],
    resolve: {
      alias: [
        // 精确匹配 'vue'，不要影响 vue-draggable-plus 等以 vue 开头的包
        { find: /^vue$/, replacement: VUE_SHIM },
      ],
    },
    build: {
      lib: {
        entry: path.join(pluginDir, 'src/index.ts'),
        formats: ['es'],
        fileName: () => 'index.js',
      },
      outDir,
      emptyOutDir: true,
      minify: 'esbuild',
      target: 'es2022',
      cssCodeSplit: false,
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
          assetFileNames: 'plugin.[ext]',
        },
      },
    },
  })

  // 把提取出来的 CSS 内联进 JS：插件产物保持「一个文件」，
  // 宿主加载时无需再额外请求样式文件
  const jsPath = path.join(outDir, 'index.js')
  const cssPath = path.join(outDir, 'plugin.css')
  if (fs.existsSync(cssPath) && fs.existsSync(jsPath)) {
    const css = fs.readFileSync(cssPath, 'utf8')
    const id = JSON.stringify(pluginId)
    /*
     * 样式复用同一个 <style> 而不是每次新 append 一个。
     *
     * 插件入口 URL 带安装令牌（?v=updatedAt），重装后模块会重新求值；若每次都
     * appendChild，旧的那份会一直留在 <head> 里，两份样式同时生效 ——
     * 「删掉一条声明」这类改动就永远看不到（旧元素里那条还在），
     * 表现就是「插件重装了但界面没变」。
     * 宿主侧也会在卸载 / 重载时摘掉这些元素（见 toolbox 的 plugins/registry.ts），
     * 这里再做一层幂等，保证同一份文档里每个插件只有一个样式元素。
     */
    const inject = `\n;(() => { if (typeof document === 'undefined') return;`
      + ` const id = ${id};`
      + ` const nodes = document.head.querySelectorAll('style[data-toolbox-plugin="' + id + '"]');`
      + ` const s = nodes[0];`
      + ` for (let i = 1; i < nodes.length; i++) nodes[i].remove();`
      + ` if (!s) {`
      + ` const created = document.createElement('style');`
      + ` created.setAttribute('data-toolbox-plugin', id);`
      + ` document.head.appendChild(created);`
      + ` created.textContent = ${JSON.stringify(css)};`
      + ` return }`
      + ` s.textContent = ${JSON.stringify(css)} })();\n`
    fs.appendFileSync(jsPath, inject)
    fs.unlinkSync(cssPath)
  }
}

/** 构建单个插件 */
async function buildPlugin(dirName) {
  const pluginDir = path.join(PLUGINS_DIR, dirName)
  const manifest = readManifest(pluginDir)
  const outRoot = path.join(DIST_DIR, manifest.id, manifest.version)

  fs.rmSync(outRoot, { recursive: true, force: true })
  fs.mkdirSync(outRoot, { recursive: true })

  // 前端：优先构建 src/index.ts，否则直接拷贝手写的 frontend/
  const srcEntry = path.join(pluginDir, 'src/index.ts')
  const srcEntryJs = path.join(pluginDir, 'src/index.js')
  const handWritten = path.join(pluginDir, 'frontend/index.js')

  if (fs.existsSync(srcEntry) || fs.existsSync(srcEntryJs)) {
    const frontendOut = path.join(outRoot, 'frontend')
    await buildFrontend(pluginDir, frontendOut, manifest.id)
    // 同时回写一份到插件目录：开发者可以直接把 plugins/<name> 拖进
    // 插件管理页安装，不必先去 dist/ 里找产物（该目录已 gitignore）
    fs.rmSync(path.join(pluginDir, 'frontend'), { recursive: true, force: true })
    fs.cpSync(frontendOut, path.join(pluginDir, 'frontend'), { recursive: true })
  }
  else if (fs.existsSync(handWritten)) {
    fs.cpSync(path.join(pluginDir, 'frontend'), path.join(outRoot, 'frontend'), { recursive: true })
  }

  // 清单与后端/资源原样拷贝
  fs.copyFileSync(path.join(pluginDir, 'manifest.json'), path.join(outRoot, 'manifest.json'))
  for (const extra of ['backend', 'assets']) {
    const from = path.join(pluginDir, extra)
    if (fs.existsSync(from)) {
      fs.cpSync(from, path.join(outRoot, extra), { recursive: true })
    }
  }

  return { dirName, manifest, outRoot }
}

/** 把解包目录打成 zip */
function packPlugin(info) {
  fs.mkdirSync(RELEASE_DIR, { recursive: true })

  const files = walkFiles(info.outRoot).sort((a, b) => a.name.localeCompare(b.name))
  if (files.length === 0) {
    throw new Error(`插件产物为空: ${info.manifest.id}`)
  }

  const buffer = createZip(files.map(file => ({
    name: file.name,
    data: fs.readFileSync(file.full),
  })))

  const fileName = `${info.manifest.id}-${info.manifest.version}.zip`
  fs.writeFileSync(path.join(RELEASE_DIR, fileName), buffer)

  return { fileName, checksum: sha256(buffer), size: buffer.length }
}

/** 依据清单生成索引条目 */
function toRegistryEntry(manifest, packed) {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    publisher: manifest.publisher,
    description: manifest.description ?? '',
    author: manifest.author ?? '',
    icon: manifest.icon ?? '',
    homepage: manifest.homepage ?? '',
    license: manifest.license ?? '',
    repo: `${REPO}/tree/main/plugins/${manifest.id}`,
    download: `${DOWNLOAD_BASE}/${packed.fileName}`,
    checksum: packed.checksum,
    // 签名由 CI 在发布阶段对 registry.json 整体签名（见 scripts/sign.mjs），
    // 单个条目不单独签名
    signature: '',
    official: true,
    engines: manifest.engines ?? {},
    dependencies: manifest.dependencies ?? {},
    permissions: manifest.permissions ?? {},
    runtime: manifest.runtime ?? {},
    contributes: manifest.contributes ?? {},
  }
}

async function main() {
  const onlyIndex = process.argv.indexOf('--only')
  const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null

  const dirs = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => (only ? name === only : true))
    .sort()

  if (dirs.length === 0) {
    throw new Error(only ? `找不到插件目录: ${only}` : 'plugins/ 下没有任何插件')
  }

  const entries = []
  for (const dirName of dirs) {
    const info = await buildPlugin(dirName)
    const packed = packPlugin(info)
    entries.push(toRegistryEntry(info.manifest, packed))
    console.log(
      `✓ ${info.manifest.id}@${info.manifest.version}`
      + `  → release/${packed.fileName} (${(packed.size / 1024).toFixed(1)} KB)`,
    )
  }

  const registry = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    plugins: entries,
  }
  fs.writeFileSync(path.join(ROOT, 'registry.json'), `${JSON.stringify(registry, null, 2)}\n`)

  console.log(`\n共 ${entries.length} 个插件，索引已写入 registry.json`)
  console.log(`索引地址（供宿主配置）：https://raw.githubusercontent.com/tuple97/toolbox-plugins/main/registry.json`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
