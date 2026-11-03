/// <reference types="vite/client" />

/*
 * 让 tsc 认识 .vue 单文件组件。
 *
 * 构建走 Vite/rollup（不做类型检查），少了这份声明的话 `tsc --noEmit`
 * 会把每个 import 组件的语句都报成「找不到模块」。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<
    Record<string, unknown>,
    Record<string, unknown>,
    unknown
  >
  export default component
}
