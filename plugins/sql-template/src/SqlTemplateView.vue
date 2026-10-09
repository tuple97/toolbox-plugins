<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import Combobox from '@/components/ui/Combobox.vue'
import Icon from '@/components/ui/Icon.vue'
import Input from '@/components/ui/Input.vue'
import Switch from '@/components/ui/Switch.vue'
import TabGroup from '@/components/ui/TabGroup.vue'
import Tag from '@/components/ui/Tag.vue'
import { askConfirm } from '@/utils/confirm'
import { notify } from '@/utils/notify'
import { Events } from '@wailsio/runtime'
import { EventsOn } from '@/api/runtime'
import { useConfigStore } from '@/stores/configStore'
import { useTabStore } from '@/stores/tabStore'
import { matchesShortcut, shortcutOf } from '@/utils/shortcuts'
import type { EditorView } from '@codemirror/view'
import CodeEditor from '@/components/CodeEditor.vue'
import { registerScriptGlobals } from '@/utils/sql/sqlCompletion'
import type { CompletionRuntime } from '@/utils/sql/sqlCompletion'
import { templateVariablesOf } from '@/utils/sql/template/templateVariables'
import VariableConfigPanel from '@/components/VariableConfigPanel.vue'
import FieldMappingPanel from '@/components/FieldMappingPanel.vue'
import ExportTemplatePanel from '@/components/ExportTemplatePanel.vue'
import SqlSnippetPicker from '@/components/SqlSnippetPicker.vue'
import ConnectionSelect from '@/components/ConnectionSelect.vue'
import {
  extractVariables,
  fetchTemplate,
  fetchTemplateList,
  persistTemplate,
  removeTemplate,
  validateScript,
  validateTemplate,
} from '@/api/templates'
import type { TemplateCheckResult } from '@/api/templates'
import { fetchConnections } from '@/api/db'
import { dialectOf } from '@/utils/sql/rowSql'
import { filterDatabaseInfos, parseShowSystemDatabases } from '@/utils/sql/sqlVisibility'
import { useMetadataStore } from '@/stores/metadataStore'
import type { SqlSnippet } from '@/utils/sql/sqlSnippets'
import type {
  DatabaseInfo,
  DBConnection,
  ExportTemplate,
  FieldMapping,
  SQLTemplate,
  TemplateListItem,
  VariableConfig,
} from '@/types'

/**
 * SQL 模板管理（单例标签页）。
 *
 * 与其他标签的关系：模板增删改后广播 `templates:changed`，
 * SQL 查询标签页据此刷新模板下拉与当前模板配置
 * （变量表单由模板驱动，模板改了配置也变了）。
 */

const emit = defineEmits<{
  /** 首次加载完成（父级据此关闭 loading 遮罩） */
  (e: 'ready'): void
}>()
const configStore = useConfigStore()
const tabStore = useTabStore()
/** 元数据缓存：补全候选的数据来源，与连接管理 / 查询页共用同一份 */
const metadataStore = useMetadataStore()

function handleSaveShortcut(event: KeyboardEvent) {
  // 本页面隐藏时实例仍保留，不能和连接/词典页共同响应 Ctrl+S。
  if (tabStore.activeSingleton !== 'sql-template') return
  if (event.defaultPrevented) return
  if (!matchesShortcut(event, shortcutOf('save-template', configStore.values.shortcut_config))) return
  event.preventDefault()
  void handleSave()
}

/** 模板列表 */
const templates = ref<TemplateListItem[]>([])
/** 连接列表 */
const connections = ref<DBConnection[]>([])
/** 当前编辑的模板 ID；0 表示新建 */
const editingId = ref(0)
const loading = ref(false)
const saving = ref(false)

/** 编辑中的表单 */
const form = reactive({
  name: '',
  connId: 0 as number,
  sqlText: '',
  /** 模板自带的库；空表示用连接配置里的默认库 */
  database: '',
  variables: '[]',
  fieldMappings: '[]',
  preScript: '',
  postScript: '',
  /** 是否启用：停用的模板不允许执行，默认启用 */
  enabled: true,
})

/** 变量配置、字段映射与导出模板（解析后的对象形式） */
const variableConfigs = ref<VariableConfig[]>([])
const fieldMappings = ref<FieldMapping[]>([])
const exportTemplates = ref<ExportTemplate[]>([])

