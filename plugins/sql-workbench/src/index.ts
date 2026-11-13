/** SQL 工作台插件：模板配置与检索共用同一个标签页 */

import type { PluginFrontendApi } from '@toolbox/plugin-sdk'
import SqlWorkbench from './SqlWorkbench.vue'

export function activate(api: PluginFrontendApi): void {
  api.registerTool({
    type: 'sql-workbench',
    label: 'SQL 工作台',
    icon: 'document',
    multi: false,
    description: '写模板与查数一体化（单例标签，可切换配置 / 检索模式）',
    group: '数据库',
    component: SqlWorkbench,
  })

  api.log('SQL 工作台插件已激活')
}
