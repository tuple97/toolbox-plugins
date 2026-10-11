#!/usr/bin/env node
/**
 * 构建全部插件，并（可选地）生成插件索引 registry.json。
 *
 * 产出：
 *   dist/<插件id>/<版本>/            解包后的插件内容（可直接拖进工具箱验证）
 *   release/<插件id>-<版本>.zip      可离线分发的安装包
 *   registry.json                    宿主读取的插件索引（仅在给定发布批次时生成）
 *
 * 用法：
 *   node scripts/build.mjs                        构建全部（不生成索引）
 *   node scripts/build.mjs --only dictionary      只构建某个插件目录
 *   node scripts/build.mjs --tag plugins-20260101 生成索引，下载地址用该批次
 *   node scripts/build.mjs --allow-republish      允许覆盖同版本的已发布摘要
 *
 * 环境变量：
 *   RELEASE_TAG       发布批次 tag（等价于 --tag；CI 使用）
 *   RELEASE_BASE_URL  下载地址前缀，默认指向本仓库的 GitHub Release
 *
 * 为什么默认不生成索引：
 *   索引里的下载地址必须指向不可变的发布批次目录。本地构建没有发布批次，
 *   若此时悄悄用 latest 覆盖掉 registry.json，就会把已发布版本的地址
 *   改成可变地址 —— 这正是旧实现丢失历史版本、摘要失去意义的根因。
 *   因此没有批次就不动索引，只产出可校验的安装包。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'
import { hostImports } from '../packages/build-tools/host-imports.mjs'
import { createZip } from '../packages/build-tools/zip.mjs'
import {
  backendEntry,
  backendKind,
  frontendEntry,
  parseManifest,
  validateRelPath,
} from '../packages/build-tools/manifest.mjs'
import {
  loadRegistry,
  mergeRegistry,
  validateRegistry,
  writeRegistry,
} from '../packages/build-tools/registry.mjs'
import { verifyRelease } from '../packages/build-tools/verify.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = path.join(ROOT, 'plugins')
const DIST_DIR = path.join(ROOT, 'dist')
const RELEASE_DIR = path.join(ROOT, 'release')
const REGISTRY_PATH = path.join(ROOT, 'registry.json')
const VUE_SHIM = path.join(ROOT, 'packages/build-tools/vue-shim.mjs')

const REPO = 'https://github.com/tuple97/toolbox-plugins'
const RELEASE_BASE_URL = process.env.RELEASE_BASE_URL || `${REPO}/releases/download`

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

/** 解析命令行参数 */
function parseArgs(argv) {
  const options = { only: null, tag: (process.env.RELEASE_TAG || '').trim() || null, allowRepublish: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--only') {
      options.only = argv[i + 1]
      i += 1
    }
    else if (arg === '--tag') {
      options.tag = argv[i + 1]
      i += 1
    }
    else if (arg === '--allow-republish') {
      options.allowRepublish = true
    }
    else if (arg.startsWith('--only=')) {
      options.only = arg.slice('--only='.length)
    }
    else if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
    }
    else {
      throw new Error(`未知参数: ${arg}`)
    }
  }
  return options
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
     * 插件入口 URL 带版本号，重装后模块会重新求值；若每次都 appendChild，
     * 旧的那份会一直留在 <head> 里，两份样式同时生效 ——
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

/** 构建单个插件，返回清单与解包目录 */
async function buildPlugin(dirName) {
  const pluginDir = path.join(PLUGINS_DIR, dirName)
  const manifestPath = path.join(pluginDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`缺少 manifest.json: ${pluginDir}`)
  }
  const manifest = parseManifest(fs.readFileSync(manifestPath, 'utf8'), {
    where: `plugins/${dirName}/manifest.json`,
  })

  const outRoot = path.join(DIST_DIR, manifest.id, manifest.version)
  if (fs.existsSync(outRoot)) {
    // 同一个 id@version 被两个源码目录产出，说明目录里存着两份事实
    throw new Error(`产物目录已存在，请检查是否有重复的插件 id@version: ${outRoot}`)
  }
  fs.mkdirSync(outRoot, { recursive: true })

  // 前端：优先构建 src/index.ts，否则直接拷贝手写的 frontend/
  const srcEntry = path.join(pluginDir, 'src/index.ts')
  const srcEntryJs = path.join(pluginDir, 'src/index.js')
  const handWritten = path.join(pluginDir, 'frontend/index.js')
  const wantsFrontend = frontendEntry(manifest) !== ''

  if (fs.existsSync(srcEntry) || fs.existsSync(srcEntryJs)) {
    if (!wantsFrontend) {
      throw new Error(`${manifest.id} 有前端源码，但清单未声明前端入口`)
    }
    const frontendOut = path.join(outRoot, 'frontend')
    await buildFrontend(pluginDir, frontendOut, manifest.id)
    // 同时回写一份到插件目录：开发者可以直接把 plugins/<name> 拖进
    // 插件管理页安装，不必先去 dist/ 里找产物（该目录已 gitignore）
    fs.rmSync(path.join(pluginDir, 'frontend'), { recursive: true, force: true })
    fs.cpSync(frontendOut, path.join(pluginDir, 'frontend'), { recursive: true })
  }
  else if (wantsFrontend) {
    if (!fs.existsSync(handWritten)) {
      throw new Error(`${manifest.id} 声明了前端入口但既没有源码也没有 frontend/index.js`)
    }
    fs.cpSync(path.join(pluginDir, 'frontend'), path.join(outRoot, 'frontend'), { recursive: true })
  }

  // 清单与后端/资源原样拷贝
  fs.copyFileSync(manifestPath, path.join(outRoot, 'manifest.json'))
  for (const extra of ['backend', 'assets']) {
    const from = path.join(pluginDir, extra)
    if (fs.existsSync(from)) {
      fs.cpSync(from, path.join(outRoot, extra), { recursive: true })
    }
  }

  assertArtifacts(manifest, outRoot)
  return { dirName, manifest, outRoot }
}

