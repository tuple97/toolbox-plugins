/**
 * SQL 模板插件。
 *
 * 这个插件是「插件复用宿主内核」的典型：
 * 它重度使用 CodeEditor（含完整 SQL 智能补全引擎）、元数据缓存与
 * 变量/字段映射面板，这些都由宿主提供，插件只贡献界面与交互。
 *
 * 源码里的 `@/components/CodeEditor.vue`、`@/utils/sql/*`、`@/stores/*`
 * 全部由构建期改写为从宿主内核取值，因此插件与宿主共享同一份
 * 补全引擎与缓存，不会出现两份实现。
 */

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
