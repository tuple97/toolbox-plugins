<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { EditorView } from '@codemirror/view'
import { askConfirm } from '@/utils/confirm'
import { notify } from '@/utils/notify'
import CodeEditor from '@/components/CodeEditor.vue'
import ResultTable from '@/components/ResultTable.vue'
import ResultPagination from '@/components/ResultPagination.vue'
import ExecutionLog from '@/components/ExecutionLog.vue'
import ScriptSummary from '@/components/ScriptSummary.vue'
import ConnectionSelect from '@/components/ConnectionSelect.vue'
import ContextMenu from '@/components/ContextMenu.vue'
import Button from '@/components/ui/Button.vue'
import Combobox from '@/components/ui/Combobox.vue'
import Icon from '@/components/ui/Icon.vue'
import TabGroup from '@/components/ui/TabGroup.vue'
import Toolbar from '@/components/ui/Toolbar.vue'
import { copyRowsSql, dialectOf, kindOfMenuItem, rowSqlMenuItems } from '@/utils/sql/rowSql'
import type { ResultSourceContext } from '@/utils/sql/rowSql'
import { formatSql, minifySql as minifySqlText } from '@/utils/sql/sqlFormat'
import { copyText } from '@/utils/clipboard'
import { fetchConnections } from '@/api/db'
import { EventsOn } from '@/api/runtime'
import { useConfigStore } from '@/stores/configStore'
import { matchesShortcut, shortcutOf } from '@/utils/shortcuts'
import { filterDatabaseInfos, parseShowSystemDatabases } from '@/utils/sql/sqlVisibility'
import type { DatabaseInfo } from '@/types'
import { DEFAULT_PAGE_SIZE } from '@/api/templates'
import {
  executeStatement,
  fetchDatabases as fetchDatabaseList,
} from '@/api/executor'
import {
  registerCompletionContext,
  unregisterCompletionContext,
} from '@/utils/sql/sqlCompletion'
import { useMetadataStore } from '@/stores/metadataStore'
import { splitSqlStatements, statementAtCursor, statementEndWithSemicolon } from '@/utils/sql/sqlStatementRanges'
import type { RenameTargetKind } from '@/utils/sql/rename/sqlRenameView'
import {
  setStatementRunStates,
  statementRunKey,
  type RunnableStatement,
  type StatementRunState,
  type StatementRunStates,
} from '@/utils/sql/sqlRunGutter'
import { useLogStore } from '@/stores/logStore'
import type {
  ContextMenuAction,
  DBConnection,
  ExecutorPayload,
  ExecutorResult,
  QueryResult,
  ScriptRunSummary,
  StatementRunRecord,
} from '@/types'

/** 命令执行器（多例标签页）：自由输入并执行 SQL。 */

const props = defineProps<{
  /** 所属 Tab 的 ID */
  tabId: number
  /** 从 Tab payload 恢复的状态 */
  initialPayload: Record<string, unknown>
}>()

const emit = defineEmits<{
  (e: 'change', tabId: number, payload: ExecutorPayload): void
  /** 首次初始化完成 */
  (e: 'ready'): void
}>()

const logStore = useLogStore()

/** 配置 store */
const configStore = useConfigStore()

const connections = ref<DBConnection[]>([])
const connId = ref<number | null>(null)
/** 数据库原始列表（选择与校验逻辑使用） */
const allDatabases = ref<DatabaseInfo[]>([])
/** 下拉框展示的库列表：系统库按设置项过滤 */
const databases = computed(() =>
  filterDatabaseInfos(allDatabases.value, dialectOf(dbType.value), showSystemDatabases.value))
const database = ref('')

/** 编辑器内容与执行状态 */
const sql = ref('')
const running = ref(false)

/** 根容器：拖动分栏时用它的高度做边界钳制 */
const rootRef = ref<HTMLDivElement | null>(null)

/** 编辑器高度（px），随 Tab 持久化 */
const editorHeight = ref(320)

/** 拖动分栏的高度约束 */
const MIN_EDITOR = 120
const MIN_RESULT = 140

/** 编辑器实例 */
let editorView: EditorView | null = null

/** 编辑器组件实例：右键菜单的语义动作调用它暴露的方法 */
const editorRef = ref<InstanceType<typeof CodeEditor> | null>(null)

/** 进行中的可取消调用 */
let runningCall: { cancel: () => void } | null = null

/** 当前连接名，日志展示用 */
const currentConnection = computed(
  () => connections.value.find(c => c.id === connId.value) ?? null,
)

/** 查询结果转成通用 QueryResult，复用结果表格组件 */
function toQueryResult(data: ExecutorResult): QueryResult {
  return {
    columns: data.columns,
    rows: data.rows,
    sql: data.sql,
    elapsedMs: data.elapsedMs,
    rowCount: data.rowCount,
    truncated: data.truncated,
    total: data.total,
    page: data.page,
    pageSize: data.pageSize,
    pageCount: data.pageCount,
  }
}

/** 实际生效的库：下拉框选中的库，否则回退连接默认库 */
const effectiveDatabase = computed(() => database.value || currentConnection.value?.database || '')

/** 下拉框占位文案：显示会落到哪个连接默认库 */
const databasePlaceholder = computed(() => {
  const fallback = currentConnection.value?.database
  return fallback ? `连接默认：${fallback}` : '选择数据库'
})

/** 每个连接上次用过的库，切回时恢复 */
const lastDatabaseByConn = new Map<number, string>()

/** 当前方言：语句切分与补全都要按它走 */
const dbType = computed(() => currentConnection.value?.dbType ?? 'mysql')

