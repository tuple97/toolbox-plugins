/** JRebel 激活服务插件 */
import type { PluginFrontendApi } from '@toolbox/plugin-sdk'
import JrebelView from './JrebelView.vue'
import { setPluginApi } from './bridge'

export function activate(api: PluginFrontendApi): void {
  setPluginApi(api)

  api.registerTool({
    type: 'jrebel-server',
    label: 'JRebel 激活服务',
    icon: 'key',
    multi: false,
    description: '启动本地 JRebel 激活服务器并生成激活地址',
    group: '开发工具',
    component: JrebelView,
  })

  api.log('JRebel 激活服务插件已激活')
}
