/**
 * SQL 执行插件（多例工具）。
 *
 * 依赖宿主内核最深的一个：CodeEditor + SQL 补全、语句切分、运行槽状态、
 * 结果表格与执行日志都来自宿主。插件本身只负责编排与交互。
 */

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
