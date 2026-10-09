<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import Combobox from '@/components/ui/Combobox.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Icon from '@/components/ui/Icon.vue'
import TabGroup from '@/components/ui/TabGroup.vue'
import Tag from '@/components/ui/Tag.vue'
import { notify } from '@/utils/notify'
import DynamicForm from '@/components/DynamicForm.vue'
import ResultTable from '@/components/ResultTable.vue'
import ResultPagination from '@/components/ResultPagination.vue'
import ExecutionLog from '@/components/ExecutionLog.vue'
import ContextMenu from '@/components/ContextMenu.vue'
import ConnectionSelect from '@/components/ConnectionSelect.vue'
import {
  copyRowsByExportTemplate,
  copyRowsSql,
  dialectOf,
  exportTemplateOfMenuItem,
  kindOfMenuItem,
  rowSqlMenuItems,
} from '@/utils/sql/rowSql'
import type { ResultSourceContext } from '@/utils/sql/rowSql'
import { DEFAULT_PAGE_SIZE, executeTemplateQuery, fetchTemplate, fetchTemplateList } from '@/api/templates'
import { fetchConnections } from '@/api/db'
import { fetchDatabases } from '@/api/executor'
import { EventsOn } from '@/api/runtime'
import { filterDatabaseInfos, parseShowSystemDatabases } from '@/utils/sql/sqlVisibility'
import { useConfigStore } from '@/stores/configStore'
import { useLogStore } from '@/stores/logStore'
import { useTabStore } from '@/stores/tabStore'
import type {
  ContextMenuAction,
  DatabaseInfo,
  DBConnection,
  DbQueryPayload,
  ExportTemplate,
  FieldMapping,
  QueryResult,
  TemplateListItem,
  ToolType,
  VariableConfig,
} from '@/types'

const props = defineProps<{
  /** 所属 Tab 的 ID，回传状态时一并返回 */
  tabId: number
  /** 从 Tab payload 恢复的状态 */
  initialPayload: Record<string, unknown>
}>()

const emit = defineEmits<{
  (e: 'change', tabId: number, payload: DbQueryPayload): void
  /** 首次初始化完成（父级据此关闭 loading 遮罩） */
  (e: 'ready'): void
}>()

const logStore = useLogStore()
const tabStore = useTabStore()
const configStore = useConfigStore()

/** 跳转到单例功能标签页（连接管理 / SQL 模板） */
function openTool(type: ToolType) {
  tabStore.openTool(type)
}

/** 模板列表与连接列表 */
const templates = ref<TemplateListItem[]>([])
const connections = ref<DBConnection[]>([])

/** 当前选中的模板与连接 */
const templateId = ref<number | null>(null)
const connId = ref<number | null>(null)

/** 当前模板解析出的变量配置与字段映射；由模板决定，查询页只读 */
const variableConfigs = ref<VariableConfig[]>([])
const fieldMappings = ref<FieldMapping[]>([])
/** 当前模板配置的导出模板：结果行右键「复制为…」里作为自定义选项列出 */
const exportTemplates = ref<ExportTemplate[]>([])

/** 变量值 */
const variableValues = ref<Record<string, unknown>>({})

/** 执行状态与结果 */
const result = ref<QueryResult | null>(null)
const running = ref(false)

/** 当前页码，从 1 开始 */
const page = ref(1)
/**
 * 每页条数：属于当前 Tab 的私有状态，不写入模板。
 * 这样同一个模板在不同标签页可以各用各的分页大小；0 表示不分页。
 */
const pageSize = ref(DEFAULT_PAGE_SIZE)
/** 上一次执行得到的总数，翻页时带回后端以避免重复统计 */
const lastTotal = ref(0)

// 连接管理与 SQL 模板已改为独立标签页，这里不再维护弹窗状态

const formRef = ref<{ getValues: () => Record<string, unknown> } | null>(null)

// -------------------------------------------------- 结果区页签 / 结果行右键菜单

/** 条件区容器：结果区高度计算用 */
const formPanelRef = ref<HTMLElement | null>(null)

/** 结果区页签：log = 执行日志（固定），result = 查询结果 */
const activeTab = ref('log')

