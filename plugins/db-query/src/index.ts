/** SQL 查询插件（多例工具） */

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