/** 设置项：下拉框是否展示系统库（默认展示） */
const showSystemDatabases = computed(() =>
  parseShowSystemDatabases(configStore.values.sql_show_system_databases))

/** 最近一次执行是否为「分析」 */
const analysisResult = ref(false)

/** 执行汇总 */
const scriptSummary = ref<ScriptRunSummary | null>(null)
/** 各语句的结果集（只含返回结果的语句），存已转换好的 QueryResult */
const scriptResults = ref<Array<{
  index: number
  sql: string
  execSql: string
  database: string
  /** 本次请求的页大小（0 = 不分页） */
  size: number
  result: QueryResult
}>>([])
/** 结果页签：log 为执行日志，summary 为摘要，result-N 为第 N 条语句结果 */
const activeScriptTab = ref('log')

/** 库下拉选项 */
const databaseOptions = computed(() =>
  databases.value.map(info => ({ label: info.name, value: info.name })))

/** 该库是否为系统库（下拉里显示标记） */
function isSystemDatabase(name: string): boolean {
  return databases.value.some(info => info.name === name && info.isSystem)
}

/** 结果区页签定义（数据驱动） */
const resultTabs = computed(() => [
  { value: 'log', label: '执行日志', lazy: true },
  ...(scriptSummary.value ? [{ value: 'summary', label: '摘要' }] : []),
  ...scriptResults.value.map(item => ({
    value: `result-${item.index}`,
    label: `结果${item.index}`,
    lazy: true,
  })),
])

/** 日志组件引用：切到日志页签时滚到底部 */
const logRef = ref<InstanceType<typeof ExecutionLog> | null>(null)

watch(activeScriptTab, async (tab) => {
  if (tab === 'log') {
    await nextTick()
    logRef.value?.scrollToBottom()
  }
})

/** 每页条数：0 表示不分页（下次执行的默认值） */
const pageSize = ref(DEFAULT_PAGE_SIZE)

/** 结果表格右键菜单的位置与作用的行 */
const rowMenuVisible = ref(false)
const rowMenuX = ref(0)
const rowMenuY = ref(0)
const rowMenuRows = ref<Record<string, unknown>[]>([])
/** 菜单来源的结果集 */
const rowMenuSource = ref<QueryResult | null>(null)

/** 菜单项：多选时标签带上行数 */
const rowMenuItems = computed(() => rowSqlMenuItems(Math.max(1, rowMenuRows.value.length)))

/** 打开结果行右键菜单 */
function openRowMenu(
  payload: { row: Record<string, unknown>, rows: Record<string, unknown>[], x: number, y: number },
  source: QueryResult | null,
) {
  rowMenuRows.value = payload.rows
  rowMenuX.value = payload.x
  rowMenuY.value = payload.y
  rowMenuSource.value = source
  rowMenuVisible.value = true
}

// ------------------------------------------------------------ 语句执行状态（左侧运行按钮的图标）

/** 各语句的执行状态，键为语句文本 */
const runStates = ref<StatementRunStates>({})

/** 把状态整体推给编辑器 */
function syncRunStates() {
  editorView?.dispatch({ effects: setStatementRunStates.of({ ...runStates.value }) })
}

/** 记录一条语句的状态；state 为 null 表示清除 */
function markRunState(sql: string, state: StatementRunState | null) {
  const key = statementRunKey(sql)
  const next = { ...runStates.value }
  if (state === null) {
    delete next[key]
  }
  else {
    next[key] = state
  }
  runStates.value = next
  syncRunStates()
}

/** 清空全部运行状态 */
function clearRunStates() {
  runStates.value = {}
  syncRunStates()
}

/** 点击语句左侧的运行按钮：直接执行该语句 */
function handleRunStatement(statement: RunnableStatement) {
  if (running.value) {
    return
  }
  void runSingle(statement.sql)
}

// ------------------------------------------------------------ 编辑器右键菜单

/** 编辑器右键菜单：执行 / 复制 / 美化 / 压缩及语义动作 */
/** 菜单里的对象称呼 */
const RENAME_LABELS: Record<RenameTargetKind, string> = {
  'table-alias': '表别名',
  'cte': 'CTE',
  'column-alias': '列别名',
}

const editorMenuItems = computed<ContextMenuAction[]>(() => {
  const items: ContextMenuAction[] = []

  if (editorMenuRename.value) {
    items.push({ key: 'rename-symbol', label: `重命名${RENAME_LABELS[editorMenuRename.value]}` })
  }
  if (editorMenuGoto.value) {
    items.push({ key: 'goto-definition', label: '跳转到定义', shortcut: 'F12' })
  }
  if (editorMenuCopy.value) {
    // 表名或别名都指向同一张物理表
    items.push({ key: 'copy-create-table', label: '复制建表语句' })
  }

  // divided 表示「本项之后画分隔线」
  items.push(
    { key: 'run', label: '执行', shortcut: 'Ctrl+Enter', disabled: running.value, divided: items.length > 0 },
    { key: 'analyze', label: '分析', shortcut: 'EXPLAIN', disabled: running.value },
    { key: 'copy', label: '复制', shortcut: 'Ctrl+C', divided: true },
    // 标签跟着当前范围的形态走
    { key: 'format', label: formatAction.value === 'minify' ? '压缩' : '美化', shortcut: 'Alt+Shift+F', disabled: running.value },
    /* 查找 / 替换：通用能力，放最后 */
    { key: 'search', label: '查找替换', shortcut: 'Ctrl+F' },
  )
  return items
})

