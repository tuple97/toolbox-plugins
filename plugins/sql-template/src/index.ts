/** SQL 模板插件 */

import type { PluginFrontendApi } from '@toolbox/plugin-sdk'
import SqlTemplateView from './SqlTemplateView.vue'

export function activate(api: PluginFrontendApi): void {
  api.registerTool({
    type: 'sql-template',
    label: 'SQL 模板',
    icon: 'document',
    multi: false,
    description: '维护 SQL 模板与变量配置（单例标签）',
    group: '数据库',
    component: SqlTemplateView,
  })

  api.log('SQL 模板插件已激活')
}