/** 结果区页签定义（日志懒挂载：没打开过就不去渲染日志面板） */
const resultTabs = [
  { value: 'log', label: '执行日志', lazy: true },
  { value: 'result', label: '查询结果' },
]

/**
 * 模板下拉的选中值：Combobox 用 string 做 v-model，这里做一层转换。
 * 置空（清空按钮）同样会经过 setter，于是「清空模板」与 `watch(templateId)`
 * 那套「重载配置 + 回第一页」的逻辑完全一致，不用再写一遍。
 */
const templateSelection = computed({
  get: () => (templateId.value === null ? '' : String(templateId.value)),
  set: (value: string) => {
    templateId.value = value === '' ? null : Number(value)
  },
})

/**
 * 模板下拉选项。
 *
 * 停用的模板仍然列出（配置还在，直接藏起来会让人以为模板丢了），
 * 只在名字上标注出来；选中后执行会被拦住并说明原因。
 */
const templateOptions = computed(() =>
  templates.value.map(tpl => ({
    label: tpl.enabled ? tpl.name : `${tpl.name}（已停用）`,
    value: String(tpl.id),
  })))

/** 日志页签组件引用：切到该页签时把日志滚到底部 */
const logRef = ref<InstanceType<typeof ExecutionLog> | null>(null)

watch(activeTab, async (tab) => {
  if (tab === 'log') {
    await nextTick()
    logRef.value?.scrollToBottom()
  }
})

/**
 * 结果来源：解析表名（复制为 UPDATE / DELETE）与表头标记主键共用一套口径。
 *
 * 单独抽出来是为了**只有一处**知道「这条结果对应哪个连接 / 哪个库」——
 * 表名解析与主键查询对它的要求完全一样，两处各写一遍迟早写岔。
 */
function sourceOf(res: QueryResult): ResultSourceContext {
  return {
    connId: connId.value,
    // 库的口径与执行一致：先看本次请求选的库，再看结果回带的生效库，最后连接默认库
    database: database.value || res.database || currentConnection.value?.database || '',
    dbType: currentConnection.value?.dbType ?? 'mysql',
    sql: res.sql,
  }
}

/** 给结果区用的来源（无结果时为 null，表头也就不去查主键） */
const resultSource = computed(() => (result.value ? sourceOf(result.value) : null))

/** 结果表格右键菜单：位置与要作用的行（多选时是多行） */
const rowMenuVisible = ref(false)
const rowMenuX = ref(0)
const rowMenuY = ref(0)
const rowMenuRows = ref<Record<string, unknown>[]>([])

/** 菜单项：内置 INSERT / UPDATE / DELETE，加上当前模板配置的导出模板 */
const rowMenuItems = computed(() =>
  rowSqlMenuItems(Math.max(1, rowMenuRows.value.length), exportTemplates.value))

/** 打开结果行右键菜单（内容为「复制为 INSERT / UPDATE / DELETE」） */
function openRowMenu(payload: {
  row: Record<string, unknown>
  rows: Record<string, unknown>[]
  x: number
  y: number
}) {
  rowMenuRows.value = payload.rows
  rowMenuX.value = payload.x
  rowMenuY.value = payload.y
  rowMenuVisible.value = true
}

/** 处理「复制为…」：内置项按行生成 SQL，导出模板按模板逐行渲染 */
async function handleRowMenuSelect(item: ContextMenuAction) {
  const rows = rowMenuRows.value
  const data = result.value
  if (!rows.length || !data) {
    return
  }

  // 自定义导出模板：入参就是结果行，由后端按模板渲染（与内置三项并列）
  const exportTemplate = exportTemplateOfMenuItem(item.key, exportTemplates.value)
  if (exportTemplate) {
    await copyRowsByExportTemplate(exportTemplate, rows)
    return
  }

  const kind = kindOfMenuItem(item.key)
  if (!kind) {
    return
  }
  // 选中的每一行共用同一套上下文，只有 row 不同（表名与主键在生成时只解析一次）
  const base = { ...sourceOf(data), columns: data.columns.map(column => column.name) }
  await copyRowsSql(kind, rows.map(row => ({ ...base, row })))
}

