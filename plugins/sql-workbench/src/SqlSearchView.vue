<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import Combobox from '@/components/ui/Combobox.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Icon from '@/components/ui/Icon.vue'
import TabGroup from '@/components/ui/TabGroup.vue'
import Tag from '@/components/ui/Tag.vue'
import Toolbar from '@/components/ui/Toolbar.vue'
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
  ColumnMeta,
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
  /** 所属 Tab 的 ID */
  tabId: number
  /** 从 Tab payload 恢复的状态 */
  initialPayload: Record<string, unknown>
  /** 组合视图从配置模式切过来时交接的模板 */
  seedTemplateId?: number | null
  /** 交接的数据源 */
  seedConnId?: number | null
  /** 交接的库 */
  seedDatabase?: string
}>()

const emit = defineEmits<{
  (e: 'change', tabId: number, payload: DbQueryPayload): void
  /** 首次初始化完成 */
  (e: 'ready'): void
  /** 查询返回的结果列，供配置模式的字段映射自动补齐 */
  (e: 'result-columns', columns: ColumnMeta[]): void
}>()

const logStore = useLogStore()
const tabStore = useTabStore()
const configStore = useConfigStore()

/** 跳转到单例功能标签页 */
function openTool(type: ToolType) {
  tabStore.openTool(type)
}

/** 模板列表与连接列表 */
const templates = ref<TemplateListItem[]>([])
const connections = ref<DBConnection[]>([])

/** 当前选中的模板与连接 */
const templateId = ref<number | null>(null)
const connId = ref<number | null>(null)

/** 当前模板解析出的变量配置与字段映射 */
const variableConfigs = ref<VariableConfig[]>([])
const fieldMappings = ref<FieldMapping[]>([])
/** 当前模板配置的导出模板（结果行右键「复制为…」的自定义选项） */
const exportTemplates = ref<ExportTemplate[]>([])

/** 变量值 */
const variableValues = ref<Record<string, unknown>>({})

/** 执行状态与结果 */
const result = ref<QueryResult | null>(null)
const running = ref(false)

/** 当前页码，从 1 开始 */
const page = ref(1)
/** 每页条数：当前 Tab 私有，不写入模板；0 表示不分页 */
const pageSize = ref(DEFAULT_PAGE_SIZE)
/** 上一次执行得到的总数，翻页时带回 */
const lastTotal = ref(0)

// 连接管理与 SQL 模板已改为独立标签页

const formRef = ref<{ getValues: () => Record<string, unknown> } | null>(null)

// -------------------------------------------------- 结果区页签 / 结果行右键菜单

/** 条件区容器：结果区高度计算用 */
const formPanelRef = ref<HTMLElement | null>(null)

/** 结果区页签：log 为执行日志，result 为查询结果 */
const activeTab = ref('log')

/** 结果区页签定义（日志懒挂载） */
const resultTabs = [
  { value: 'log', label: '执行日志', lazy: true },
  { value: 'result', label: '查询结果' },
]

/** 模板下拉选中值：Combobox 用 string 做 v-model，这里做转换 */
const templateSelection = computed({
  get: () => (templateId.value === null ? '' : String(templateId.value)),
  set: (value: string) => {
    templateId.value = value === '' ? null : Number(value)
  },
})

/** 模板下拉选项：停用的模板仍列出并标注 */
const templateOptions = computed(() =>
  templates.value.map(tpl => ({
    label: tpl.enabled ? tpl.name : `${tpl.name}（已停用）`,
    value: String(tpl.id),
  })))

/** 日志组件引用：切到日志页签时滚到底部 */
const logRef = ref<InstanceType<typeof ExecutionLog> | null>(null)

watch(activeTab, async (tab) => {
  if (tab === 'log') {
    await nextTick()
    logRef.value?.scrollToBottom()
  }
})

/** 结果来源：复制为 UPDATE/DELETE 与表头主键标记共用 */
function sourceOf(res: QueryResult): ResultSourceContext {
  return {
    connId: connId.value,
    // 库的口径与执行一致：依次取本次请求、结果回带、连接默认库
    database: database.value || res.database || currentConnection.value?.database || '',
    dbType: currentConnection.value?.dbType ?? 'mysql',
    sql: res.sql,
  }
}

