/**
 * 词典插件。
 *
 * 纯前端插件：数据读写走宿主已有的 Wails 绑定（源码里的 @/api/dictionaries
 * 与 @/stores/dictStore 由构建期改写为访问宿主内核）。
 *
 * 注意 dictStore 是宿主共享状态：SQL 查询结果集的值翻译也依赖它，
 * 所以这里必须用宿主那一份，而不是插件自己新建缓存。
 */

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