const editorMenuVisible = ref(false)
const editorMenuX = ref(0)
const editorMenuY = ref(0)
/** 右键处的文档位置 */
const editorMenuPos = ref<number | null>(null)
/** 右键处可重命名的对象类型；null 表示不可重命名 */
const editorMenuRename = ref<RenameTargetKind | null>(null)
/** 右键处是否有可复制建表语句的物理表 */
const editorMenuCopy = ref(false)
/** 右键处是否有可跳转的定义 */
const editorMenuGoto = ref(false)

/** 编辑器内右键：接管默认菜单，在鼠标位置弹出 */
function handleEditorContextMenu(event: MouseEvent) {
  event.preventDefault()
  editorMenuX.value = event.clientX
  editorMenuY.value = event.clientY
  editorMenuVisible.value = true
  resolveEditorMenuTarget(event)
}

/** 解析右键位置能做什么（判定交给编辑器组件） */
function resolveEditorMenuTarget(event: MouseEvent) {
  const view = editorView
  const pos = view?.posAtCoords({ x: event.clientX, y: event.clientY }) ?? null
  editorMenuPos.value = pos
  if (!view || pos == null) {
    editorMenuRename.value = null
    editorMenuGoto.value = false
    editorMenuCopy.value = false
    return
  }
  editorMenuRename.value = editorRef.value?.renameTargetAt(pos) ?? null
  editorMenuGoto.value = editorRef.value?.canGoToDefinitionAt(pos) ?? false
  editorMenuCopy.value = editorRef.value?.canCopyCreateTableAt(pos) ?? false
}

