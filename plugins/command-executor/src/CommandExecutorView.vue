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

/**
 * 命令执行器（多例标签页）：自由输入并执行 SQL。
 *
 * - 执行范围：选中 SQL 优先，否则执行光标所在语句；「执行全部」跑整段脚本；
 * - 取消：执行期间可取消，数据库端语句同步终止（Wails ctx 取消）；
 * - 智能补全：表 / 字段（含别名 `u.`）/ 关键字 / 函数，元数据后台拉取不阻塞输入。
 */

const props = defineProps<{
  /** 所属 Tab 的 ID，回传状态时一并返回 */
  tabId: number
  /** 从 Tab payload 恢复的状态 */
  initialPayload: Record<string, unknown>
}>()

const emit = defineEmits<{
  (e: 'change', tabId: number, payload: ExecutorPayload): void
  /** 首次初始化完成（父级据此关闭 loading 遮罩） */
  (e: 'ready'): void
}>()

const logStore = useLogStore()

/** 设置项（SQL 提示触发 / 系统库可见性等）由配置 store 统一持有 */
const configStore = useConfigStore()

const connections = ref<DBConnection[]>([])
const connId = ref<number | null>(null)
/**
 * 数据库**原始列表**：选择与校验逻辑用它（「选过的库还在不在列表里」不能被展示设置影响）。
 */
const allDatabases = ref<DatabaseInfo[]>([])
/**
 * 下拉框展示的库列表：系统库按设置项过滤。
 *
 * 做成 computed 而不是在请求时过滤：切换设置项立即生效，且**不需要重新拉元数据**
 * （与「可见性只是展示策略」一致）。判定用后端给的 `isSystem` 标记。
 */
const databases = computed(() =>
  filterDatabaseInfos(allDatabases.value, dialectOf(dbType.value), showSystemDatabases.value))
const database = ref('')

/** 编辑器内容与执行状态 */
const sql = ref('')
const running = ref(false)

/** 根容器：拖动分栏时用它的高度做边界钳制 */
const rootRef = ref<HTMLDivElement | null>(null)

/** 编辑器高度（px）：拖动分栏调整，随 Tab 持久化 */
const editorHeight = ref(320)

/** 拖动分栏的高度约束 */
const MIN_EDITOR = 120
const MIN_RESULT = 140

/** 编辑器实例（由 CodeEditor 的 mount 事件给出，即 CM6 的 EditorView） */
let editorView: EditorView | null = null

/** 编辑器组件实例：右键菜单里的语义动作（重命名 / 复制建表）走它暴露的方法 */
const editorRef = ref<InstanceType<typeof CodeEditor> | null>(null)

/** 进行中的可取消调用，取消按钮用 */
let runningCall: { cancel: () => void } | null = null

/** 当前连接名，日志展示用 */
const currentConnection = computed(
  () => connections.value.find(c => c.id === connId.value) ?? null,
)

/** 查询结果转成通用 QueryResult，复用结果表格组件（分页信息原样带上） */
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

/**
 * 实际生效的库：下拉框选中的库，没选则用连接配置里的默认库。
 *
 * 执行时按它发送（不带库名的语句就以它为默认库），
 * 执行记录里也按它显示，方便确认「这条 SQL 打在哪个库上」。
 */
const effectiveDatabase = computed(() => database.value || currentConnection.value?.database || '')

/** 下拉框为空时的占位文案：直接写清会落到哪个连接默认库 */
const databasePlaceholder = computed(() => {
  const fallback = currentConnection.value?.database
  return fallback ? `连接默认：${fallback}` : '选择数据库'
})

/**
 * 每个连接上次用过的库。
 *
 * 切换连接再切回来时按它恢复，而不是回到连接默认库——
 * 「我明明选过库」最常出现在切连接、切标签之后。
 */
const lastDatabaseByConn = new Map<number, string>()

/** 当前方言：语句切分与补全都要按它走（MySQL 的 DELIMITER/反引号、PG 的 dollar 引用等） */
const dbType = computed(() => currentConnection.value?.dbType ?? 'mysql')