/** 校验解包目录里入口文件齐备、清单在根目录 */
function assertArtifacts(manifest, outRoot) {
  const required = []
  const frontend = frontendEntry(manifest)
  if (frontend) {
    required.push(frontend)
  }
  if (backendKind(manifest) === 'js') {
    const backend = backendEntry(manifest)
    if (backend) {
      required.push(backend)
    }
  }
  for (const rel of required) {
    validateRelPath(rel, '入口路径')
    const full = path.join(outRoot, rel)
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      throw new Error(`${manifest.id}@${manifest.version} 缺少入口文件 ${rel}`)
    }
  }
}

/** 把解包目录打成 zip */
function packPlugin(info) {
  fs.mkdirSync(RELEASE_DIR, { recursive: true })

  const files = walkFiles(info.outRoot).sort((a, b) => a.name.localeCompare(b.name))
  if (files.length === 0) {
    throw new Error(`插件产物为空: ${info.manifest.id}`)
  }
  if (!files.some(file => file.name === 'manifest.json')) {
    throw new Error(`插件产物缺少 manifest.json: ${info.manifest.id}`)
  }

  const buffer = createZip(files.map(file => ({
    name: file.name,
    data: fs.readFileSync(file.full),
  })))

  const fileName = `${info.manifest.id}-${info.manifest.version}.zip`
  fs.writeFileSync(path.join(RELEASE_DIR, fileName), buffer)

  return { fileName, checksum: sha256(buffer), size: buffer.length }
}

/** 依据清单与源码目录生成索引条目 */
function toRegistryEntry(info, packed, tag) {
  const { manifest, dirName } = info
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
    // 源码链接必须来自实际目录名：插件 id 与目录名并不总是相同
    sourceDir: dirName,
    repo: `${REPO}/tree/main/plugins/${dirName}`,
    // 固定到发布批次，保证同一版本永远指向同一份内容
    download: `${RELEASE_BASE_URL}/${tag}/${packed.fileName}`,
    checksum: packed.checksum,
    size: packed.size,
    official: true,
    engines: manifest.engines ?? {},
    dependencies: manifest.dependencies ?? {},
    permissions: manifest.permissions ?? {},
    runtime: manifest.runtime ?? {},
    contributes: manifest.contributes ?? {},
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  const allDirs = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()

  const dirs = allDirs.filter(name => (options.only ? name === options.only : true))
  if (dirs.length === 0) {
    throw new Error(options.only ? `找不到插件目录: ${options.only}` : 'plugins/ 下没有任何插件')
  }
  if (options.only && options.tag) {
    throw new Error('--only 只用于本地验证，不能与发布批次同时使用（索引必须是完整快照）')
  }

  // 每次构建前清空产物，避免上一轮的残留混进本次发布
  fs.rmSync(RELEASE_DIR, { recursive: true, force: true })

  const entries = []
  for (const dirName of dirs) {
    const info = await buildPlugin(dirName)
    const packed = packPlugin(info)
    entries.push(toRegistryEntry(info, packed, options.tag ?? 'latest'))
    console.log(
      `✓ ${info.manifest.id}@${info.manifest.version}`
      + `  → release/${packed.fileName} (${(packed.size / 1024).toFixed(1)} KB)`,
    )
  }

  if (!options.tag) {
    // 本地构建：只产出可校验的安装包，不触碰索引
    for (const entry of entries) {
      entry.download = '' // 不生成索引时也不需要地址
    }
    console.log('\n未指定发布批次（--tag 或 RELEASE_TAG），已跳过索引生成。')
    console.log('本地安装可直接把 dist/<插件id>/<版本>/ 目录拖进工具箱，或使用 release/ 下的 zip。')
    return
  }

  const existing = loadRegistry(REGISTRY_PATH)
  const merged = mergeRegistry(
    existing,
    entries.map(entry => ({ ...entry, download: entry.download })),
    { allowRepublish: options.allowRepublish },
  )

  validateRegistry(merged.registry)
  writeRegistry(REGISTRY_PATH, merged.registry)

  // 用真实产物回读校验，确认索引与 zip 一一对应
  verifyRelease({
    registry: merged.registry,
    releaseDir: RELEASE_DIR,
    distDir: DIST_DIR,
  })

  console.log(`\n本次新增/更新 ${merged.added.length} 条，未变化 ${merged.unchanged.length} 条，`
    + `保留历史 ${merged.retained.length} 条`)
  console.log(`索引已写入 registry.json（共 ${merged.registry.plugins.length} 条）`)
  console.log('下一步：pnpm sign 生成 registry.json.sig（发布流程必须完成签名）')
}

main().catch((error) => {
  console.error(`\n构建失败：${error.message}`)
  process.exit(1)
})