/** 当前选中的模板项 */
const currentTemplate = computed(
  () => templates.value.find(t => t.id === templateId.value) ?? null,
)

/** 当前连接对象，用于日志展示连接名 */
const currentConnection = computed(
  () => connections.value.find(c => c.id === connId.value) ?? null,
)

/**
 * 库选择：空 = 连接默认库。查询结果的描述 / 来源表、生成 SQL 的库名都跟随它。
 *
 * 「不静默改变选择」的约定与执行器一致：每个连接记住上一次用过的库，
 * 切回来按它恢复；库列表加载失败或不含已选库时**保留选择**，绝不悄悄回落。
 */
/** 库列表：后端返回的原始列表（含系统库），是否展示由设置决定 */
const databases = ref<DatabaseInfo[]>([])
const database = ref('')
const lastDatabaseByConn = new Map<number, string>()

/**
 * 「展示系统库」设置。
 *
 * 与命令执行器 / 元数据弹窗 / 补全候选同一套策略（utils/sql/sqlVisibility）：
 * 后端总是返回全部库并只打「系统库」标记，隐藏与否是前端展示层的事。
 */
const showSystemDatabases = computed(() =>
  parseShowSystemDatabases(configStore.values.sql_show_system_databases))

/** 过滤后的库列表：与其它页面口径一致，关闭设置后不再列出系统库 */
const visibleDatabases = computed(() =>
  filterDatabaseInfos(databases.value, dialectOf(currentConnection.value?.dbType ?? 'mysql'), showSystemDatabases.value))

/** 库下拉选项 */
const databaseOptions = computed(() =>
  visibleDatabases.value.map(info => ({ label: info.name, value: info.name })))

const databaseSelection = computed({
  get: () => database.value,
  set: (value: string) => {
    database.value = value
    if (connId.value) {
      lastDatabaseByConn.set(connId.value, value)
    }
  },
})

/** 占位文案：直接写清不选时会落到哪个连接默认库 */
const databasePlaceholder = computed(() => {
  const fallback = currentConnection.value?.database
  return fallback ? `连接默认：${fallback}` : '选择数据库'
})

/** 库列表（跟随所选连接）；失败清空列表但不动已选的库 */
async function loadDatabases() {
  if (!connId.value) {
    databases.value = []
    return
  }
  try {
    databases.value = await fetchDatabases(connId.value)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
    databases.value = []
  }
}

// ------------------------------------------------------------ 加载