/** 检测到的变量名 */
const detectedVariables = ref<string[]>([])
/** 配置区当前页签，默认落在变量配置 */
const configTab = ref('variables')

/**
 * 配置区页签。
 *
 * `lazy`：未激活不挂载 —— 避免隐藏的编辑器 / 面板在每次切换模板时被无谓更新
 * （两个脚本编辑器都是 CodeMirror 实例，代价不小）。
 */
const CONFIG_TABS = [
  { value: 'variables', label: '变量配置', lazy: true },
  { value: 'fields', label: '字段映射', lazy: true },
  { value: 'exports', label: '导出模板', lazy: true },
  { value: 'pre', label: '前置脚本', lazy: true },
  { value: 'post', label: '后置脚本', lazy: true },
]

// ------------------------------------------------------------ 加载

async function loadTemplates() {
  loading.value = true
  try {
    templates.value = await fetchTemplateList()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    loading.value = false
  }
}

async function loadConnections() {
  try {
    connections.value = await fetchConnections()
  }
  catch {
    connections.value = []
  }
}

/** 载入模板到编辑区 */
async function loadTemplate(id: number) {
  try {
    const tpl = await fetchTemplate(id)
    editingId.value = tpl.id
    form.name = tpl.name
    form.connId = tpl.connId
    form.sqlText = tpl.sqlText
    form.database = tpl.database ?? ''
    form.preScript = tpl.preScript
    form.postScript = tpl.postScript
    form.enabled = tpl.enabled !== false

    variableConfigs.value = parseJSON<VariableConfig[]>(tpl.variables, [])
    fieldMappings.value = reuseUnchanged(parseJSON<FieldMapping[]>(tpl.fieldMappings, []))
    exportTemplates.value = parseJSON<ExportTemplate[]>(tpl.exportTemplates, [])

    await refreshVariables()
    // 存的模板也可能带语法错误（旧数据 / 手工改库），载入后立刻标出来
    await checkTemplate()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 安全解析 JSON，失败时返回兜底值并提示 */
function parseJSON<T>(raw: string, fallback: T): T {
  if (!raw) {
    return fallback
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T) : fallback
  }
  catch {
    notify.warning('模板中的配置 JSON 解析失败，已重置为空')
    return fallback
  }
}

/**
 * 复用与上一份配置内容相同（按 column 匹配）的映射对象。
 * 引用不变配合 FieldMappingPanel 的 v-memo，可以让未变化的行跳过 patch，
 * 避免映射条目多时（如 72 列结果集）每次选模板都全量重渲染。
 */
function reuseUnchanged(next: FieldMapping[]): FieldMapping[] {
  const prev = new Map(fieldMappings.value.map(m => [m.column, m]))
  return next.map((item) => {
    const old = prev.get(item.column)
    return old && JSON.stringify(old) === JSON.stringify(item) ? old : item
  })
}

// ------------------------------------------------------------ 变量解析

/** 重新解析 SQL 中的变量，保留已有配置 */
async function refreshVariables() {
  if (!form.sqlText.trim()) {
    detectedVariables.value = []
    variableConfigs.value = []
    return
  }

  try {
    const names = await extractVariables(form.sqlText)
    detectedVariables.value = names

    const existing = new Map(variableConfigs.value.map(c => [c.name, c]))
    variableConfigs.value = names.map(name =>
      existing.get(name) ?? {
        name,
        label: name,
        component: 'input' as const,
        dataType: 'string' as const,
      },
    )
  }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // 模板语法错误不弹窗：编辑时半成品语法很常见，位置已在编辑器上用波浪线标出
    if (!message.includes('模板语法错误')) {
      notify.error(message)
    }
  }
}

/**
 * 校验模板语法，把错误标在编辑器上（底部红色波浪线）。
 *
 * 刻意**不弹提示框**：编辑过程中半成品语法很常见，弹窗只会打断输入，
 * 而且「模板语法错误」这种文案定位不到位置，不如直接在出错的那一行划线。
 */
async function checkTemplate() {
  const text = form.sqlText
  try {
    const result = await validateTemplate(text)
    applyCheckResult(text, result)
  }
  catch {
    // 校验请求失败（服务未就绪等）：不打扰编辑，等下一次防抖再试
  }
}

