/** Agent 账号管理插件入口。 */
import type { PluginFrontendApi } from '@toolbox/plugin-sdk'
import AccountsView from './AccountsView.vue'
import { setPluginApi } from './bridge'

export function activate(api: PluginFrontendApi): void {
  setPluginApi(api)

  api.registerTool({
    type: 'agent-accounts',
    label: 'Agent 账号',
    icon: 'chart',
    multi: false,
    description: '管理 CodeBuddy / WorkBuddy 账号，查看余量并签到',
    group: 'AI 账号',
    component: AccountsView,
  })

  api.log('Agent 账号管理插件已激活')
}
