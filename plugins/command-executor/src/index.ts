/** SQL 执行插件（多例工具） */

import type { PluginFrontendApi } from '@toolbox/plugin-sdk'
import CommandExecutorView from './CommandExecutorView.vue'

export function activate(api: PluginFrontendApi): void {
  api.registerTool({
    type: 'command-executor',
    label: 'SQL 执行',
    icon: 'terminal',
    multi: true,
    description: '自由编写并执行 SQL，支持取消与智能补全',
    group: '数据库',
    component: CommandExecutorView,
  })

  api.log('SQL 执行插件已激活')
}