/** 把校验结果画到编辑器上 */
function applyCheckResult(text: string, result: TemplateCheckResult) {
  // 校验期间用户又改了内容：丢弃这次结果，等下一次防抖
  if (text !== form.sqlText) {
    return
  }

  if (result.valid) {
    sqlEditorRef.value?.setErrors([])
    return
  }
  sqlEditorRef.value?.setErrors([{
    // 拿不到行号时退到第一行：至少有个入口能看到消息（悬停可看）
    line: result.line > 0 ? result.line : 1,
    column: result.column,
    message: result.message || '模板语法错误',
  }])
}

/** SQL 变化后防抖重新解析与校验 */
let parseTimer: number | null = null
function scheduleParse() {
  if (parseTimer !== null) {
    window.clearTimeout(parseTimer)
  }
  parseTimer = window.setTimeout(() => {
    parseTimer = null
    void refreshVariables()
    void checkTemplate()
  }, 500)
}

// ------------------------------------------------------------ 增删改

/** 广播模板变更，供其他标签页（SQL 查询）刷新模板列表与配置 */
function notifyChanged() {
  void Events.Emit('templates:changed')
}

/** 新建模板 */
function handleCreate() {
  editingId.value = 0
  form.name = ''
  form.connId = connections.value[0]?.id ?? 0
  form.sqlText = ''
  form.database = ''
  form.preScript = ''
  form.postScript = ''
  form.enabled = true
  variableConfigs.value = []
  fieldMappings.value = []
  exportTemplates.value = []
  detectedVariables.value = []
  sqlEditorRef.value?.setErrors([])
}

/** 保存模板 */
async function handleSave() {
  if (!form.name.trim()) {
    notify.warning('请输入模板名称')
    return
  }
  if (!form.connId) {
    notify.warning('请选择所属连接')
    return
  }
  if (!form.sqlText.trim()) {
    notify.warning('SQL 内容不能为空')
    return
  }

  /*
   * 保存前校验模板语法：失败时在编辑器上标出出错位置并滚动过去，不弹提示框
   * （校验请求本身失败时放行，避免因为一次请求异常就保存不了）。
   */
  try {
    const check = await validateTemplate(form.sqlText)
    if (!check.valid) {
      sqlEditorRef.value?.setErrors([{
        line: check.line > 0 ? check.line : 1,
        column: check.column,
        message: check.message || '模板语法错误',
      }], { reveal: true })
      return
    }
  }
  catch {
    // 忽略：校验不可用时不阻塞保存
  }

  // 保存前校验脚本语法，避免存入不可用脚本
  try {
    await validateScript(form.preScript)
    await validateScript(form.postScript)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
    return
  }

  // 导出模板同样要在保存前拦下：菜单里点一下就会渲染并复制，
  // 存进去一段渲染不了的模板，出错时机就被推到了「用的时候」
  for (const item of exportTemplates.value) {
    if (!item.name.trim()) {
      notify.warning('导出模板名称不能为空')
      return
    }
    if (!item.content.trim()) {
      notify.warning(`导出模板「${item.name}」的内容不能为空`)
      return
    }
    try {
      const check = await validateTemplate(item.content)
      if (!check.valid) {
        notify.warning(`导出模板「${item.name}」语法错误：${check.message || '请检查模板写法'}`)
        return
      }
    }
    catch {
      // 校验不可用时不阻塞保存（与 SQL 模板一致）
    }
  }

  saving.value = true
  try {
    const payload: SQLTemplate = {
      id: editingId.value,
      connId: form.connId,
      name: form.name.trim(),
      sqlText: form.sqlText,
      database: form.database,
      variables: JSON.stringify(variableConfigs.value),
      fieldMappings: JSON.stringify(fieldMappings.value),
      exportTemplates: JSON.stringify(exportTemplates.value),
      preScript: form.preScript,
      postScript: form.postScript,
      enabled: form.enabled,
    }

    const id = await persistTemplate(payload)
    editingId.value = id
    notify.success('模板已保存')
    await loadTemplates()
    notifyChanged()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    saving.value = false
  }
}

