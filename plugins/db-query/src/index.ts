/**
 * SQL 查询插件（多例工具）。
 *
 * 多例工具通过 props.tabId / props.initialPayload 拿到自己的实例上下文：
 * 每个标签可以引用不同模板、使用不同连接，状态经 emit('change', tabId, payload)
 * 交回宿主持久化。契约与内置多例工具完全一致。
 */

import type { PluginFrontendApi } from '@toolbox/plugin-sdk'
import DbQuery from './DbQuery.vue'

export function activate(api: PluginFrontendApi): void {
  api.registerTool({
    type: 'db-query',
    label: 'SQL 查询',
    icon: 'search',
    multi: true,
    description: '按模板执行查询（多例标签，可同时打开多个）',
    group: '数据库',
    component: DbQuery,
  })

  api.log('SQL 查询插件已激活')
}
