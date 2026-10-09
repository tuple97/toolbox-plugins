/**
 * 把插件源码里对宿主内核的 `@/xxx` 导入，改写成运行时从
 * globalThis.__TOOLBOX_HOST__ 取值。
 *
 * 为什么要改写而不是做 alias 映射：
 *   ESM 的具名导入必须在编译期可静态解析，而宿主的模块表是运行期才
 *   注入的对象；Rollup 无法为一个「导出名未知」的虚拟模块生成绑定。
 *   因此在 transform 阶段把 import 语句降级成解构赋值，是唯一既保留
 *   插件源码可读性（继续写 @/stores/xxx）又能共享宿主实例的做法。
 *
 * 支持的导入形式：
 *   import { A, B as C } from '@/x'   → const { A, B: C } = HOST['@/x']
 *   import D from '@/x'               → const D = HOST['@/x'].default
 *   import D, { A } from '@/x'        → 两者都生成
 *   import * as N from '@/x'          → const N = HOST['@/x']
 *   import type { T } from '@/x'      → 整句删除（类型在产物中不存在）
 */

/**
 * 一行静态 import，且来源是宿主提供的模块。
 *
 * 两条通道：
 *   @/...             宿主自身的源码模块（stores / api / utils / components …）
 *   @wailsio/runtime  Wails 运行时（事件总线等），插件必须用宿主那一份，
 *                     自行打包会导致事件总线和底层适配器各持一套连接
 */
const HOST_IMPORT_RE
  = /^[ \t]*import\s+(type\s+)?([^'"]*?)\s*from\s*['"]((?:@\/|@wailsio\/)[^'"]+)['"]\s*;?[ \t]*$/gm

/** 宿主模块表的全局变量名 */
const HOST_GLOBAL = 'globalThis.__TOOLBOX_HOST__'

/** 生成对某个宿主模块的引用表达式 */
function hostRef(hostPath) {
  return `${HOST_GLOBAL}[${JSON.stringify(hostPath)}]`
}

/**
 * 把一条 import 的导入子句改写成等价的解构赋值。
 *
 * @param {string} clause 导入子句（大括号前后不含 from）
 * @param {string} hostPath 宿主模块路径
 * @returns {string} 替换后的语句（可能为空串）
 */
function rewriteClause(clause, hostPath) {
  const ref = hostRef(hostPath)
  const text = clause.trim()

  // import * as N
  if (text.startsWith('*')) {
    const name = text.replace(/^\*\s*as\s*/, '').trim()
    return name ? `const ${name} = ${ref};` : ''
  }

  // 拆出默认导入与具名导入
  const braceIndex = text.indexOf('{')
  let bare = braceIndex >= 0 ? text.slice(0, braceIndex) : text
  const named = braceIndex >= 0 ? text.slice(braceIndex) : ''

  bare = bare.replace(/,\s*$/, '').trim()

  const statements = []

  if (bare) {
    // 默认导入：宿主模块不一定有 default，取不到时退回模块本身
    statements.push(`const ${bare} = ${ref}.default !== undefined ? ${ref}.default : ${ref};`)
  }

  if (named) {
    const inner = named.replace(/^\{/, '').replace(/\}$/, '')
    const items = inner
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
      // 内联类型限定符（`type T` / `type T as U`）在产物里不存在，直接丢弃
      .filter(item => !/^type\s/.test(item))
      .map((item) => {
        // A as B → A: B
        const alias = item.match(/^(\S+)\s+as\s+(\S+)$/)
        return alias ? `${alias[1]}: ${alias[2]}` : item
      })

    if (items.length > 0) {
      statements.push(`const { ${items.join(', ')} } = ${ref};`)
    }
  }

  return statements.join(' ')
}

/**
 * UI 原子组件的专门改写。
 *
 * 它们通过 activate(api) 的 api.ui 暴露（而不是宿主模块表），
 * 因为插件用到的 UI 组件应当走公开接口，而宿主模块表是官方插件的
 * 内部通道；把 ui 排除在模块表外，可以顺带避免两套引用并存。
 *
 *   import Button from '@/components/ui/Button.vue'
 *     → const Button = globalThis.__TOOLBOX__.ui["Button"]
 */
function rewriteUiClause(clause, hostPath) {
  const name = hostPath.slice('@/components/ui/'.length).replace(/\.vue$/, '')
  const ref = `globalThis.__TOOLBOX__.ui[${JSON.stringify(name)}]`
  const text = clause.trim()

  if (text.startsWith('{')) {
    throw new Error(`UI 组件只有默认导出，不应具名导入: ${hostPath}`)
  }

  const bare = text.replace(/,\s*$/, '').trim()
  if (!bare) {
    return ''
  }
  return `const ${bare} = ${ref};`
}

/** 改写一段脚本代码；返回是否发生了变更 */
function rewriteScript(code) {
  let changed = false
  const out = code.replace(HOST_IMPORT_RE, (match, typeOnly, clause, hostPath) => {
    changed = true
    // 类型导入在产物里没有意义，直接删除整句
    if (typeOnly) {
      return ''
    }
    if (hostPath.startsWith('@/components/ui/')) {
      return rewriteUiClause(clause, hostPath)
    }
    return rewriteClause(clause, hostPath)
  })
  return { code: out, changed }
}

/** 改写 SFC 里的 script 块 */
function rewriteSfc(code) {
  let changed = false
  const out = code.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/g,
    (match, attrs, body) => {
      const result = rewriteScript(body)
      if (result.changed) {
        changed = true
      }
      return `<script${attrs}>${result.code}</script>`
    },
  )
  return { code: out, changed }
}

/** Vite 插件：把宿主导入改写成运行时取值 */
export function hostImports() {
  return {
    name: 'toolbox-host-imports',
    // 必须早于 @vitejs/plugin-vue：SFC 一旦被编译成 JS，
    // script 块结构就不复存在，改写会变得不可靠
    enforce: 'pre',

    transform(code, id) {
      const cleanId = id.split('?')[0]
      if (cleanId.includes('node_modules')) {
        return null
      }

      let result
      if (cleanId.endsWith('.vue')) {
        result = rewriteSfc(code)
      }
      else if (/\.(ts|tsx|js|jsx|mts|mjs)$/.test(cleanId)) {
        result = rewriteScript(code)
      }
      else {
        return null
      }

      if (!result.changed) {
        return null
      }
      // mappings 置空：改写只调整语句形态，不改变行号语义
      return { code: result.code, map: { mappings: '' } }
    },
  }
}

export default hostImports
