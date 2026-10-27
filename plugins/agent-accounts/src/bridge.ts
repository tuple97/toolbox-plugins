/**
 * 视图 → 插件上下文的桥。
 *
 * 工具视图由宿主按组件渲染，拿不到 activate(api) 的上下文，
 * 这里由 index.ts 在激活时注入一次。
 */
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
