/*
 * 插件前端入口（ESM）。
 *
 * 约定：
 *   - 必须导出 activate(api)；宿主加载后会调用它，并把宿主能力传进来；
 *   - Vue 运行时、UI 组件库都从传入的 api 上取（api.vue / api.ui），
 *     不要在插件里再打包一份 Vue —— 多实例会破坏响应式；
 *   - 工具组件遵循与内置工具一致的契约：
 *       props:  { tabId: number, initialPayload: object }
 *       emits:  'ready'（首次初始化完成）、
 *               'change'(tabId, payload)（需要持久化的状态变化）；
 *   - 本示例用渲染函数（h）而不是 .vue 单文件，便于直接以源码目录安装。
 *     正式插件可以写 SFC，用 esbuild/vite 打包成单文件 ESM 后再发布。
 */

export function activate(api) {
  const { defineComponent, h, ref, onMounted } = api.vue
  const { Button, Input, Tag } = api.ui

  const HelloPanel = defineComponent({
    name: 'HelloPluginPanel',
    props: {
      tabId: { type: Number, required: true },
      initialPayload: { type: Object, default: () => ({}) },
    },
    emits: ['ready', 'change'],
    setup(props, { emit }) {
      // 每个标签独立恢复自己的输入内容
      const name = ref(props.initialPayload.name || '')
      const message = ref('')
      const meta = ref(null)
      const loading = ref(false)

      onMounted(() => {
        meta.value = {
          id: api.plugin.id,
          version: api.plugin.version,
        }
        // 通知宿主初始化完成（宿主据此收起加载遮罩）
        emit('ready')
      })

      async function greet() {
        loading.value = true
        try {
          const data = await api.host.invoke('greet', { name: name.value })
          message.value = data.message
          // 把需要记住的状态交回宿主，随标签一起持久化
          emit('change', props.tabId, { name: name.value })
        }
        catch (error) {
          api.host.notify.error(String(error && error.message ? error.message : error))
        }
        finally {
          loading.value = false
        }
      }

      const muted = { color: 'var(--text-muted)', fontSize: 'var(--app-font-size-sm)' }

      return () => h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          padding: '20px',
          height: '100%',
          boxSizing: 'border-box',
        },
      }, [
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
          h('strong', { style: { color: 'var(--text-color)' } }, '示例插件'),
          meta.value ? h(Tag, { tone: 'info', effect: 'plain', size: 'sm' }, { default: () => `v${meta.value.version}` }) : null,
        ]),

        h('p', { style: { ...muted, margin: 0 } },
          '这是插件体系的最小示例：界面由插件注册，逻辑跑在插件自己的后端运行时里。'),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', maxWidth: '420px' } }, [
          h(Input, {
            modelValue: name.value,
            'onUpdate:modelValue': (value) => { name.value = value },
            placeholder: '输入一个名字',
            size: 'default',
          }),
          h(Button, {
            variant: 'default',
            loading: loading.value,
            onClick: greet,
          }, { default: () => '打个招呼' }),
        ]),

        message.value
          ? h('div', {
            style: {
              padding: '10px 12px',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              background: 'var(--panel-bg)',
              color: 'var(--text-color)',
              maxWidth: '420px',
            },
          }, message.value)
          : null,

        meta.value
          ? h('p', { style: { ...muted, margin: 0 } }, `插件标识：${meta.value.id}`)
          : null,
      ])
    },
  })

  api.registerTool({
    type: 'hello-panel',
    label: '示例插件',
    icon: 'puzzle',
    multi: true,
    description: '演示插件工具视图与后端调用',
    group: '示例',
    component: HelloPanel,
  })

  api.log('前端已激活')
}