/**
 * 设置项：下拉框里是否展示系统库（默认展示）。
 *
 * 与补全候选用的是同一个策略模块（utils/sql/sqlVisibility），
 * 于是不会出现「下拉里有、补全里没有」这种自相矛盾的状态。
 */
const showSystemDatabases = computed(() =>
  parseShowSystemDatabases(configStore.values.sql_show_system_databases))

/** 最近一次执行是否为「分析」（EXPLAIN）：结果表格据此给出悬停优化建议 */
const analysisResult = ref(false)

/** 执行汇总（单条与脚本共用）；为 null 时结果区显示空态 */
const scriptSummary = ref<ScriptRunSummary | null>(null)
/**
 * 执行中各语句的结果集（只有返回结果集的语句入列）。
 * 这里存的是已转换好的 QueryResult：模板里不能再调转换函数
 * （每次渲染都会产生新对象，导致子组件 props 引用变化而反复重渲染）。
 * execSql 是实际发送的 SQL（分析时含 EXPLAIN 包装），翻页时按它重跑。
 */
const scriptResults = ref<Array<{
  index: number
  sql: string
  execSql: string
  database: string
  /** 本次请求的页大小（0 = 不分页）：语句不支持分页时用它区分「用户选的分页」 */
  size: number
  result: QueryResult
}>>([])
/** 结果页签：log = 执行日志（固定），summary = 摘要，result-N = 第 N 条语句的结果 */
const activeScriptTab = ref('log')

/** 库下拉选项（Combobox 只吃 label / value；「系统」标记走 #option 插槽） */
const databaseOptions = computed(() =>
  databases.value.map(info => ({ label: info.name, value: info.name })))

/** 该库是不是系统库：下拉里给它一个「系统」标记，解释「为什么关掉设置后它就不见了」 */
function isSystemDatabase(name: string): boolean {
  return databases.value.some(info => info.name === name && info.isSystem)
}

/**
 * 结果区页签定义。
 *
 * 页签是**数据驱动**的（摘要按需出现、结果页签随语句数变化），
 * 面板内容用与页签名同名的具名插槽（`panel-<value>`）渲染。
 */
const resultTabs = computed(() => [
  { value: 'log', label: '执行日志', lazy: true },
  ...(scriptSummary.value ? [{ value: 'summary', label: '摘要' }] : []),
  ...scriptResults.value.map(item => ({
    value: `result-${item.index}`,
    label: `结果${item.index}`,
    lazy: true,
  })),
])

/** 日志页签组件引用：切到该页签时把日志滚到底部 */
const logRef = ref<InstanceType<typeof ExecutionLog> | null>(null)

watch(activeScriptTab, async (tab) => {
  if (tab === 'log') {
    await nextTick()
    logRef.value?.scrollToBottom()
  }
})

/**
 * 每页条数：0 表示不分页。
 * 结果页签各自记录自己的分页状态（后端随结果回带），
 * 这里存的是「下次执行」用的默认值，改动后对当前页签立即生效。
 */
const pageSize = ref(DEFAULT_PAGE_SIZE)

/** 结果表格右键菜单：位置与要作用的行（多选时是多行） */
const rowMenuVisible = ref(false)
const rowMenuX = ref(0)
const rowMenuY = ref(0)
const rowMenuRows = ref<Record<string, unknown>[]>([])
/**
 * 菜单来自哪个结果集。
 *
 * 单条执行与脚本执行的结果分属两处（`result` / `scriptResults`），
 * 处理菜单时只看 `result` 会在脚本模式下拿不到数据——
 * 打开菜单的瞬间把来源一并记下，处理时用它，与当前展示的页签天然一致。
 */
const rowMenuSource = ref<QueryResult | null>(null)

/** 菜单项：多选时标签带上行数（「批量复制为…（3 行）」） */
const rowMenuItems = computed(() => rowSqlMenuItems(Math.max(1, rowMenuRows.value.length)))

/** 打开结果行右键菜单（内容为「复制为 INSERT / UPDATE / DELETE」） */
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

/**
 * 各语句的执行状态，键为语句文本（见 statementRunKey）。
 * 渲染到编辑器左侧的运行按钮上：▶ 未执行 / ⟳ 执行中 / ✓ 成功 / ✕ 失败 / ⊘ 已取消。
 */
