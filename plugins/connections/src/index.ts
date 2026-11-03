/** 连接管理插件 */

import type { PluginFrontendApi } from '@toolbox/plugin-sdk'
import ConnectionsView from './ConnectionsView.vue'

export function activate(api: PluginFrontendApi): void {
  api.registerTool({
    type: 'connections',
    label: '连接管理',
    icon: 'link',
    multi: false,
    description: '维护数据库连接（单例标签）',
    group: '数据库',
    component: ConnectionsView,
  })

  api.log('连接管理插件已激活')
}
