/** 视图 → 插件上下文的桥 */
import type { PluginFrontendApi } from '@toolbox/plugin-sdk'

let current: PluginFrontendApi | null = null

/** 由 index.ts 在 activate 时调用 */
export function setPluginApi(api: PluginFrontendApi): void {
  current = api
}

/** 调用本插件后端 handler */
export function invoke<T>(handler: string, args: unknown = {}): Promise<T> {
  if (!current) {
    return Promise.reject(new Error('插件尚未激活'))
  }
  return current.host.invoke<T>(handler, args)
}