const runStates = ref<StatementRunStates>({})

/** 把状态整体推给编辑器（gutter 从编辑器 state 里读，自己重绘） */
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

/** 清空全部状态（换连接后旧结果不再适用） */
function clearRunStates() {
  runStates.value = {}
  syncRunStates()
}

/** 点击某条语句左侧的运行按钮：直接执行它，不打扰光标与选区 */
function handleRunStatement(statement: RunnableStatement) {
  if (running.value) {
    return
  }
  void runSingle(statement.sql)
}

// ------------------------------------------------------------ 编辑器右键菜单

/**
 * 编辑器右键菜单：执行 / 复制 / 美化 / 压缩，外加**语义动作**。
 *
 * 与工具条共用同一套动作与范围判定（有选中就用选中，否则用光标所在语句），
 * 所以两处行为一致；执行期间与工具条一样整体禁用。
 *
 * 语义动作（重命名表别名 / 复制建表语句）只在「鼠标确实落在表名或表别名上」
 * 时出现 —— 由语义解析给出结论，解析不出来就不显示，绝不靠正则猜。
 */
/** 菜单里的对象称呼（判定与动作都由编辑器给出，这里只管措辞） */
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
    // 表名或别名都指向同一张物理表，都能复制它的建表语句
    items.push({ key: 'copy-create-table', label: '复制建表语句' })
  }

  // divided 表示「本项之后画一条分隔线」（见 ContextMenu 模板）：
  // 第一组是「对鼠标下的符号做什么」，后面才是「对这条 SQL 做什么」
  items.push(
    { key: 'run', label: '执行', shortcut: 'Ctrl+Enter', disabled: running.value, divided: items.length > 0 },
    { key: 'analyze', label: '分析', shortcut: 'EXPLAIN', disabled: running.value },
    { key: 'copy', label: '复制', shortcut: 'Ctrl+C', divided: true },
    // 与工具条同一个按钮：标签跟着当前范围的形态走（多行 → 压缩，单行 → 美化）
    { key: 'format', label: formatAction.value === 'minify' ? '压缩' : '美化', shortcut: 'Alt+Shift+F', disabled: running.value },
    /*
     * 查找 / 替换：与当前 SQL 内容无关的通用能力，放最后。
     * 快捷键（Ctrl+F / Ctrl+D 选中同名单词）在编辑器内部始终可用，
     * 这一项只是让能力可发现 —— 菜单让右手鼠标找到它，快捷键是日常路径。
     */
    { key: 'search', label: '查找替换', shortcut: 'Ctrl+F' },
  )
  return items
})

const editorMenuVisible = ref(false)
const editorMenuX = ref(0)
const editorMenuY = ref(0)
/** 右键处的文档位置（语义动作用它） */
const editorMenuPos = ref<number | null>(null)
/** 右键处可重命名的对象类型；null 表示该位置没有重命名动作 */
const editorMenuRename = ref<RenameTargetKind | null>(null)
/** 右键处是否有可复制建表语句的物理表 */
const editorMenuCopy = ref(false)
/** 右键处是否有可跳转的定义 */
const editorMenuGoto = ref(false)

/** 编辑器内右键：接管浏览器默认菜单，在鼠标位置弹出，并解析该处的符号 */
function handleEditorContextMenu(event: MouseEvent) {
  event.preventDefault()
  editorMenuX.value = event.clientX
  editorMenuY.value = event.clientY
  editorMenuVisible.value = true
  resolveEditorMenuTarget(event)
}

/**
 * 解析右键位置能做什么。
 *
 * 判定全部交给编辑器组件（它握着语义解析与元数据）：这里只拿两个布尔结论 ——
 * 「能重命名什么」与「能不能复制建表语句」。这样菜单与实际动作永远同一个口径。
 */
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

/** 复制：有选中就复制选中，否则复制光标所在语句（未匹配到则提示） */
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

/**
 * 结果来源：解析表名（复制为 UPDATE / DELETE）与表头标记主键共用一套口径。
 *
 * 库用**生效库**（未手选时回退到连接默认库）—— 与执行时打在哪张表上一致，
 * 否则主键会查到一个空库名下去。
 */
