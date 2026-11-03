/** 词典插件 */

import type { PluginFrontendApi } from '@toolbox/plugin-sdk'
import DictionaryView from './DictionaryView.vue'

export function activate(api: PluginFrontendApi): void {
  api.registerTool({
    type: 'dictionary',
    label: '词典',
    icon: 'book',
    multi: false,
    description: '维护本地词典数据（单例标签）',
    group: '本地记录',
    component: DictionaryView,
  })

  api.log('词典插件已激活')
}