async function loadTemplates() {
  try {
    templates.value = await fetchTemplateList()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

async function loadConnections() {
  try {
    connections.value = await fetchConnections()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/**
 * 载入模板配置。
 *
 * 变量表单由模板中的变量配置驱动，因此需要拉取模板完整内容；
 * 同时把模板自带的连接与库带过来作为默认选中项。
 */
async function loadTemplateConfig(id: number | null) {
  if (!id) {
    variableConfigs.value = []
    fieldMappings.value = []
    exportTemplates.value = []
    pageSize.value = DEFAULT_PAGE_SIZE
    return
  }

  try {
    const tpl = await fetchTemplate(id)
    variableConfigs.value = parseJSON<VariableConfig[]>(tpl.variables, [])
    fieldMappings.value = parseJSON<FieldMapping[]>(tpl.fieldMappings, [])
    exportTemplates.value = parseJSON<ExportTemplate[]>(tpl.exportTemplates, [])

    // 连接未显式选择时，跟随模板配置
    if (!connId.value && tpl.connId) {
      connId.value = tpl.connId
    }

    /*
     * 库：模板配了自带库就以它为准（换模板即默认选中该模板的库）；
     * 模板没配库时**保持查询页当前的选择**，不做「清空成连接默认库」这种静默改变。
     *
     * 同时要把它记进 lastDatabaseByConn：connId 的 watcher 是按这张记忆表恢复库的，
     * 上面「从模板取连接」的那一步会触发它 —— 不记的话刚设好的库会被覆盖回空。
     */
    if (tpl.database) {
      database.value = tpl.database
      if (connId.value) {
        lastDatabaseByConn.set(connId.value, tpl.database)
      }
    }
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
    variableConfigs.value = []
    fieldMappings.value = []
    exportTemplates.value = []
    pageSize.value = DEFAULT_PAGE_SIZE
  }
}

/** 安全解析 JSON */
function parseJSON<T>(raw: string, fallback: T): T {
  if (!raw) {
    return fallback
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T) : fallback
  }
  catch {
    return fallback
  }
}

// ------------------------------------------------------------ 执行

/**
 * 执行查询。
 *
 * targetPage 为要查询的页码；页大小为 0（不分页）时忽略页码。
 * reuseTotal 为真表示翻页：沿用上次的总数，后端不再重复统计，
 * 只有重新执行（新条件、改页大小、换模板/连接）时才重新统计。
 */
async function handleRun(targetPage = 1, reuseTotal = false) {
  if (!templateId.value) {
    notify.warning('请先选择 SQL 模板')
    return
  }
  /*
   * 停用的模板不允许执行。后端也会拦（见 DBService.ExecuteTemplateQuery），
   * 这里先就地说明原因，省掉一次必然失败的请求。
   */
  if (currentTemplate.value && !currentTemplate.value.enabled) {
    notify.warning(`模板「${currentTemplate.value.name}」已停用，请先在 SQL 模板管理中启用`)
    return
  }
  if (!connId.value) {
    notify.warning('请选择数据库连接')
    return
  }

  running.value = true
  const values = formRef.value?.getValues() ?? variableValues.value
  // 页大小为 0 表示不分页：页码传 0，后端不会追加 LIMIT
  const requestPage = pageSize.value > 0 ? Math.max(targetPage, 1) : 0

  try {
    // 只传模板 ID 与变量值；SQL 与脚本由后端从模板读取。
    // 库传所选的（空 = 连接默认库），后端会把它钉在会话上并随结果回带生效库。
    const data = await executeTemplateQuery({
      templateId: templateId.value,
      connId: connId.value,
      variables: values,
      database: database.value,
      page: requestPage,
      pageSize: pageSize.value,
      total: reuseTotal ? lastTotal.value : 0,
      countTotal: !reuseTotal,
    })
    result.value = data
    lastTotal.value = data.total
    // 查询成功自动切到结果页签（日志页签只是过程记录，不该挡住结果）
    activeTab.value = 'result'
    // 以服务端返回的页码为准，避免页码越界后界面与数据不一致
    page.value = data.page > 0 ? data.page : 1
    if (data.pageSize > 0) {
      pageSize.value = data.pageSize
    }

    // 记录请求与响应，便于排查
    logStore.logRequest(
      currentConnection.value?.name ?? String(connId.value),
      data.sql,
    )
    logStore.logSuccess(data.rowCount, data.elapsedMs)

    if (data.truncated) {
      notify.warning(`结果超过上限，仅展示前 ${data.rowCount} 行`)
    }
  }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    result.value = null
    logStore.logError(message)
    /*
     * 模板语法错误只在日志里留痕、不再弹窗：
     * 查询页改不了模板（SQL 由模板决定），弹窗除了打扰没别的用途，
     * 出错位置会在「SQL 模板」页的编辑器里以红色波浪线标出。
     */
    if (!message.includes('模板语法错误')) {
      notify.error(message)
    }
  }
  finally {
    running.value = false
  }
}

/**
 * 翻页：沿用上次统计到的总数，后端不再重复统计。
 */
function changePage(target: number) {
  if (pageSize.value <= 0) {
    return
  }
  void handleRun(target, true)
}

/**
 * 修改每页条数（0 表示不分页）：回到第一页重新查询。
 *
 * 分页 ↔ 不分页之间切换时总数口径不同（不分页返回的 total 只是本次行数），
 * 因此这种情况必须重新统计；都在分页状态且已有总数时可以复用。
 */
function changePageSize(size: number) {
  if (size === pageSize.value) {
    return
  }
  const reuseTotal = size > 0 && pageSize.value > 0 && lastTotal.value > 0
  pageSize.value = size
  page.value = 1
  void handleRun(1, reuseTotal)
}

// ------------------------------------------------------------ 状态同步

/**
 * 上次上报的状态指纹，用于去重。
 * 工具回传状态会触发父组件保存，若不去重极易与渲染形成循环。
 */
let lastEmittedSignature = ''

/**
 * 上报当前状态。
 * 变量值直接读表单实例，不再维护额外的响应式镜像——
 * 镜像每次收到新对象都会触发 watch，是渲染循环的常见来源。
 */
function notifyChange() {
  const values = formRef.value?.getValues() ?? variableValues.value

  const payload: DbQueryPayload = {
    templateId: templateId.value,
    connId: connId.value,
    variableValues: values,
    pageSize: pageSize.value,
  }

  const signature = JSON.stringify(payload)
  if (signature === lastEmittedSignature) {
    return
  }
  lastEmittedSignature = signature

  emit('change', props.tabId, payload)
}

/** 模板/连接/每页条数变化时上报；变量值由表单的 change 事件主动触发上报 */
watch(
  () => JSON.stringify([templateId.value, connId.value, pageSize.value]),
  () => notifyChange(),
)

/** 切换模板时重新加载其配置，并回到第一页 */
watch(templateId, id => {
  void loadTemplateConfig(id)
  result.value = null
  page.value = 1
  lastTotal.value = 0
})

/** 切换连接后原结果不再对应当前库，清空并重置分页；库选择按连接恢复 */
watch(connId, async (id) => {
  result.value = null
  page.value = 1
  lastTotal.value = 0
  database.value = id ? (lastDatabaseByConn.get(id) ?? '') : ''
  await loadDatabases()
})

/**
 * 其他标签页的数据变更通知。
 *
 * 连接管理 / SQL 模板是独立的单例标签页，改动后通过事件广播；
 * 这里据此刷新下拉与当前引用模板的配置（变量表单由模板驱动）。
 */
const offTemplatesChanged = EventsOn('templates:changed', async () => {
  await loadTemplates()
  if (templateId.value) {
    await loadTemplateConfig(templateId.value)
  }
})

const offConnectionsChanged = EventsOn('connections:changed', async () => {
  await loadConnections()
  // 连接编辑可能改了默认库 / 可见库：刷新列表（不动已选的库）
  await loadDatabases()
})

onBeforeUnmount(() => {
  offTemplatesChanged()
  offConnectionsChanged()
})

// ------------------------------------------------------------ 生命周期

onMounted(async () => {
  try {
    // 恢复上次状态
    templateId.value = (props.initialPayload.templateId as number) ?? null
    connId.value = (props.initialPayload.connId as number) ?? null
    variableValues.value =
      (props.initialPayload.variableValues as Record<string, unknown>) ?? {}
    // 每页条数是本标签的私有状态，从 payload 恢复（0 是合法值：不分页，不能用 || 兜底）
    if (props.initialPayload.pageSize !== undefined) {
      const savedPageSize = Number(props.initialPayload.pageSize)
      if (Number.isFinite(savedPageSize) && savedPageSize >= 0) {
        pageSize.value = savedPageSize
      }
    }

    await Promise.all([loadTemplates(), loadConnections()])

    if (templateId.value) {
      await loadTemplateConfig(templateId.value)
    }
  }
  finally {
    // 失败也要上报，否则遮罩会一直盖住界面
    emit('ready')
  }
})
</script>

<template>
  <div ref="rootRef" class="db-query">
    <!-- 顶部操作栏：选模板 → 选连接 → 执行 -->
    <header class="db-query__toolbar">
      <div class="db-query__toolbar-left">
        <Combobox v-model="templateSelection" :options="templateOptions" placeholder="选择 SQL 模板"
          search-placeholder="搜索模板…" clearable class="w-[240px]" />

        <ConnectionSelect v-model="connId" :connections="connections" clearable width="200px" />

        <!-- 库：空 = 连接默认库；描述 / 来源表反查与生成 SQL 的库名都跟随它 -->
        <Combobox v-model="databaseSelection" :options="databaseOptions" :placeholder="databasePlaceholder"
          search-placeholder="搜索数据库…" clearable width="160px" />

        <!-- 图标按钮：跳转到对应的单例标签页 -->
        <Button variant="secondary" size="icon" title="连接管理" @click="openTool('connections')">
          <Icon name="link" />
        </Button>

        <Button variant="secondary" size="icon" title="SQL 模板管理" @click="openTool('sql-template')">
          <Icon name="document" />
        </Button>
      </div>

      <div class="db-query__toolbar-right">
        <Button :loading="running" @click="handleRun()">
          <Icon name="play" />
          <span>执行查询</span>
        </Button>
      </div>
    </header>

    <!-- 主体：上为查询条件，下为查询结果 -->
    <div class="db-query__body">
      <section ref="formPanelRef" class="db-query__form">
        <div class="db-query__section-title">
          <span class="db-query__section-bar" aria-hidden="true" />
          <span>查询条件</span>
          <Tag v-if="currentTemplate && !currentTemplate.enabled" size="sm" tone="warning" effect="plain">
            已停用
          </Tag>
          <small v-if="templateId && variableConfigs.length">
            共 {{ variableConfigs.length }} 项
          </small>
        </div>

        <EmptyState v-if="!templateId" description="请选择 SQL 模板后填写变量" />

        <DynamicForm v-else ref="formRef" :key="templateId" :configs="variableConfigs" :conn-id="connId" inline
          @change="notifyChange" @submit="handleRun()" />
      </section>

      <!-- 结果区：执行日志固定页签在最前，查询结果在后 -->
      <section class="db-query__result">
        <TabGroup v-model="activeTab" :items="resultTabs" class="min-h-0 flex-1">
          <template #panel-log>
            <ExecutionLog ref="logRef" />
          </template>

          <template #panel-result>
            <div class="flex h-full min-h-0 flex-col">
              <ResultTable v-if="result" :result="result" :mappings="fieldMappings" :source="resultSource"
                @row-contextmenu="openRowMenu" />
              <EmptyState v-else description="尚未执行查询" />

              <!-- 分页常驻：页大小填 0 即不分页；语句不支持分页时由 supported 提示 -->
              <ResultPagination v-if="result" :page="page" :page-size="pageSize" :total="result.total"
                :page-count="result.pageCount" :supported="result.pageSize > 0 || pageSize === 0"
                :elapsed-ms="result.elapsedMs" :loading="running" @change="changePage" @size-change="changePageSize" />
            </div>
          </template>
        </TabGroup>
      </section>
    </div>

    <!-- 结果行右键菜单：复制为 INSERT / UPDATE / DELETE + 当前模板配置的导出模板 -->
    <ContextMenu v-model:visible="rowMenuVisible" :x="rowMenuX" :y="rowMenuY" :items="rowMenuItems"
      @select="handleRowMenuSelect" />
  </div>
</template>

<style scoped>
.db-query {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.db-query__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-color);
}

.db-query__toolbar-left,
.db-query__toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 条件区在上、结果区在下 */
.db-query__body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.db-query__form {
  flex: 0 0 auto;
  max-height: 45%;
  min-height: 0;
  overflow: auto;
  padding: 14px 16px 16px;
  border-bottom: 1px solid var(--border-color);
}

.db-query__section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: var(--app-font-size);
  font-weight: 600;
}

/* 标题前的强调条，弱化版的分区标记 */
.db-query__section-bar {
  width: 3px;
  height: 14px;
  border-radius: 2px;
  background: var(--brand-color);
}

.db-query__section-title small {
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
  font-weight: 400;
}

/* 条件数量靠右，与模板来源形成左右信息分布 */
.db-query__section-title small:last-child {
  margin-left: auto;
}

.db-query__result {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  /* 页签栏贴住上方分界线：上方不留多余空白 */
  padding: 2px 16px 0;
  overflow: hidden;
}

/* 页签（执行日志 / 查询结果）：页签栏固定，内容区占满剩余高度 */
.db-query__tabs {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}



/* 结果表格自己滚动；横向留白由分栏 padding 提供，不再另加 */
.db-query__result :deep(.result-table) {
  flex: 1;
  min-height: 0;
  padding: 0;
}

/* 结果表格自带滚动，分页控件固定在底部（见 ResultPagination） */
</style>
