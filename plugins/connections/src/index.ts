/**
 * 连接管理插件。
 *
 * 这是「官方插件接管内置工具」的标准形态：
 *   - 工具类型与宿主内置实现同名（connections），安装后即接管该入口；
 *   - 纯前端插件（runtime.backend = "none"），后端能力通过宿主已有的
 *     Wails 绑定调用（源码里的 @/api/db 由构建期改写成宿主内核访问）；
 *   - 组件契约与内置工具一致：接收 tabId / initialPayload，向上 emit ready。
 */

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