function sourceOf(res: QueryResult): ResultSourceContext {
  return {
    connId: connId.value,
    database: effectiveDatabase.value,
    dbType: dbType.value,
    sql: res.sql,
  }
}

/** 处理「复制为…」：UPDATE / DELETE 以主键为条件，生成的 SQL 带库名 */
async function handleRowMenuSelect(item: ContextMenuAction) {
  const kind = kindOfMenuItem(item.key)
  const rows = rowMenuRows.value
  const data = rowMenuSource.value
  if (!kind || !rows.length || !data) {
    return
  }
  // 选中的每一行共用同一套上下文，只有 row 不同（表名与主键在生成时只解析一次）
  const base = { ...sourceOf(data), columns: data.columns.map(column => column.name) }
  await copyRowsSql(kind, rows.map(row => ({ ...base, row })))
}

// ------------------------------------------------------------ 初始化

/**
 * 首次初始化中：此时由 onMounted 负责加载库列表（要用 Tab 里恢复的库），
 * 让 connId 的 watcher 先不要重复加载——两次异步加载会互相覆盖选中的库。
 */
let initializing = true

onMounted(async () => {
  await loadConnections()

  // 恢复上次状态
  connId.value = (props.initialPayload.connId as number) ?? null
  sql.value = (props.initialPayload.sql as string) ?? ''
  editorHeight.value = Number(props.initialPayload.editorHeight) || editorHeight.value
  // 页大小 0 是合法值（不分页），不能用 || 兜底，否则恢复不出「不分页」
  if (props.initialPayload.pageSize !== undefined) {
    const savedPageSize = Number(props.initialPayload.pageSize)
    if (Number.isFinite(savedPageSize) && savedPageSize >= 0) {
      pageSize.value = savedPageSize
    }
  }

  // 恢复的高度可能超过当前窗口：先钳制再上报就绪，避免首帧结果区被挤没
  await nextTick()
  clampHeights()
  window.addEventListener('resize', clampHeights)

  try {
    await loadDatabases((props.initialPayload.database as string) ?? '')
  }
  finally {
    initializing = false
    // 失败也要上报，否则遮罩会一直盖住界面
    emit('ready')
  }
})

/**
 * 连接管理页改动连接后刷新下拉与库列表。
 *
 * 本页是常驻标签页（切换时只切显隐，不重新挂载），只在 onMounted 拉一次连接，
 * 不监听的话改名 / 换颜色 / 改默认库之后，数据源下拉里还是旧数据。
 */
const offConnectionsChanged = EventsOn('connections:changed', async () => {
  await loadConnections()
  // 默认库 / 可见库也可能一起变了：重拉库列表（已选的库仍按 loadDatabases 的约定保持不变）
  await loadDatabases()
})

onBeforeUnmount(() => {
  offConnectionsChanged()
  window.removeEventListener('resize', clampHeights)
  unregisterCompletionContext(editorView)
  editorView?.dom.removeEventListener('contextmenu', handleEditorContextMenu)
  editorView = null
})

/** 按容器高度重新钳制编辑器的高度（结果区占剩余空间，无需钳制） */
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

