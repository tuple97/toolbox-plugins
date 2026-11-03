/** 视图 → 插件上下文的桥：激活时由 index.ts 注入。 */
import type { PluginFrontendApi } from '@toolbox/plugin-sdk'

let current: PluginFrontendApi | null = null

export function setPluginApi(api: PluginFrontendApi): void {
  current = api
}

export function invoke<T>(handler: string, args: unknown = {}): Promise<T> {
  if (!current) {
    return Promise.reject(new Error('插件尚未激活'))
  }
  return current.host.invoke<T>(handler, args)
}

/** 用系统浏览器打开链接 */
export function openExternal(url: string): void {
  current?.host.openExternal(url)
}