/** 给结果区用的来源（无结果为 null） */
const resultSource = computed(() => (result.value ? sourceOf(result.value) : null))

/** 结果表格右键菜单的位置与作用的行 */
const rowMenuVisible = ref(false)
const rowMenuX = ref(0)
const rowMenuY = ref(0)
const rowMenuRows = ref<Record<string, unknown>[]>([])

/** 菜单项：内置三项 + 模板配置的导出模板 */
const rowMenuItems = computed(() =>
  rowSqlMenuItems(Math.max(1, rowMenuRows.value.length), exportTemplates.value))

/** 打开结果行右键菜单 */
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

/** 处理「复制为…」：内置项生成 SQL，导出模板按模板渲染 */
async function handleRowMenuSelect(item: ContextMenuAction) {
  const rows = rowMenuRows.value
  const data = result.value
  if (!rows.length || !data) {
    return
  }

  // 自定义导出模板：由后端按模板渲染
  const exportTemplate = exportTemplateOfMenuItem(item.key, exportTemplates.value)
  if (exportTemplate) {
    await copyRowsByExportTemplate(exportTemplate, rows)
    return
  }

  const kind = kindOfMenuItem(item.key)
  if (!kind) {
    return
  }
  // 每行共用同一套上下文，只有 row 不同
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

/** 库选择：空 = 连接默认库 */
/** 库列表（含系统库），是否展示由设置决定 */
const databases = ref<DatabaseInfo[]>([])
const database = ref('')
const lastDatabaseByConn = new Map<number, string>()

/** 「展示系统库」设置 */
const showSystemDatabases = computed(() =>
  parseShowSystemDatabases(configStore.values.sql_show_system_databases))

/** 过滤后的库列表：关闭设置后不列出系统库 */
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

/** 占位文案：显示不选时会落到哪个连接默认库 */
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

/** 载入模板配置（变量表单由模板驱动） */
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

    /* 模板配了库就以它为准，否则保持当前选择；并记入 lastDatabaseByConn */
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

/** 执行查询；reuseTotal 为真表示翻页并沿用上次总数 */
async function handleRun(targetPage = 1, reuseTotal = false) {
  if (!templateId.value) {
    notify.warning('请先选择 SQL 模板')
    return
  }
  /* 停用的模板不允许执行，后端也会拦 */
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
  // 页大小为 0 表示不分页：页码传 0
  const requestPage = pageSize.value > 0 ? Math.max(targetPage, 1) : 0

  try {
    // 只传模板 ID 与变量值，SQL 由后端从模板读取
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
    // 结果列交给组合视图：配置模式的字段映射据此补齐
    emit('result-columns', data.columns ?? [])
    // 查询成功自动切到结果页签
    activeTab.value = 'result'
    // 以服务端返回的页码为准
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
    /* 模板语法错误只在日志留痕，不弹窗 */
    if (!message.includes('模板语法错误')) {
      notify.error(message)
    }
  }
  finally {
    running.value = false
  }
}

/** 翻页：沿用上次统计到的总数 */
function changePage(target: number) {
  if (pageSize.value <= 0) {
    return
  }
  void handleRun(target, true)
}

/** 修改每页条数（0 = 不分页）：回第一页重新查询 */
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

/** 上次上报的状态指纹，用于去重 */
let lastEmittedSignature = ''

/** 上报当前状态（变量值直接读表单实例） */
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

/** 模板/连接/每页条数变化时上报；变量值由表单 change 触发 */
watch(
  () => JSON.stringify([templateId.value, connId.value, pageSize.value]),
  () => notifyChange(),
)

/** 切换模板时重载配置并回到第一页 */
watch(templateId, id => {
  void loadTemplateConfig(id)
  result.value = null
  page.value = 1
  lastTotal.value = 0
})

/** 切换连接后清空结果、重置分页，库选择按连接恢复 */
watch(connId, async (id) => {
  result.value = null
  page.value = 1
  lastTotal.value = 0
  database.value = id ? (lastDatabaseByConn.get(id) ?? '') : ''
  await loadDatabases()
})

/** 其他标签页的数据变更通知：刷新下拉与当前模板配置 */
const offTemplatesChanged = EventsOn('templates:changed', async () => {
  await loadTemplates()
  if (templateId.value) {
    await loadTemplateConfig(templateId.value)
  }
})

const offConnectionsChanged = EventsOn('connections:changed', async () => {
  await loadConnections()
  // 连接编辑可能改了默认库 / 可见库，刷新列表
  await loadDatabases()
})

onBeforeUnmount(() => {
  offTemplatesChanged()
  offConnectionsChanged()
})

// ------------------------------------------------------------ 生命周期

onMounted(async () => {
  try {
    // 组合视图切换过来时优先用交接的选择，其次才是本标签上次的状态
    templateId.value = props.seedTemplateId ?? (props.initialPayload.templateId as number) ?? null
    connId.value = props.seedConnId ?? (props.initialPayload.connId as number) ?? null
    if (props.seedDatabase) {
      database.value = props.seedDatabase
    }
    variableValues.value =
      (props.initialPayload.variableValues as Record<string, unknown>) ?? {}
    // 每页条数是本标签私有状态（0 是合法值，不能用 || 兜底）
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
    // 失败也要上报，否则遮罩不消失
    emit('ready')
  }
})

/** 切到配置模式前，把当前的条件交接出去 */
defineExpose({
  currentSelection: () => ({
    templateId: templateId.value,
    connId: connId.value,
    database: database.value,
  }),
})
</script>

<template>
  <div ref="rootRef" class="db-query">
    <!-- 顶部操作栏：模板 / 连接 / 库 -->
    <Toolbar>
      <Combobox v-model="templateSelection" :options="templateOptions" placeholder="选择 SQL 模板"
        search-placeholder="搜索模板…" clearable class="w-[240px]" />

      <ConnectionSelect v-model="connId" :connections="connections" clearable width="200px" />

      <!-- 库：空 = 连接默认库 -->
      <Combobox v-model="databaseSelection" :options="databaseOptions" :placeholder="databasePlaceholder"
        search-placeholder="搜索数据库…" clearable width="160px" />

      <!-- 图标按钮：跳转到对应的单例标签页 -->
      <Button variant="secondary" size="icon" title="连接管理" @click="openTool('connections')">
        <Icon name="link" />
      </Button>

      <template #actions>
        <Button :loading="running" @click="handleRun()">
          <Icon name="play" />
          <span>执行查询</span>
        </Button>

        <!-- 组合视图从这里插切换按钮：放在执行查询右侧 -->
        <slot name="toolbar-end" />
      </template>
    </Toolbar>

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

      <!-- 结果区：执行日志页签固定在最前 -->
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

              <!-- 分页常驻：页大小填 0 即不分页 -->
              <ResultPagination v-if="result" :page="page" :page-size="pageSize" :total="result.total"
                :page-count="result.pageCount" :supported="result.pageSize > 0 || pageSize === 0"
                :elapsed-ms="result.elapsedMs" :loading="running" @change="changePage" @size-change="changePageSize" />
            </div>
          </template>
        </TabGroup>
      </section>
    </div>

    <!-- 结果行右键菜单：复制为 INSERT / UPDATE / DELETE + 导出模板 -->
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
  border-bottom: 1px solid var(--color-border);
}

.db-query__section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: var(--app-font-size);
  font-weight: 600;
}

/* 标题前的强调条 */
.db-query__section-bar {
  width: 3px;
  height: 14px;
  border-radius: 2px;
  background: var(--color-brand);
}

.db-query__section-title small {
  color: var(--color-muted);
  font-size: var(--app-font-size-xs);
  font-weight: 400;
}

/* 条件数量靠右 */
.db-query__section-title small:last-child {
  margin-left: auto;
}

.db-query__result {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  /* 页签栏贴住上方分界线 */
  padding: 2px 16px 0;
  overflow: hidden;
}

/* 页签：页签栏固定，内容区占满剩余高度 */
.db-query__tabs {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}



/* 结果表格自己滚动，横向留白由分栏 padding 提供 */
.db-query__result :deep(.result-table) {
  flex: 1;
  min-height: 0;
  padding: 0;
}

/* 结果表格自带滚动，分页控件固定在底部 */
</style>