/**
 * 加载库列表。
 *
 * `preferred` 为本次希望使用的库（Tab 恢复 / 该连接上次用过的）。
 * 全程遵守一条铁律：**任何一次拉列表都不得悄悄改变将要执行的库**——
 * 现象级 bug 都是从这里来的（「我明明选过库，执行却打在别的库上」）：
 *
 *  1. 已有选择（多为用户手选）直接保持，列表里没有也保持，只提示一次；
 *  2. 只在「手头完全没有选择」时才按 preferred → 连接默认库 取值；
 *  3. **不用「列表第一个」兜底**：列表按名称排序，第一个常常是
 *     information_schema 或另一个环境的同名库，不带库名的语句
 *     （`SELECT * FROM device`）会因此悄悄打到别的库上；
 *  4. 拉列表失败时**保留用户的选择**（早先会清空，于是 effectiveDatabase
 *     静默回落成连接默认库，用户以为自己的选择生效了）；
 *  5. 切换连接后到达的旧响应直接丢弃，避免写到新连接上。
 */
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
      // 列表为空多半是账号权限（看不到任何库）或服务端配置问题，说清楚别让用户猜
      notify.warning('当前连接没有返回任何库：请检查账号权限，或点击旁边的刷新按钮重试')
      return true
    }

    if (database.value) {
      if (!list.some(info => info.name === database.value)) {
        // 选过的库这次不在列表里（权限变化 / 已删除 / 列表不完整）：保留并说明，不静默改库
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
    // 只清空候选列表，保留 database：否则执行时会静默落到连接默认库上
    allDatabases.value = []
    notify.error(`读取库列表失败：${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/** 切换连接：恢复该连接上次用过的库（没有则留空，由 loadDatabases 决定默认值） */
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
  // 清掉运行按钮上的状态
  clearRunStates()
  if (initializing) {
    // 首次挂载由 onMounted 统一加载（它还要用 Tab 里恢复的库），避免两次加载互相覆盖
    return
  }
  await loadDatabases(database.value)
})

/** 记下用户在这个连接上选过的库，供切回来时恢复 */
watch(database, (value) => {
  if (connId.value != null && value) {
    lastDatabaseByConn.set(connId.value, value)
  }
})

// ------------------------------------------------------------ 编辑器

function handleEditorMount(view: EditorView) {
  editorView = view
  /*
   * 挂载前 editorView 还是 null，formatTarget 等 computed 可能已被求值并存了 null；
   * 挂载后立刻播报一次，让「当前操作对象」与按钮状态从一开始就准确。
   */
  selectionSignal.value += 1
  // 切标签回来时编辑器是重建的：把已有的执行状态补推一次，按钮颜色不会丢
  syncRunStates()
  // 编辑器内右键：用自家菜单替换浏览器默认菜单
  view.dom.addEventListener('contextmenu', handleEditorContextMenu)
  registerCompletionContext(view, () => ({
    connId: connId.value ?? 0,
    // 用生效库而不是「手动选择」：没手选时也要能按连接默认库补全表名
    database: effectiveDatabase.value,
    // 方言影响补全插入的标识符引号（MySQL 反引号 / PostgreSQL 双引号）
    dbType: dbType.value,
  }))
}

/**
 * 编辑器快捷键（捕获阶段拦截，避免编辑器先把它当成输入）：
 *  - Ctrl/Cmd + Enter：执行当前语句
 *  - Alt + Shift + F：格式化（美化 / 压缩二合一，方向按当前范围形态决定）
 */
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

/**
 * 编辑器里当前可操作的文本范围（去掉首尾空白，保留外部缩进）。
 *
 * **不变量：`[from, to)` 与 `text` 完全一致**——执行、复制、替换都直接拿这两个值用，
 * 任何一侧多算或少算都会让文本被吃掉一段（曾因此把语句结尾的分号吞掉）。
 */
interface EditorRange {
  /** 起始偏移（含，已跳过前导空白） */
  from: number
  /** 结束偏移（不含，已跳过尾部空白） */
  to: number
  /** 范围内文本（已 trim） */
  text: string
}

/**
 * 解析当前操作的文本范围：**有选中就是选中内容，否则是光标所在的那条 SQL**。
 * 光标处没有语句时返回 null。
 */
function resolveRange(): EditorRange | null {
  const view = editorView
  if (!view) {
    return null
  }

  // CM6 的 selection.main 为空时 from === to，即「没有选中内容」
  const selection = view.state.selection.main
  if (!selection.empty) {
    const text = view.state.sliceDoc(selection.from, selection.to).trim()
    if (text) {
      // 选区两端可能带空白，向内收缩，替换时不动外部缩进
      const raw = view.state.sliceDoc(selection.from, selection.to)
      const lead = raw.length - raw.trimStart().length
      const tail = raw.length - raw.trimEnd().length
      return { from: selection.from + lead, to: selection.to - tail, text }
    }
  }

  const doc = view.state.doc.toString()
  /*
   * 光标所在语句（见 sqlStatementRanges）：空行、纯空白处不属于任何语句，
   * 执行器据此提示「光标处未匹配到 SQL 命令」；语句按分号或行首关键字分隔，
   * 所以不写分号、直接换行写第二条也能识别。
   */
  const statement = statementAtCursor(doc, selection.head, dbType.value)
  if (!statement) {
    return null
  }
  /*
   * 结尾分号要算进范围：美化/压缩的输出会保留分号，替换时必须连原分号一起换掉。
   * 注意 text 必须由同一段范围切出来——早先 to 含分号而 text 用了不含分号的
   * statement.sql，替换时就把分号吞掉了。
   */
  const to = statementEndWithSemicolon(doc, statement)
  return { from: statement.from, to, text: doc.slice(statement.from, to) }
}

// ------------------------------------------------------------ 执行与取消

/**
 * 执行：有选中内容就执行选中，否则执行光标所在的那条语句。
 *
 * 不再提供「执行全部」——一个动作两种含义容易误操作；
 * 需要跑整段脚本时全选（Ctrl+A）再执行即可，同样会逐条执行。
 */
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

  // 选中内容里可能包含多条语句，逐条执行（驱动不接受一次多条）
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

/** 光标 / 选区变化信号：编辑器状态不是响应式对象，靠它驱动下面两个 computed */
const selectionSignal = ref(0)

function handleEditorSelection() {
  selectionSignal.value += 1
}

/**
 * 当前可格式化的范围（有选中就是选中，否则是光标所在语句）。
 * 依赖 selectionSignal，所以光标一动就重算——按钮状态始终跟着「当前操作对象」走。
 */
const formatTarget = computed<EditorRange | null>(() => {
  void selectionSignal.value
  return resolveRange()
})

/**
 * 该往哪个方向格式化：当前范围已经写成多行 → 压缩，否则 → 美化。
 *
 * 写 SQL 的自然节奏就是「先写一行 → 展开看清楚 → 再压回去」，
 * 因此把两个方向合成一个按钮，按当前形态自动切换；
 * 分成两个按钮时总有一个是当前不适用的（点了要么没变化，要么把排版弄乱）。
 */
const formatAction = computed<'beautify' | 'minify'>(
  () => (formatTarget.value?.text.includes('\n') ? 'minify' : 'beautify'),
)

/** 按钮提示：这一下会做什么 + 快捷键 */
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

/** 与后端 isQueryStatement 同口径的查询关键字（其余一律按写操作处理） */
const QUERY_KEYWORDS = new Set([
  'select', 'show', 'describe', 'desc', 'explain', 'table', 'values',
])

/**
 * 是否写操作。
 *
 * 后端会用同一口径兜底校验，这里只是用来决定要不要弹确认框——
 * 判宽一点（把 WITH 也当写操作）最多多问一次，判窄了会漏掉生产库写操作。
 */
function isWriteStatement(sql: string): boolean {
  const first = /^\s*[a-z_]+/i.exec(sql)?.[0].trim().toLowerCase() ?? ''
  return first !== '' && !QUERY_KEYWORDS.has(first)
}

/**
 * 生产库写操作的执行前确认。
 *
 * 后端会校验请求里的 allowProductionWrite 标记（前端提示拦不住 DevTools 改参数），
 * 这里只是把「确认」这一步显式交给用户。未确认返回 false。
 */
async function confirmProductionWrite(sql: string): Promise<boolean> {
  const conn = currentConnection.value
  if (!conn?.isProduction || !isWriteStatement(sql)) {
    return true
  }
  /*
   * 取消是正常分支：旧写法用 try/catch + ElMessageBox，把「用户点了取消」
   * 和「弹窗真的出错」混在同一条 catch 里 —— 现在直接看返回值。
   * 语气用 danger 而不是 warning：这一步不可撤销，颜色该是危险色。
   */
  return askConfirm({
    message: `连接「${conn.name}」标记为生产库，即将执行写操作且不可撤销。确认继续？`,
    title: '生产库写操作确认',
    confirmText: '确认执行',
    tone: 'danger',
  })
}

/**
 * 执行单条语句：与脚本执行共用同一套「摘要 + 结果N」页签展示。
 *
 * @param sqlText 实际要发送的 SQL（分析模式调用方已包好 EXPLAIN）
 * @param options.stateKey 运行按钮状态的键（分析时传原始语句，键才与 gutter 对得上）
 * @param options.analysis 是否为分析执行（结果表格给出优化建议）
 */
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

  // 单条也走摘要结构，记录里展示原始语句（分析时 stateKey 是未包 EXPLAIN 的原文）
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
    // 生产库写操作：已在上一步弹窗确认，后端仍会校验这个标记
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
      // 用后端回带的生效库（没有则退回前端所选），0 行结果也能看清查的是哪个库
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
        // 后端按分页改写了 SQL：补一条实际执行的语句，便于核对
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
    // 有结果集就自动切到结果页签（写语句没有结果页签，留在摘要）
    if (scriptResults.value.length && activeScriptTab.value === 'summary') {
      activeScriptTab.value = 'result-1'
    }
    running.value = false
    runningCall = null
  }
}

/** 包一层 EXPLAIN；本身就是 EXPLAIN 的语句原样返回 */
function toExplainSql(sql: string): string {
  return /^explain\b/i.test(sql.trim()) ? sql : `EXPLAIN ${sql}`
}

/**
 * 执行整段脚本：按分号切分后**逐条**发送。
 *
 * 必须逐条发送：驱动不接受一次多条语句（拼在一起 MySQL 会报 1064 语法错误）。
 * 某条失败不中断后续语句——否则统计不出「失败几条」，摘要也就失去意义；
 * 只有用户主动取消才停下来。执行过程中摘要实时刷新，可看到每条的状态与耗时。
 *
 * @param mode `analyze` 时每条语句包一层 EXPLAIN 后发送（分析模式），
 *             运行按钮的状态仍记在**原始语句**上。
 */
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

  /*
   * 汇总在本地累积，每步结束后整体同步到响应式状态。
   * 直接改原始对象的字段不会触发视图更新（响应式只追踪代理上的写入），
   * 所以这里统一走 sync() 生成新对象。
   */
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

  /*
   * 生产库：脚本里只要含写操作，开始前统一确认一次。
   * 后端仍会逐条校验 allowProductionWrite，这里的弹窗只是交互。
   */
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

  /*
   * 执行结束后自动切页签：有结果集就直接选中第一个结果页签
   * （写语句居多、没有任何结果集时留在摘要）。
   * 只在用户没有手动切过页签时切，避免覆盖用户的选择。
   */
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

/**
 * 按新的页码 / 页大小重新执行某条结果。
 *
 * 各结果页签独立分页；页大小 0 表示不分页（页码传 0，后端不追加 LIMIT）。
 * 翻页时把上次的总数带回，省掉一次全量统计；页大小变化、或从「不分页」
 * 切换过来时口径不同，必须重新统计。
 */
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

/** 改某条结果的每页条数（0 表示不分页）；同时更新后续执行的默认页大小 */
function changeResultPageSize(index: number, size: number) {
  const entry = scriptResults.value.find(item => item.index === index)
  if (!entry) {
    return
  }
  pageSize.value = size
  void reloadResultPage(index, 1, size)
}

/**
 * 分析：对当前范围里的每条语句执行 EXPLAIN，执行计划展示在结果区。
 *
 * 与运行共用同一套范围与脚本流程（有选中取选中，否则取光标所在语句）：
 * 单条语句像执行一样直接出结果；多条语句走脚本流程逐条分析并给出汇总。
 */
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

/** 识别「用户取消」类错误，与真正的执行失败区分展示 */
function isCancelled(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('cancel') || message.includes('已取消')
}

/**
 * 拖编辑器下边界调整高度：编辑器变高、结果区变矮。
 *
 * 拖动过程只改本地状态（保证跟手），松手才上报持久化，
 * 避免每移动一个像素就写一次 Tab payload。
 */
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
  // 拖动期间即使光标滑到编辑器上方，也保持拖拽光标与禁止选中
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
}

/** 数值钳制 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 刷新元数据：库列表 + 当前库的表字段缓存一并重拉（库列表拉失败时可在这里恢复）。
 *
 * 元数据缓存由 metadataStore 统一持有，刷新后连接管理页与补全都会立刻用到新数据。
 */
async function refreshMeta() {
  if (!connId.value) {
    return
  }
  const requested = connId.value
  const ok = await loadDatabases(lastDatabaseByConn.get(requested) ?? database.value)
  const meta = useMetadataStore()
  meta.invalidateConnection(requested)
  // 表列表按需重拉；字段缓存已随连接一起失效，用户点开表或补全时再加载
  void meta.loadTables(requested, effectiveDatabase.value, true)
  if (ok) {
    notify.success('元数据已刷新')
  }
}

// ------------------------------------------------------------ 状态同步

/** 上次上报的状态指纹，防止「上报 → 保存 → 重渲染」循环 */
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
    <!-- 顶部操作栏：连接 → 库 → 元数据 → 执行 / 取消 -->
    <header class="executor__toolbar">
      <div class="executor__toolbar-left">
        <ConnectionSelect v-model="connId" :connections="connections" width="210px" />

        <Combobox
          v-model="database"
          :options="databaseOptions"
          :placeholder="databasePlaceholder"
          search-placeholder="搜索数据库…"
          class="w-[190px]"
        >
          <!-- 系统库带一个「系统」标记：解释「为什么关掉设置后它就不见了」 -->
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
      </div>

    </header>

    <!-- 编辑器操作行：运行/终止（同一位置切换）、格式化（图标按钮） -->
    <div class="executor__actions">
      <!-- 运行与终止共用一个按钮：执行中变成终止，不再并排显示两个 -->
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

      <!-- 分析：用 EXPLAIN 查看执行计划，结果在结果区展示 -->
      <Button
        variant="secondary"
        size="icon"
        :disabled="running"
        title="EXPLAIN 分析"
        @click="analyzeSql"
      >
        <Icon name="chart" />
      </Button>

      <!-- 美化 / 压缩合成一个按钮：当前范围是单行就美化，是多行就压缩 -->
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

    <!-- 编辑器：Ctrl+Enter 执行；识别出的语句带边框；高度可拖 -->
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

    <!-- 结果区：执行日志固定页签在最前，摘要与各结果页签随后 -->
    <section class="executor__result">
      <TabGroup v-model="activeScriptTab" :items="resultTabs" class="min-h-0 flex-1">
        <template #panel-log>
          <ExecutionLog ref="logRef" />
        </template>

        <template v-if="scriptSummary" #panel-summary>
          <ScriptSummary :summary="scriptSummary" />
        </template>

        <!--
          结果页签是动态的（每条返回结果集的语句一个）：插槽名随语句序号变化，
          所以这里用 `#[`panel-result-N`]` 的动态插槽名 —— 与 ResultTable 的单元格插槽同一套路。
        -->
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

            <!-- 分页常驻：页大小填 0 即不分页；语句不支持分页时由 supported 提示 -->
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

.executor__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  /* 下边框移到操作行上：两行合起来算一个头部区块 */
  padding: 10px 16px 8px;
}

/*
 * 库下拉里的「系统」标记（判定见 utils/sql/sqlVisibility.ts）：
 * 说明这一项是数据库自带对象，关掉「展示系统库」后它就消失。弱化右对齐，不抢名字。
 */
.executor__db-system {
  float: right;
  margin-left: 12px;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}

.executor__toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 编辑器操作行：执行 / 美化 / 压缩；只放图标按钮，单独一行 */
.executor__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 0 0 auto;
  padding: 0 16px 8px;
  border-bottom: 1px solid var(--border-color);
}

/* 编辑器高度由分栏拖动决定（高度内联在标签上），结果区占剩余空间 */
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
  background: var(--brand-color);
}

.executor__result {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  /* 页签栏贴住分界线：上方不留多余空白 */
  padding: 2px 16px 0;
  /* 与 SQL 查询页一致：结果区上方有一条分界线 */
  border-top: 1px solid var(--border-color);
}

/* 结果表格自己滚动；横向留白与摘要表格对齐（分栏 padding 已足够，不再另加） */
.executor__result :deep(.result-table) {
  flex: 1;
  min-height: 0;
  padding: 0;
}

/* 结果页签（摘要 / 结果N）的版面由 TabGroup 自带（页签栏固定 + 内容占满剩余高度） */</style>