/** 复制：有选中就复制选中，否则复制光标所在语句 */
async function copySqlAtCursor() {
  const range = resolveRange()
  if (!range) {
    notify.warning('光标处未匹配到 SQL 命令')
    return
  }
  try {
    await copyText(range.text)
    notify.success('已复制 SQL')
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 编辑器右键菜单选择 */
function handleEditorMenuSelect(item: ContextMenuAction) {
  switch (item.key) {
    case 'rename-symbol':
      if (editorMenuPos.value != null) {
        editorRef.value?.renameSymbolAt(editorMenuPos.value)
      }
      break
    case 'goto-definition':
      if (editorMenuPos.value != null) {
        editorRef.value?.goToDefinitionAt(editorMenuPos.value)
      }
      break
    case 'copy-create-table':
      if (editorMenuPos.value != null) {
        void editorRef.value?.copyCreateTableAt(editorMenuPos.value)
      }
      break
    case 'run':
      void runCurrent()
      break
    case 'analyze':
      analyzeSql()
      break
    case 'copy':
      void copySqlAtCursor()
      break
    case 'format':
      applyFormat()
      break
    case 'search':
      editorRef.value?.openSearch()
      break
  }
}

/** 结果来源：复制为 UPDATE/DELETE 与表头主键标记共用 */
function sourceOf(res: QueryResult): ResultSourceContext {
  return {
    connId: connId.value,
    database: effectiveDatabase.value,
    dbType: dbType.value,
    sql: res.sql,
  }
}

/** 处理「复制为…」：生成 INSERT / UPDATE / DELETE */
async function handleRowMenuSelect(item: ContextMenuAction) {
  const kind = kindOfMenuItem(item.key)
  const rows = rowMenuRows.value
  const data = rowMenuSource.value
  if (!kind || !rows.length || !data) {
    return
  }
  // 每行共用同一套上下文，只有 row 不同
  const base = { ...sourceOf(data), columns: data.columns.map(column => column.name) }
  await copyRowsSql(kind, rows.map(row => ({ ...base, row })))
}

// ------------------------------------------------------------ 初始化

/** 首次初始化中：库列表由 onMounted 负责加载 */
let initializing = true

onMounted(async () => {
  await loadConnections()

  // 恢复上次状态
  connId.value = (props.initialPayload.connId as number) ?? null
  sql.value = (props.initialPayload.sql as string) ?? ''
  editorHeight.value = Number(props.initialPayload.editorHeight) || editorHeight.value
  // 0 是合法值（不分页），不能用 || 兜底
  if (props.initialPayload.pageSize !== undefined) {
    const savedPageSize = Number(props.initialPayload.pageSize)
    if (Number.isFinite(savedPageSize) && savedPageSize >= 0) {
      pageSize.value = savedPageSize
    }
  }

  // 先钳制高度再上报就绪
  await nextTick()
  clampHeights()
  window.addEventListener('resize', clampHeights)

  try {
    await loadDatabases((props.initialPayload.database as string) ?? '')
  }
  finally {
    initializing = false
    // 失败也要上报，否则遮罩不消失
    emit('ready')
  }
})

/** 连接管理页改动连接后刷新下拉与库列表 */
const offConnectionsChanged = EventsOn('connections:changed', async () => {
  await loadConnections()
  // 默认库 / 可见库也可能变了，重拉库列表
  await loadDatabases()
})

onBeforeUnmount(() => {
  offConnectionsChanged()
  window.removeEventListener('resize', clampHeights)
  unregisterCompletionContext(editorView)
  editorView?.dom.removeEventListener('contextmenu', handleEditorContextMenu)
  editorView = null
})

/** 按容器高度重新钳制编辑器高度 */
function clampHeights() {
  const root = rootRef.value
  if (!root) {
    return
  }
  const total = root.clientHeight
  editorHeight.value = Math.min(
    editorHeight.value,
    Math.max(MIN_EDITOR, total - MIN_RESULT),
  )
}

async function loadConnections() {
  try {
    connections.value = await fetchConnections()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 加载库列表，`preferred` 为首选库 */
async function loadDatabases(preferred = ''): Promise<boolean> {
  if (!connId.value) {
    allDatabases.value = []
    database.value = ''
    return false
  }
  const requestedConn = connId.value
  try {
    const list = await fetchDatabaseList(requestedConn)
    if (connId.value !== requestedConn) {
      return false
    }
    allDatabases.value = list

    if (!list.length) {
      // 列表为空多为权限或服务端配置问题
      notify.warning('当前连接没有返回任何库：请检查账号权限，或点击旁边的刷新按钮重试')
      return true
    }

    if (database.value) {
      if (!list.some(info => info.name === database.value)) {
        // 选过的库不在列表里：保留并提示，不静默改库
        notify.warning(`所选库 ${database.value} 不在当前库列表中，仍按它执行；如需切换请重新选择`)
      }
      return true
    }

    const fallback = currentConnection.value?.database ?? ''
    const candidate = [preferred, fallback].find(name => name && list.some(info => info.name === name))
    database.value = candidate ?? fallback
    return true
  }
  catch (e) {
    if (connId.value !== requestedConn) {
      return false
    }
    // 只清空候选列表，保留 database
    allDatabases.value = []
    notify.error(`读取库列表失败：${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/** 切换连接：恢复该连接上次用过的库 */
watch(connId, async (id, old) => {
  if (id === old) {
    return
  }
  if (old != null && database.value) {
    lastDatabaseByConn.set(old, database.value)
  }
  database.value = id != null ? (lastDatabaseByConn.get(id) ?? '') : ''
  // 换连接后旧结果不再适用
  scriptSummary.value = null
  scriptResults.value = []
  // 清掉运行按钮状态
  clearRunStates()
  if (initializing) {
    // 首次挂载由 onMounted 统一加载
    return
  }
  await loadDatabases(database.value)
})

/** 记下用户在该连接上选过的库 */
watch(database, (value) => {
  if (connId.value != null && value) {
    lastDatabaseByConn.set(connId.value, value)
  }
})

// ------------------------------------------------------------ 编辑器

function handleEditorMount(view: EditorView) {
  editorView = view
  /* 挂载后立刻播报一次，让按钮状态从开始就准确 */
  selectionSignal.value += 1
  // 切标签回来时编辑器是重建的，补推已有执行状态
  syncRunStates()
  // 编辑器内右键：用自家菜单替换默认菜单
  view.dom.addEventListener('contextmenu', handleEditorContextMenu)
  registerCompletionContext(view, () => ({
    connId: connId.value ?? 0,
    // 用生效库，没手选时也能按连接默认库补全表名
    database: effectiveDatabase.value,
    // 方言影响补全插入的标识符引号
    dbType: dbType.value,
  }))
}

/** 编辑器快捷键（捕获阶段拦截） */
function handleKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented) {
    return
  }
  if (matchesShortcut(event, shortcutOf('format-sql', configStore.values.shortcut_config))) {
    event.preventDefault()
    event.stopPropagation()
    applyFormat()
    return
  }

  if (matchesShortcut(event, shortcutOf('run-sql', configStore.values.shortcut_config))) {
    event.preventDefault()
    event.stopPropagation()
    void runCurrent()
    return
  }
  if (matchesShortcut(event, shortcutOf('refresh-metadata', configStore.values.shortcut_config))) {
    event.preventDefault()
    event.stopPropagation()
    void refreshMeta()
    return
  }
  const cursor = editorView?.state.selection.main.head
  if (cursor != null && matchesShortcut(event, shortcutOf('rename-sql-symbol', configStore.values.shortcut_config))) {
    event.preventDefault()
    event.stopPropagation()
    editorRef.value?.renameSymbolAt(cursor)
    return
  }
  if (cursor != null && matchesShortcut(event, shortcutOf('goto-sql-definition', configStore.values.shortcut_config))) {
    event.preventDefault()
    event.stopPropagation()
    editorRef.value?.goToDefinitionAt(cursor)
    return
  }
  if (cursor != null && matchesShortcut(event, shortcutOf('copy-create-table', configStore.values.shortcut_config))) {
    event.preventDefault()
    event.stopPropagation()
    void editorRef.value?.copyCreateTableAt(cursor)
  }
}

/** 当前可操作的文本范围（已去掉首尾空白） */
interface EditorRange {
  /** 起始偏移（含） */
  from: number
  /** 结束偏移（不含） */
  to: number
  /** 范围内文本（已 trim） */
  text: string
}

/** 解析当前文本范围：有选中取选中，否则取光标所在语句 */
function resolveRange(): EditorRange | null {
  const view = editorView
  if (!view) {
    return null
  }

  // from === to 即没有选中内容
  const selection = view.state.selection.main
  if (!selection.empty) {
    const text = view.state.sliceDoc(selection.from, selection.to).trim()
    if (text) {
      // 选区两端可能带空白，向内收缩
      const raw = view.state.sliceDoc(selection.from, selection.to)
      const lead = raw.length - raw.trimStart().length
      const tail = raw.length - raw.trimEnd().length
      return { from: selection.from + lead, to: selection.to - tail, text }
    }
  }

  const doc = view.state.doc.toString()
  /* 光标所在语句；空行等位置不属于任何语句 */
  const statement = statementAtCursor(doc, selection.head, dbType.value)
  if (!statement) {
    return null
  }
  /* 结尾分号要算进范围，text 必须由同一段范围切出来 */
  const to = statementEndWithSemicolon(doc, statement)
  return { from: statement.from, to, text: doc.slice(statement.from, to) }
}

// ------------------------------------------------------------ 执行与取消

/** 执行：有选中执行选中，否则执行光标所在语句 */
async function runCurrent() {
  if (running.value) {
    return
  }
  if (!connId.value) {
    notify.warning('请先选择数据库连接')
    return
  }

  const range = resolveRange()
  if (!range) {
    notify.warning('光标处未匹配到 SQL 命令')
    return
  }

  // 选中内容可能含多条语句，逐条执行
  const statements = splitSqlStatements(range.text, dbType.value).map(item => item.sql)
  if (statements.length > 1) {
    await runScript(range.text)
    return
  }
  await runSingle(statements[0] ?? range.text)
}

// ------------------------------------------------------------ 格式化（美化 / 压缩二合一）

/** 用格式化结果替换当前范围 */
function replaceRange(range: EditorRange, text: string) {
  const view = editorView
  if (!view || !text || text === range.text) {
    return
  }
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
  })
  view.focus()
}

/** 光标 / 选区变化信号：驱动下面两个 computed */
const selectionSignal = ref(0)

function handleEditorSelection() {
  selectionSignal.value += 1
}

/** 当前可格式化的范围 */
const formatTarget = computed<EditorRange | null>(() => {
  void selectionSignal.value
  return resolveRange()
})

/** 格式化方向：多行则压缩，否则美化 */
const formatAction = computed<'beautify' | 'minify'>(
  () => (formatTarget.value?.text.includes('\n') ? 'minify' : 'beautify'),
)

/** 按钮提示：动作 + 快捷键 */
const formatButtonTitle = computed(() => {
  const action = formatAction.value === 'minify' ? '压缩为一行' : '展开为多行'
  return `${action}（Alt+Shift+F）`
})

/** 格式化：方向由 formatAction 决定 */
function applyFormat() {
  const range = formatTarget.value
  if (!range) {
    notify.warning('光标处未匹配到 SQL 命令')
    return
  }
  if (formatAction.value === 'minify') {
    replaceRange(range, minifySqlText(range.text))
    return
  }
  try {
    replaceRange(range, formatSql(range.text, dialectOf(currentConnection.value?.dbType ?? 'mysql')))
  }
  catch (e) {
    notify.error(`美化失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 查询关键字（其余按写操作处理） */
const QUERY_KEYWORDS = new Set([
  'select', 'show', 'describe', 'desc', 'explain', 'table', 'values',
])

/** 是否为写操作（后端会用同一口径兜底校验） */
function isWriteStatement(sql: string): boolean {
  const first = /^\s*[a-z_]+/i.exec(sql)?.[0].trim().toLowerCase() ?? ''
  return first !== '' && !QUERY_KEYWORDS.has(first)
}

/** 生产库写操作的执行前确认 */
async function confirmProductionWrite(sql: string): Promise<boolean> {
  const conn = currentConnection.value
  if (!conn?.isProduction || !isWriteStatement(sql)) {
    return true
  }
  /* 取消是正常分支，直接看返回值；语气用 danger 表示不可撤销 */
  return askConfirm({
    message: `连接「${conn.name}」标记为生产库，即将执行写操作且不可撤销。确认继续？`,
    title: '生产库写操作确认',
    confirmText: '确认执行',
    tone: 'danger',
  })
}

/** 执行单条语句，与脚本执行共用「摘要 + 结果N」页签展示 */
async function runSingle(sqlText: string, options: { stateKey?: string, analysis?: boolean } = {}) {
  const id = connId.value
  if (!id) {
    notify.warning('请先选择数据库连接')
    return
  }
  if (!(await confirmProductionWrite(sqlText))) {
    return
  }

  const stateKey = options.stateKey ?? sqlText
  running.value = true
  analysisResult.value = options.analysis ?? false
  scriptResults.value = []
  activeScriptTab.value = 'summary'
  markRunState(stateKey, 'running')
  logStore.logRequest(currentConnection.value?.name ?? String(id), sqlText, effectiveDatabase.value)

  // 单条也走摘要结构，记录里展示原始语句
  const record: StatementRunRecord = {
    index: 1,
    sql: stateKey,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: 0,
    elapsedMs: 0,
  }
  const sync = () => {
    scriptSummary.value = {
      records: [{ ...record }],
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      totalMs: record.finishedAt ? record.finishedAt - record.startedAt : 0,
      successCount: record.status === 'success' ? 1 : 0,
      failedCount: record.status === 'failed' || record.status === 'cancelled' ? 1 : 0,
    }
  }
  sync()

  const call = executeStatement({
    connId: id,
    database: effectiveDatabase.value,
    sql: sqlText,
    limit: 1000,
    page: pageSize.value > 0 ? 1 : 0,
    pageSize: pageSize.value,
    countTotal: pageSize.value > 0,
    // 已在上一步弹窗确认，后端仍会校验这个标记
    allowProductionWrite: currentConnection.value?.isProduction ?? false,
  })
  runningCall = call

  try {
    const data = await call
    record.status = 'success'
    record.kind = data.kind === 'query' ? 'query' : 'exec'
    record.elapsedMs = data.elapsedMs
    markRunState(stateKey, 'success')

    if (data.kind === 'query') {
      // 用后端回带的生效库（没有则退回前端所选）
      record.rowCount = data.rowCount
      scriptResults.value = [{
        index: 1,
        sql: stateKey,
        execSql: sqlText,
        database: data.database || effectiveDatabase.value,
        size: pageSize.value,
        result: toQueryResult(data),
      }]
      logStore.logSuccess(data.rowCount, data.elapsedMs, data.database || effectiveDatabase.value)
      if (data.sql !== sqlText) {
        // 后端按分页改写了 SQL：补一条实际执行的语句
        logStore.logPagedSQL(data.sql)
      }
      if (data.truncated) {
        notify.warning(`结果超过上限，仅展示前 ${data.rowCount} 行`)
      }
    }
    else {
      record.affectedRows = data.affectedRows
      logStore.append(`<< [成功] 影响 ${data.affectedRows} 行, 耗时 ${data.elapsedMs}ms`)
      notify.success(`执行成功，影响 ${data.affectedRows} 行`)
    }
  }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    record.elapsedMs = Date.now() - record.startedAt
    record.error = message
    if (isCancelled(message)) {
      record.status = 'cancelled'
      markRunState(stateKey, 'cancelled')
      logStore.append('<< [已取消] 查询已中止')
      notify.info('查询已取消')
    }
    else {
      record.status = 'failed'
      markRunState(stateKey, 'error')
      logStore.logError(message)
      notify.error(message)
    }
  }
  finally {
    record.finishedAt = Date.now()
    sync()
    // 有结果集就自动切到结果页签
    if (scriptResults.value.length && activeScriptTab.value === 'summary') {
      activeScriptTab.value = 'result-1'
    }
    running.value = false
    runningCall = null
  }
}

/** 包一层 EXPLAIN；本身已是 EXPLAIN 的原样返回 */
function toExplainSql(sql: string): string {
  return /^explain\b/i.test(sql.trim()) ? sql : `EXPLAIN ${sql}`
}

/** 执行整段脚本：按分号切分后逐条发送 */
async function runScript(script: string, mode: 'run' | 'analyze' = 'run') {
  const statements = splitSqlStatements(script, dbType.value).map(item => item.sql)
  if (!statements.length) {
    notify.warning('没有可执行的语句')
    return
  }
  const id = connId.value
  if (!id) {
    notify.warning('请先选择数据库连接')
    return
  }

  const analyze = mode === 'analyze'
  const sqlOf = (statement: string) => (analyze ? toExplainSql(statement) : statement)

  running.value = true
  analysisResult.value = analyze
  activeScriptTab.value = 'summary'

  /* 汇总在本地累积，每步结束后整体同步到响应式状态 */
  const summary: ScriptRunSummary = {
    records: [],
    startedAt: Date.now(),
    finishedAt: 0,
    totalMs: 0,
    successCount: 0,
    failedCount: 0,
  }
  const sync = () => {
    scriptSummary.value = {
      ...summary,
      records: summary.records.map(record => ({ ...record })),
    }
  }
  const results: Array<{
    index: number
    sql: string
    execSql: string
    database: string
    size: number
    result: QueryResult
  }> = []
  sync()

  logStore.append(
    `>> 开始${analyze ? '分析' : '执行'}脚本（库 ${effectiveDatabase.value || '未指定'}），共 ${statements.length} 条语句`,
  )

  /* 脚本含写操作时，开始前统一确认一次 */
  const writeStatement = statements.find(item => isWriteStatement(sqlOf(item)))
  if (writeStatement && !(await confirmProductionWrite(sqlOf(writeStatement)))) {
    logStore.append('-- 已取消：生产库写操作未确认')
    return
  }

  let cancelled = false
  for (let i = 0; i < statements.length; i++) {
    const index = i + 1
    const statement = statements[i]
    const record: StatementRunRecord = {
      index,
      sql: statement,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: 0,
      elapsedMs: 0,
    }
    summary.records.push(record)
    sync()
    markRunState(statement, 'running')

    const execSql = sqlOf(statement)
    const call = executeStatement({
      connId: id,
      database: effectiveDatabase.value,
      sql: execSql,
      limit: 1000,
      page: pageSize.value > 0 ? 1 : 0,
      pageSize: pageSize.value,
      countTotal: pageSize.value > 0,
      allowProductionWrite: currentConnection.value?.isProduction ?? false,
    })
    runningCall = call

    try {
      const data = await call
      record.status = 'success'
      record.kind = data.kind === 'query' ? 'query' : 'exec'
      record.elapsedMs = data.elapsedMs
      markRunState(statement, 'success')
      if (data.kind === 'query') {
        record.rowCount = data.rowCount
        if (data.sql !== execSql) {
          logStore.logPagedSQL(data.sql)
        }
        results.push({
          index,
          sql: statement,
          execSql,
          database: data.database || effectiveDatabase.value,
          size: pageSize.value,
          result: toQueryResult(data),
        })
      }
      else {
        record.affectedRows = data.affectedRows
      }
      summary.successCount++
      logStore.append(`<< [${index}/${statements.length}] 成功，耗时 ${data.elapsedMs}ms`)
    }
    catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      record.elapsedMs = Date.now() - record.startedAt
      record.error = message
      if (isCancelled(message)) {
        record.status = 'cancelled'
        cancelled = true
        markRunState(statement, 'cancelled')
        logStore.append(`<< [${index}/${statements.length}] 已取消，脚本停止执行`)
      }
      else {
        record.status = 'failed'
        markRunState(statement, 'error')
        logStore.append(`<< [${index}/${statements.length}] 失败: ${message}`)
      }
      summary.failedCount++
    }
    finally {
      record.finishedAt = Date.now()
      runningCall = null
      scriptResults.value = [...results]
      sync()
    }

    if (cancelled) {
      break
    }
  }

  summary.finishedAt = Date.now()
  summary.totalMs = summary.finishedAt - summary.startedAt
  sync()
  running.value = false

  /* 结束后自动切页签：有结果集就选中第一个结果页签 */
  const firstResult = results[0]
  if (firstResult && activeScriptTab.value === 'summary') {
    activeScriptTab.value = `result-${firstResult.index}`
  }

  logStore.append(
    `<< [脚本完成] 共 ${statements.length} 条，成功 ${summary.successCount}，失败 ${summary.failedCount}，总耗时 ${summary.totalMs}ms`,
  )
  if (summary.failedCount) {
    notify.warning(`执行完成：成功 ${summary.successCount} 条，失败 ${summary.failedCount} 条`)
  }
  else {
    notify.success(`执行完成：${statements.length} 条语句，总耗时 ${summary.totalMs} ms`)
  }
}

/** 取消正在执行的查询 */
function cancelRunning() {
  runningCall?.cancel()
}

// ------------------------------------------------------------ 结果分页

/** 按新的页码 / 页大小重新执行某条结果 */
async function reloadResultPage(index: number, page: number, size: number) {
  const id = connId.value
  const entry = scriptResults.value.find(item => item.index === index)
  if (!id || !entry) {
    return
  }
  const reuseTotal = size > 0 && entry.result.pageSize > 0 && entry.result.total > 0

  running.value = true
  const call = executeStatement({
    connId: id,
    database: entry.database || effectiveDatabase.value,
    sql: entry.execSql,
    limit: 1000,
    page: size > 0 ? Math.max(page, 1) : 0,
    pageSize: size,
    total: reuseTotal ? entry.result.total : 0,
    countTotal: !reuseTotal,
    // 翻页重跑的是已确认过的语句
    allowProductionWrite: true,
  })
  runningCall = call

  try {
    const data = await call
    if (data.kind !== 'query') {
      return
    }
    scriptResults.value = scriptResults.value.map(item => item.index === index
      ? { ...item, size, database: data.database || item.database, result: toQueryResult(data) }
      : item)
    logStore.logSuccess(data.rowCount, data.elapsedMs, data.database || effectiveDatabase.value)
    if (data.sql !== entry.execSql) {
      logStore.logPagedSQL(data.sql)
    }
  }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (!isCancelled(message)) {
      logStore.logError(message)
      notify.error(message)
    }
  }
  finally {
    running.value = false
    runningCall = null
  }
}

/** 结果页签翻页 */
function changeResultPage(index: number, target: number) {
  const entry = scriptResults.value.find(item => item.index === index)
  if (!entry || entry.result.pageSize <= 0) {
    return
  }
  void reloadResultPage(index, target, entry.result.pageSize)
}

/** 改某条结果的每页条数（0 表示不分页） */
function changeResultPageSize(index: number, size: number) {
  const entry = scriptResults.value.find(item => item.index === index)
  if (!entry) {
    return
  }
  pageSize.value = size
  void reloadResultPage(index, 1, size)
}

/** 分析：对当前范围的语句执行 EXPLAIN */
function analyzeSql() {
  if (running.value) {
    return
  }
  const range = resolveRange()
  if (!range) {
    notify.warning('光标处未匹配到 SQL 命令')
    return
  }

  const statements = splitSqlStatements(range.text, dbType.value)
  if (!statements.length) {
    notify.warning('没有可分析的语句')
    return
  }

  if (statements.length === 1) {
    void runSingle(toExplainSql(statements[0].sql), { stateKey: statements[0].sql, analysis: true })
    return
  }
  void runScript(range.text, 'analyze')
}

/** 识别「用户取消」类错误 */
function isCancelled(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('cancel') || message.includes('已取消')
}

/** 拖动编辑器下边界调整高度，松手后上报持久化 */
function startResize(event: MouseEvent) {
  event.preventDefault()
  const root = rootRef.value
  if (!root) {
    return
  }

  const startY = event.clientY
  const startEditor = editorHeight.value
  const total = root.clientHeight

  const onMove = (moveEvent: MouseEvent) => {
    const delta = moveEvent.clientY - startY
    const max = Math.max(MIN_EDITOR, total - MIN_RESULT)
    editorHeight.value = clamp(startEditor + delta, MIN_EDITOR, max)
  }

  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    notifyChange()
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  // 拖动期间保持拖拽光标并禁止选中
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
}

/** 数值钳制 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 刷新元数据：库列表与表字段缓存一并重拉 */
async function refreshMeta() {
  if (!connId.value) {
    return
  }
  const requested = connId.value
  const ok = await loadDatabases(lastDatabaseByConn.get(requested) ?? database.value)
  const meta = useMetadataStore()
  meta.invalidateConnection(requested)
  // 表列表按需重拉，字段缓存随连接一起失效
  void meta.loadTables(requested, effectiveDatabase.value, true)
  if (ok) {
    notify.success('元数据已刷新')
  }
}

// ------------------------------------------------------------ 状态同步

/** 上次上报的状态指纹，防止循环上报 */
let lastEmittedSignature = ''

function notifyChange() {
  const payload: ExecutorPayload = {
    connId: connId.value,
    database: database.value,
    sql: sql.value,
    editorHeight: Math.round(editorHeight.value),
    pageSize: pageSize.value,
  }
  const signature = JSON.stringify(payload)
  if (signature === lastEmittedSignature) {
    return
  }
  lastEmittedSignature = signature
  emit('change', props.tabId, payload)
}

watch([connId, database, sql, pageSize], notifyChange)
</script>

<template>
  <div ref="rootRef" class="executor">
    <!-- 顶部操作栏：连接 / 库 / 元数据 -->
    <Toolbar class="executor__toolbar">
      <ConnectionSelect v-model="connId" :connections="connections" width="210px" />

      <Combobox
        v-model="database"
        :options="databaseOptions"
        :placeholder="databasePlaceholder"
        search-placeholder="搜索数据库…"
        class="w-[190px]"
      >
        <!-- 系统库显示「系统」标记 -->
        <template #option="{ option }">
          <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
          <small v-if="isSystemDatabase(option.value)" class="executor__db-system">系统</small>
        </template>
      </Combobox>

      <Button
        variant="secondary"
        size="icon"
        title="刷新元数据缓存"
        @click="refreshMeta"
      >
        <Icon name="refresh" />
      </Button>
    </Toolbar>

    <!-- 编辑器操作行：运行 / 终止、分析、格式化 -->
    <div class="executor__actions">
      <!-- 运行与终止共用一个按钮 -->
      <Button
        v-if="!running"
        title="执行（Ctrl+Enter）"
        @click="runCurrent"
      >
        <Icon name="play" />
      </Button>
      <Button
        v-else
        variant="danger"
        title="终止正在执行的查询"
        @click="cancelRunning"
      >
        <Icon name="pause" />
      </Button>

      <!-- 分析：用 EXPLAIN 查看执行计划 -->
      <Button
        variant="secondary"
        size="icon"
        :disabled="running"
        title="EXPLAIN 分析"
        @click="analyzeSql"
      >
        <Icon name="chart" />
      </Button>

      <!-- 美化 / 压缩合成一个按钮 -->
      <Button
        variant="secondary"
        size="icon"
        :disabled="running"
        :title="formatButtonTitle"
        @click="applyFormat"
      >
        <Icon :name="formatAction === 'beautify' ? 'wand' : 'chevrons-left'" />
      </Button>
    </div>

    <!-- 编辑器：高度可拖 -->
    <div
      class="executor__editor"
      :style="{ height: `${editorHeight}px` }"
      @keydown.capture="handleKeydown"
    >
      <CodeEditor
        ref="editorRef"
        v-model="sql"
        language="sql"
        completion-mode="sql"
        :db-type="currentConnection?.dbType ?? ''"
        height="100%"
        show-statement-frames
        show-run-buttons
        @mount="handleEditorMount"
        @selection="handleEditorSelection"
        @run-statement="handleRunStatement"
      />
    </div>

    <!-- 编辑器 / 结果区分界：拖动调整编辑器高度 -->
    <div
      class="executor__splitter"
      title="拖动调整编辑器高度"
      @mousedown="startResize($event)"
    />

    <!-- 结果区：执行日志页签固定在最前 -->
    <section class="executor__result">
      <TabGroup v-model="activeScriptTab" :items="resultTabs" class="min-h-0 flex-1">
        <template #panel-log>
          <ExecutionLog ref="logRef" />
        </template>

        <template v-if="scriptSummary" #panel-summary>
          <ScriptSummary :summary="scriptSummary" />
        </template>

        <!-- 结果页签是动态的，插槽名随语句序号变化 -->
        <template
          v-for="item in scriptResults"
          :key="item.index"
          #[`panel-result-${item.index}`]
        >
          <div class="flex h-full min-h-0 flex-col">
            <ResultTable
              :result="item.result"
              :mappings="[]"
              :analysis="analysisResult"
              :source="sourceOf(item.result)"
              @row-contextmenu="openRowMenu($event, item.result)"
            />

            <!-- 分页常驻：页大小填 0 即不分页 -->
            <ResultPagination
              :page="item.result.page"
              :page-size="item.size"
              :total="item.result.total"
              :page-count="item.result.pageCount"
              :supported="item.result.pageSize > 0 || item.size === 0"
              :elapsed-ms="item.result.elapsedMs"
              :loading="running"
              @change="changeResultPage(item.index, $event)"
              @size-change="changeResultPageSize(item.index, $event)"
            />
          </div>
        </template>
      </TabGroup>
    </section>

    <!-- 结果行右键菜单：复制为 INSERT / UPDATE / DELETE -->
    <ContextMenu
      v-model:visible="rowMenuVisible"
      :x="rowMenuX"
      :y="rowMenuY"
      :items="rowMenuItems"
      @select="handleRowMenuSelect"
    />

    <!-- SQL 编辑器右键菜单：执行 / 复制 / 美化 / 压缩 -->
    <ContextMenu
      v-model:visible="editorMenuVisible"
      :x="editorMenuX"
      :y="editorMenuY"
      :items="editorMenuItems"
      @select="handleEditorMenuSelect"
    />
  </div>
</template>

<style scoped>
.executor {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* 工具条的下边框交给下面的操作行，这里只调间距 */
.executor__toolbar {
  padding: 10px 16px 8px;
  border-bottom: 0;
}

/* 库下拉的「系统」标记 */
.executor__db-system {
  float: right;
  margin-left: 12px;
  color: var(--color-muted);
  font-size: var(--app-font-size-xs);
}

/* 编辑器操作行：只放图标按钮 */
.executor__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 0 0 auto;
  padding: 0 16px 8px;
  border-bottom: 1px solid var(--color-border);
}

/* 编辑器高度由分栏拖动决定，结果区占剩余空间 */
.executor__editor {
  flex: 0 0 auto;
  min-height: 120px;
  overflow: hidden;
}

/* 分栏拖动条：6px 命中区，悬浮高亮 */
.executor__splitter {
  flex: 0 0 auto;
  height: 6px;
  cursor: row-resize;
  background: transparent;
  transition: background-color 0.15s ease;
}

.executor__splitter:hover {
  background: var(--color-brand);
}

.executor__result {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  /* 页签栏贴住分界线 */
  padding: 2px 16px 0;
  /* 结果区上方分界线 */
  border-top: 1px solid var(--color-border);
}

/* 结果表格自己滚动，横向留白与摘要表格对齐 */
.executor__result :deep(.result-table) {
  flex: 1;
  min-height: 0;
  padding: 0;
}

/* 结果页签版面由 TabGroup 自带 */</style>