/** 删除模板 */
async function handleDelete(item: TemplateListItem) {
  /*
   * 取消是正常分支。旧写法靠 `catch (e) { if (e !== 'cancel') ... }` ——
   * 用一个魔法字符串区分「用户取消」和「真出错」，多一个字少一个字都会吞掉真错误。
   */
  const confirmed = await askConfirm({
    message: `确定删除模板「${item.name}」吗？引用它的标签页将无法再执行。`,
    title: '删除模板',
    confirmText: '删除',
    tone: 'danger',
  })
  if (!confirmed) {
    return
  }

  try {
    await removeTemplate(item.id)

    // 删除的正是当前编辑的模板时，重置编辑区
    if (editingId.value === item.id) {
      handleCreate()
    }
    notify.success('已删除')
    await loadTemplates()
    notifyChanged()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

// ------------------------------------------------------------ 编辑器补全上下文

/**
 * 模板 SQL 编辑器的补全上下文（每页定向扩展）。
 *
 * 两样东西都是「按需实时求值」：
 *  - `sql`：模板所属连接的表 / 列元数据（连接从模板配置来，方言从连接对象取，
 *    **库取上面那个库下拉的生效库**：所选库优先、未选回落连接默认库）；
 *  - `templateVariables`：本模板的变量配置（含值类型，供参数位与点号取值使用）。
 *
 * 因为写成了函数，改连接、改库、改变量配置后补全立即跟着变，不需要重建编辑器。
 */
function templateCompletionContext(): Partial<CompletionRuntime> {
  return {
    sql: completionSqlContext(),
    templateVariables: templateVariablesOf(variableConfigs.value),
  }
}

/**
 * 补全用的 SQL 上下文（连接 + 生效库 + 方言）；未绑定连接时为 undefined。
 *
 * 模板编辑器与导出模板编辑器共用它 —— 两处的「当前连接 / 当前库」本就是同一个，
 * 差别只在模板编辑器还要额外给模板变量候选（导出模板里的 `{{ }}` 是结果列）。
 */
function completionSqlContext() {
  const conn = templateConnection.value
  return conn
    ? { connId: conn.id, database: effectiveDatabase.value, dbType: conn.dbType }
    : undefined
}

/** 导出模板编辑器的补全上下文：同一套连接 / 库，不给模板变量 */
function exportCompletionContext(): Partial<CompletionRuntime> {
  return { sql: completionSqlContext() }
}

/** 模板当前绑定的连接（补全上下文与编辑器方言都用它） */
const templateConnection = computed(
  () => connections.value.find(item => item.id === form.connId) ?? null,
)

/** 编辑器方言：跟随模板绑定的连接 */
const templateConnectionDbType = computed(() => templateConnection.value?.dbType ?? '')

// ------------------------------------------------------------ 补全用的「当前库」

/**
 * 模板自带的库（`form.database`，随模板保存）。
 *
 * 为什么需要它：表名候选只按「当前库」去查（`metadata.tables(connId, database)`），
 * 编辑器原先的当前库取的是**连接配置里的默认库** —— 连接没填默认库时，
 * 后端会拿空库名去过滤 `table_schema`（MySQL 下查不到任何表），
 * 于是 `SELECT * FROM |` 只有库名候选、没有表名。这里补上库选择，
 * 语义与 SQL 查询页 / 命令执行器完全一致：**空 = 用连接默认库**。
 *
 * 存进模板后，SQL 查询页选到这个模板时会拿它作为默认选中的库（见 DbQuery）。
 */

/**
 * 库列表：直接读共享的元数据缓存（与连接管理页 / 查询页同一份）。
 *
 * 不自己发请求的好处：缓存命中时下拉立刻有值，也不会与补全各自拉一遍。
 * 拉取时机见下面 connId 的 watcher。
 */
const databases = computed<DatabaseInfo[]>(() => {
  const conn = templateConnection.value
  return conn ? metadataStore.databaseInfos[conn.id] ?? [] : []
})

/** 「展示系统库」设置：与库下拉、补全候选共用同一套可见性策略 */
const showSystemDatabases = computed(() =>
  parseShowSystemDatabases(configStore.values.sql_show_system_databases))

/** 过滤后的库列表 */
const visibleDatabases = computed(() => filterDatabaseInfos(
  databases.value,
  dialectOf(templateConnection.value?.dbType ?? 'mysql'),
  showSystemDatabases.value,
))

/** 库下拉选项 */
const databaseOptions = computed(() =>
  visibleDatabases.value.map(info => ({ label: info.name, value: info.name })))

/** 占位文案：直接写清不选时会落到哪个连接默认库 */
const databasePlaceholder = computed(() => {
  const fallback = templateConnection.value?.database
  return fallback ? `连接默认：${fallback}` : '选择数据库'
})

/** 生效库：模板自带的库优先，未配置时回落连接默认库（补全与元数据预热都用它） */
const effectiveDatabase = computed(
  () => form.database || templateConnection.value?.database || '',
)

/**
 * 用户换连接：库是跟着连接走的，换连接即清掉原来那个连接上的库名，
 * 否则补全与元数据预热会去查一个在新连接上并不存在的库。
 *
 * 只在**用户操作**时清（v-model 的 update 事件），载入模板时的程序化赋值不走这里。
 */
function handleConnectionChange() {
  form.database = ''
}

/**
 * 拉一次库列表：它同时是补全「手写 `库.`」的前提（resolveAfterDot 要按库名匹配），
 * 所以连上就拉，而不是等用户敲出来才发现缓存是空的。
 */
watch(() => form.connId, (id) => {
  if (!id) {
    return
  }
  // 失败只是没有库名候选，不打扰编辑
  void metadataStore.loadDatabases(id).catch(() => { })
}, { immediate: true })

/** 生效库变化时预热该库的表列表，候选不必等用户再敲一次才出现 */
watch(effectiveDatabase, (current) => {
  if (!form.connId || !current) {
    return
  }
  void metadataStore.loadTables(form.connId, current).catch(() => { })
}, { immediate: true })

/** 前置脚本可用的全局标识符：注入的变量名 + variables / sqlTemplate */
function handlePreScriptMount(view: EditorView) {
  registerScriptGlobals(view, () => [
    'variables',
    'sqlTemplate',
    'console',
    ...variableConfigs.value.map(item => item.name),
  ])
}

/** 后置脚本可用的全局标识符：rows */
function handlePostScriptMount(view: EditorView) {
  registerScriptGlobals(view, () => ['rows', 'console'])
}

// ------------------------------------------------------------ 片段插入

/** SQL 编辑器实例，用于在当前光标处插入片段 */
const sqlEditorRef = ref<InstanceType<typeof CodeEditor> | null>(null)
/** 片段选择弹窗 */
const snippetVisible = ref(false)

/**
 * 把片段插入到光标处。
 * 插入后编辑器会触发 change，由防抖逻辑自动重新解析变量。
 */
function insertSnippet(snippet: SqlSnippet) {
  if (!sqlEditorRef.value?.insertTemplateText(snippet.code)) {
    notify.warning('编辑器尚未就绪，请稍后再试')
    return
  }
  snippetVisible.value = false
}

// ------------------------------------------------------------ 初始化

// 标签页挂载即加载数据（标签关闭重开时会重新加载）
onMounted(async () => {
  window.addEventListener('keydown', handleSaveShortcut)
  try {
    await Promise.all([loadTemplates(), loadConnections()])

    // 默认选中列表第一项；没有模板时才进入「新建」状态
    if (templates.value.length > 0) {
      await loadTemplate(templates.value[0].id)
    }
    else {
      handleCreate()
    }
  }
  finally {
    // 失败也要上报，否则遮罩会一直盖住界面
    emit('ready')
  }
})

/**
 * 连接管理页改动连接后刷新「所属连接」下拉。
 *
 * 本页是常驻单例标签页（切换时只切显隐），只在 onMounted 拉一次连接列表；
 * 不监听的话改了连接名称 / 颜色 / 默认库之后，这里与模板编辑器的补全上下文
 * （方言、库名都取自连接对象）都还停在旧数据上。
 */
const offConnectionsChanged = EventsOn('connections:changed', async () => {
  await loadConnections()
})

onBeforeUnmount(() => {
  offConnectionsChanged()
  window.removeEventListener('keydown', handleSaveShortcut)
})
</script>

<template>
  <div class="tpl-workspace">
    <div class="tpl-mgr">
      <!-- 左：模板列表 -->
      <aside class="tpl-mgr__list">
        <div class="tpl-mgr__list-head">
          <span>模板列表</span>
          <Button size="sm" @click="handleCreate">
            <Icon name="plus" />
            <span>新建</span>
          </Button>
        </div>

        <ul class="tpl-mgr__items">
          <li v-for="item in templates" :key="item.id" class="tpl-mgr__item"
            :class="{ 'is-active': item.id === editingId }" @click="loadTemplate(item.id)">
            <div class="tpl-mgr__item-main">
              <span class="tpl-mgr__item-name">
                <span class="tpl-mgr__item-text">{{ item.name }}</span>
                <Tag v-if="!item.enabled" size="sm" tone="warning" effect="plain">已停用</Tag>
              </span>
              <code class="tpl-mgr__item-sql">{{ item.sqlText }}</code>
            </div>
            <Icon name="trash" class="tpl-mgr__item-del" title="删除" @click.stop="handleDelete(item)" />
          </li>

          <li v-if="!templates.length" class="tpl-mgr__empty">
            {{ loading ? '正在读取模板…' : '暂无模板，点击新建创建' }}
          </li>
        </ul>
      </aside>

      <!-- 右：编辑区 -->
      <section class="tpl-mgr__editor">
        <header class="tpl-mgr__editor-head">
          <Input v-model="form.name" placeholder="模板名称" class="tpl-mgr__name" />

          <!-- 启用状态：停用的模板在查询页会被标记并拒绝执行 -->
          <label class="tpl-mgr__enabled" title="停用后引用它的标签页将无法执行查询">
            <Switch v-model="form.enabled" />
            <span>{{ form.enabled ? '已启用' : '已停用' }}</span>
          </label>

          <Button :loading="saving" @click="handleSave">
            保存模板
          </Button>
        </header>

        <!-- 上方：SQL 编辑器，约占 40% -->
        <div class="tpl-mgr__sql">
          <div class="tpl-mgr__sql-label">
            <span>SQL 模板</span>

            <!--
              数据源 / 库与「插入模板」同排：这两个选择器直接决定补全候选与插入内容的归属，
              放在编辑器自己这一行，改模板时不用再回顶部找。
              模板自带的库（随模板保存）：空 = 用连接默认库。
            -->
            <div class="tpl-mgr__sql-actions">
              <ConnectionSelect v-model="form.connId" :connections="connections" placeholder="所属连接"
                class="tpl-mgr__conn" @update:model-value="handleConnectionChange" />

              <Combobox v-model="form.database" :options="databaseOptions" :placeholder="databasePlaceholder"
                search-placeholder="搜索数据库…" clearable class="tpl-mgr__db" />

              <Button variant="secondary" size="sm" class="tpl-mgr__sql-insert" @click="snippetVisible = true">
                <Icon name="plus" />
                <span>插入模板</span>
              </Button>
            </div>
          </div>
          <!-- 补全上下文：所属连接的表/列 + 本模板变量（见 templateCompletionContext） -->
          <CodeEditor ref="sqlEditorRef" v-model="form.sqlText" language="sql" completion-mode="sql-template"
            height="100%" :db-type="templateConnectionDbType" :completion-context="templateCompletionContext"
            @change="scheduleParse" />
        </div>

        <!-- 下方：配置 Tab 区 -->
        <div class="tpl-mgr__config">
          <div class="tpl-mgr__config-head">
            <span>模板配置</span>
            <Tag v-if="detectedVariables.length" size="sm" tone="info">
              检测到 {{ detectedVariables.length }} 个变量
            </Tag>
          </div>

          <TabGroup v-model="configTab" :items="CONFIG_TABS" class="tpl-mgr__tabs">
            <template #panel-variables>
              <VariableConfigPanel v-model="variableConfigs" :conn-id="form.connId || null" />
            </template>

            <template #panel-fields>
              <FieldMappingPanel v-model="fieldMappings" />
            </template>

            <template #panel-exports>
              <ExportTemplatePanel v-model="exportTemplates" :db-type="templateConnectionDbType"
                :completion-context="exportCompletionContext" />
            </template>

            <template #panel-pre>
              <p class="tpl-mgr__hint">
                <code>return &#123; variables, sqlFragment &#125;</code>
              </p>
              <CodeEditor v-model="form.preScript" language="javascript" completion-mode="javascript" height="220px"
                @mount="handlePreScriptMount" />
            </template>

            <template #panel-post>
              <p class="tpl-mgr__hint">
                <code>return &#123; rows &#125;</code>
              </p>
              <CodeEditor v-model="form.postScript" language="javascript" completion-mode="javascript" height="220px"
                @mount="handlePostScriptMount" />
            </template>
          </TabGroup>
        </div>
      </section>
    </div>

    <!-- 插入模板片段：与导出模板编辑器共用同一个弹窗（组件内自带列表与预览） -->
    <SqlSnippetPicker v-model="snippetVisible" @insert="insertSnippet" />
  </div>
</template>

<style scoped>
/* 标签页内：内容铺满可用区域，各分区内部自行滚动 */
.tpl-workspace {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.tpl-mgr {
  display: flex;
  gap: 12px;
  flex: 1;
  min-width: 0;
  min-height: 0;
  width: 100%;
  padding: 12px;
  box-sizing: border-box;
  overflow: hidden;
}

/* 左侧列表：固定宽度、占满高度，条目超出自带滚动条 */
.tpl-mgr__list {
  display: flex;
  flex-direction: column;
  flex: 0 0 260px;
  min-height: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.tpl-mgr__list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 0 0 auto;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  font-size: var(--app-font-size);
  font-weight: 600;
}

.tpl-mgr__items {
  flex: 1;
  margin: 0;
  padding: 6px;
  list-style: none;
  overflow: auto;
}

.tpl-mgr__item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.tpl-mgr__item:hover {
  background: var(--hover-bg);
}

.tpl-mgr__item.is-active {
  background: var(--active-bg);
}

.tpl-mgr__item-main {
  flex: 1;
  min-width: 0;
}

.tpl-mgr__item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--app-font-size);
}

/* 名字占满剩余宽度并省略；「已停用」标签固定在行尾不被挤掉 */
.tpl-mgr__item-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tpl-mgr__item-sql {
  display: block;
  margin-top: 3px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--app-font-size-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tpl-mgr__item-del {
  flex: 0 0 auto;
  opacity: 0;
  color: var(--text-muted);
}

.tpl-mgr__item:hover .tpl-mgr__item-del {
  opacity: 1;
}

.tpl-mgr__item-del:hover {
  color: var(--danger-color);
}

.tpl-mgr__empty {
  padding: 20px 10px;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  text-align: center;
}

/* 右侧编辑区：头部固定，SQL 区按比例，配置区吃掉剩余空间 */
.tpl-mgr__editor {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  gap: 10px;
}

.tpl-mgr__editor-head {
  display: flex;
  align-items: center;
  /* 名称 + 启用开关 + 保存：窗口窄时换行，不把控件挤出可视区 */
  flex-wrap: wrap;
  gap: 8px;
  flex: 0 0 auto;
}

.tpl-mgr__name {
  width: 220px;
}

/* SQL 编辑器标题行里的数据源（宽度落在组件根节点上） */
.tpl-mgr__conn {
  width: 200px;
}

/* 补全用的当前库（与数据源同款） */
.tpl-mgr__db {
  width: 170px;
}

/* 启用开关：开关 + 文本，整体贴住「保存模板」按钮 */
.tpl-mgr__enabled {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding: 0 2px;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  white-space: nowrap;
  cursor: pointer;
}

/* SQL 区固定占编辑区高度的 40% */
.tpl-mgr__sql {
  display: flex;
  flex-direction: column;
  flex: 0 0 40%;
  min-height: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.tpl-mgr__sql-label {
  display: flex;
  align-items: center;
  /* 数据源 / 库 + 按钮是一组，窗口窄时整体换行，不挤扁选择器 */
  flex-wrap: wrap;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color);
  font-size: var(--app-font-size-sm);
  font-weight: 600;
}

.tpl-mgr__sql-label small {
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
  font-weight: 400;
}

/* 数据源 + 库 + 「插入模板」：整体靠标题行最右侧 */
.tpl-mgr__sql-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-wrap: wrap;
}

.tpl-mgr__sql-insert .app-icon {
  margin-right: 4px;
}

.tpl-mgr__sql-label code,
.tpl-mgr__hint code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--active-bg);
  color: var(--brand-color);
  font-family: var(--font-mono);
}

.tpl-mgr__sql :deep(.cm-editor) {
  height: 100% !important;
}

.tpl-mgr__sql> :last-child {
  flex: 1;
  min-height: 0;
}

/* 配置 Tab 区吃掉剩余空间，内容超出自带滚动条 */
.tpl-mgr__config {
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  min-height: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.tpl-mgr__config-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color);
  font-size: var(--app-font-size-sm);
  font-weight: 600;
}

/* Tab 区：表头固定，内容区占满剩余空间并内部滚动 */
.tpl-mgr__tabs {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 0 12px;
}

/* 页签栏与内容区的版面由 TabGroup 自带（页签栏固定 + 内容占满剩余高度） */

.tpl-mgr__hint {
  margin: 0 0 8px;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}
</style>
