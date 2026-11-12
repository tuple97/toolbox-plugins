<script setup lang="ts">
/** Agent 账号面板：按来源展示账号，并触发动作与导入。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import CheckList from '@/components/ui/CheckList.vue'
import CheckMark from '@/components/ui/CheckMark.vue'
import Combobox from '@/components/ui/Combobox.vue'
import Dialog from '@/components/ui/Dialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Icon from '@/components/ui/Icon.vue'
import Tabs from '@/components/ui/Tabs.vue'
import Tag from '@/components/ui/Tag.vue'
import Toolbar from '@/components/ui/Toolbar.vue'
import ContextMenu from '@/components/ContextMenu.vue'
import { askConfirm } from '@/utils/confirm'
import { copyText } from '@/utils/clipboard'
import { nextOverlayZIndex } from '@/utils/overlay'
import { notify } from '@/utils/notify'
import { invoke, openExternal } from './bridge'

interface SourceConfig {
  id: string
  label: string
  api: string
  capabilities: {
    usage?: boolean
    checkin?: boolean
    oauth?: boolean
    /** 是否支持把 token 写回本地登录态；未声明视为支持 */
    targets?: boolean
    /** 是否支持「设为当前」切换；未声明视为支持 */
    switch?: boolean
  }
}

interface Quota {
  remain: number
  total: number
  cycleEnd: string
  packages: number
  updatedAt: string
  /** percent：接口只给剩余比例（Antigravity），界面按百分数展示 */
  unit?: 'percent' | string
}

/**
 * 一个可写入的登录态位置。
 * JetBrains 系按「文件 + 键名」定位，VSCode 系按宿主给的位置 ID 定位。
 */
interface LoginTarget {
  kind: 'vscode' | 'jetbrains' | 'trae'
  /** VSCode 系的位置标识 */
  id?: string
  file?: string
  key?: string
  channel?: string
  /** 位置所属产品（VSCode 系来自宿主，Trae 来自发行版目录） */
  product?: string
}

interface AccountView {
  id: string
  source: string
  name: string
  addedAt: string
  updatedAt: string
  quota: Quota | null
  checkin: { state?: string, message?: string, lastAt?: string, streak?: number } | null
  /** 勾选过、要应用到的登录态位置 */
  targets?: LoginTarget[]
  /** IDEA 里实际登录的是不是这个账号 */
  ideaCurrent?: boolean
  current: boolean
}

interface ActionConfig {
  id: string
  label: string
  scope: 'account' | 'source'
  sources: string[]
  /** 仅对当前账号可用 */
  currentOnly?: boolean
}

interface Snapshot {
  sources: SourceConfig[]
  actions: ActionConfig[]
  accounts: AccountView[]
  current: Record<string, string>
}

const state = ref<Snapshot | null>(null)
/** 来源过滤：多选，空表示全部 */
const activeSources = ref<string[]>([])
const busyId = ref('')

const importVisible = ref(false)
const importSource = ref('')
const importText = ref('')
const importing = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const sources = computed(() => state.value?.sources ?? [])
/** 来源过滤为收窄条件：未选任何来源时显示全部账号 */
function sourceMatch(sourceId: string): boolean {
  return activeSources.value.length === 0 || activeSources.value.indexOf(sourceId) >= 0
}

const accounts = computed(() => {
  const list = state.value?.accounts ?? []
  return list.filter(item => sourceMatch(item.source))
})
const accountActions = computed(() => {
  const list = state.value?.actions ?? []
  return list.filter(
    item => item.scope === 'account' && item.sources.some(id => sourceMatch(id)),
  )
})

/** 账号卡片上的动作：只显示这个来源真的支持的动作（签到无需先设为当前账号） */
function actionsFor(account: AccountView): ActionConfig[] {
  return accountActions.value.filter(item => item.sources.indexOf(account.source) >= 0)
}

/**
 * 来源是否具备某项能力。
 * 未声明一律视为「支持」——存量来源不用改配置，新渠道暂时没有方案的显式写 false 即可。
 */
function supportsOf(account: AccountView, key: 'targets' | 'switch'): boolean {
  const source = state.value?.sources?.find(item => item.id === account.source)
  const capabilities = source?.capabilities as Record<string, unknown> | undefined
  return capabilities?.[key] !== false
}

/**
 * 一键签到：跨来源动作。
 *
 * 只保留一个按钮，点击后由后端签**所有支持签到的账号**，
 * 不受左侧来源勾选影响（勾选只是界面过滤，不该限制签到范围）。
 */
const checkinAllAction = computed(() =>
  (state.value?.actions ?? []).find(item => item.id === 'checkin-all') ?? null)

/** 可签到账号数：为 0 时连按钮都不显示 */
const checkinableCount = computed(() => {
  const action = checkinAllAction.value
  if (!action) {
    return 0
  }
  return (state.value?.accounts ?? []).filter(item => action.sources.indexOf(item.source) >= 0).length
})
/** 左侧来源菜单的选项：数量单独显示，不塞进标签 */
const sourceOptions = computed(() =>
  sources.value.map(item => ({
    label: item.label,
    value: item.id,
    count: countOf(item.id),
  })))

/** 按账号数降序；数量相同时保持来源声明顺序 */
const sortedSourceOptions = computed(() =>
  [...sourceOptions.value].sort((a, b) => b.count - a.count))

/** CheckList 要「勾选的即显示」，而内部用空数组表示全部，这里换算一下 */
const checkedSources = computed(() => {
  if (activeSources.value.length > 0) {
    return activeSources.value
  }
  return sources.value.map(item => item.id)
})

/** 全勾时回到「空 = 全部」，与筛选逻辑保持一致 */
function onSourcesChange(next: string[]): void {
  const all = sources.value.map(item => item.id)
  activeSources.value = next.length >= all.length ? [] : next
}



/** 导入弹窗的来源单选：不带账号数量，配合搜索更干净 */
const importSourceOptions = computed(() =>
  sources.value.map(item => ({ label: item.label, value: item.id })))
const filterLabel = computed(() => {
  const labels = sources.value
    .filter(item => activeSources.value.indexOf(item.id) >= 0)
    .map(item => item.label)
  if (labels.length === 0 || labels.length === sources.value.length) {
    return '所有来源'
  }
  return labels.join('、')
})
function sourceLabelOf(sourceId: string): string {
  return sources.value.find(item => item.id === sourceId)?.label ?? sourceId
}

function countOf(sourceId: string): number {
  return (state.value?.accounts ?? []).filter(item => item.source === sourceId).length
}

function applyState(next: Snapshot): void {
  state.value = next
  // 空表示查询全部（见 sourceMatch）
  if (!importSource.value && next.sources.length > 0) {
    importSource.value = next.sources[0].id
  }
}

async function refresh(): Promise<void> {
  const next = await invoke<Snapshot>('state')
  applyState(next)
}

/** 三种导入方式：网页登录 / 粘贴 token / 本地文件 */
const ALL_IMPORT_MODES = [
  { value: 'oauth', label: '网页登录' },
  { value: 'token', label: '粘贴 Token' },
  { value: 'file', label: '登录态导入' },
]

/** 按来源能力过滤：不支持网页登录的来源不显示该页签 */
const importModes = computed(() => {
  const source = sources.value.find(item => item.id === importSource.value)
  const oauth = source?.capabilities?.oauth !== false
  return ALL_IMPORT_MODES.filter(item => item.value !== 'oauth' || oauth)
})

const importMode = ref('oauth')

// 切换来源后若当前页签不可用，回落到第一个可用项
watch(importSource, () => {
  if (!importModes.value.some(item => item.value === importMode.value)) {
    importMode.value = importModes.value[0]?.value ?? 'token'
  }
})

const webLoginBusy = ref(false)
/** 登录成功后待确认导入的账号；null 表示还没有结果 */
const loginResult = ref<{
  token: string
  name: string
  email: string
  quota: Quota | null
} | null>(null)
/** 设备码流程要展示给用户的代码（没有则为空） */
const loginCode = ref('')
/** 用户点了取消：轮询循环据此尽快退出 */
let loginCancelled = false

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 网页登录：打开授权页并轮询，拿到 token 后展示账号与余量，再由用户确认导入 */
async function webLogin(): Promise<void> {
  if (!importSource.value) {
    notify.warning('请先选择来源')
    return
  }

  loginResult.value = null
  loginCode.value = ''
  loginCancelled = false
  webLoginBusy.value = true
  try {
    const start = await invoke<{
      authUrl: string
      expiresIn: number
      intervalMs: number
      userCode?: string
      verificationUri?: string
    }>('oauthStart', { source: importSource.value })

    // 设备码流程：代码要留在界面上，用户在浏览器里输入
    loginCode.value = start.userCode ?? ''
    openExternal(start.verificationUri || start.authUrl)
    notify.info('已在浏览器打开登录页，完成后会自动回填')

    const interval = start.intervalMs > 0 ? start.intervalMs : 1500
    const deadline = Date.now() + start.expiresIn * 1000
    while (Date.now() < deadline) {
      if (loginCancelled) {
        return
      }
      await sleep(interval)
      // 等待期间可能已经取消，这里再判一次，避免多打一次请求
      if (loginCancelled) {
        return
      }
      const result = await invoke<{
        done: boolean
        token?: string
        email?: string
        name?: string
        quota?: Quota | null
      }>('oauthPoll')
      if (loginCancelled) {
        return
      }
      if (!result.done || !result.token) {
        continue
      }
      loginResult.value = {
        token: result.token,
        name: result.name || result.email || '',
        email: result.email || '',
        quota: result.quota ?? null,
      }
      notify.success('登录成功，确认账号后点「导入」')
      return
    }
    notify.warning('登录超时，请重新发起')
  }
  catch (e) {
    if (!loginCancelled) {
      notify.error(e instanceof Error ? e.message : String(e))
    }
  }
  finally {
    webLoginBusy.value = false
  }
}

/** 取消登录：清掉后端的待轮询会话，解锁按钮以便重新发起 */
async function cancelWebLogin(): Promise<void> {
  loginCancelled = true
  try {
    await invoke('cancelLogin')
  }
  catch {
    // 后端没有待处理会话时忽略
  }
  webLoginBusy.value = false
  notify.info('已取消登录')
}

/** 确认导入登录拿到的账号 */
async function importLoginResult(): Promise<void> {
  const result = loginResult.value
  if (!result) {
    return
  }
  importText.value = result.token
  await importAccounts()
  loginResult.value = null
}

/** 卡片右键菜单 */
const cardMenuVisible = ref(false)
const cardMenuX = ref(0)
const cardMenuY = ref(0)
const cardMenuAccount = ref<AccountView | null>(null)
const CARD_MENU_ITEMS = [{ key: 'copy-token', label: '复制 Token' }]

function openCardMenu(event: MouseEvent, account: AccountView): void {
  event.preventDefault()
  cardMenuAccount.value = account
  cardMenuX.value = event.clientX
  cardMenuY.value = event.clientY
  cardMenuVisible.value = true
}

async function handleCardMenu(item: { key: string }): Promise<void> {
  const account = cardMenuAccount.value
  if (item.key !== 'copy-token' || !account) {
    return
  }
  try {
    const result = await invoke<{ token: string }>('reveal', { id: account.id })
    await copyText(result.token)
    notify.success('Token 已复制到剪贴板')
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

const scanBusy = ref(false)
/**
 * `source` 由后端给出：Trae 国际版与国内版的文件结构一样、令牌不通用，
 * 必须按扫描到的那份登录态落到各自的来源，否则余量会打到错误的站点。
 */
const scanned = ref<Array<{ token: string, channel: string, file: string, name?: string, source?: string }>>([])
/** 勾选的扫描结果（按 token 记，重复 token 本来就已去重） */
const scannedSelected = ref<string[]>([])
/** 尚不支持自动扫描的渠道 */
const scanPending = ref<string[]>([])

/** 扫描本机各渠道的登录态 */
async function scanLocalAuth(): Promise<void> {
  scanBusy.value = true
  try {
    const result = await invoke<{
      accounts: Array<{ token: string, channel: string, file: string, name?: string, source?: string }>
      pending: string[]
    }>('scanLocalAuth')
    scanned.value = result.accounts ?? []
    scanPending.value = result.pending ?? []
    // 默认全选：绝大多数场景就是「扫到啥导啥」，取消勾选才是例外
    scannedSelected.value = scanned.value.map(item => item.token)
    if (!scanned.value.length) {
      notify.info('没扫到已登录的本地账号')
    }
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    scanBusy.value = false
  }
}

/** 勾选/取消勾选一条扫描结果 */
function toggleScanned(token: string): void {
  const index = scannedSelected.value.indexOf(token)
  if (index >= 0) {
    scannedSelected.value.splice(index, 1)
  }
  else {
    scannedSelected.value.push(token)
  }
}

/** 当前勾选数量 */
const scannedSelectedCount = computed(
  () => scanned.value.filter(item => scannedSelected.value.indexOf(item.token) >= 0).length,
)

/** 全选 / 全不选 */
function toggleAllScanned(checked: boolean): void {
  scannedSelected.value = checked ? scanned.value.map(item => item.token) : []
}

/** 全选框的 change 事件（模板里不写类型断言） */
function onToggleAllScanned(event: Event): void {
  const target = event.target as HTMLInputElement | null
  toggleAllScanned(Boolean(target?.checked))
}

/**
 * 把**勾选的**扫描结果导入。
 *
 * 按后端给的 `source` 分组：Trae 国际版/国内版（以及将来按来源分组的渠道）
 * 各进自己的来源，没给 `source` 的仍用当前选中的来源。
 */
async function importScanned(): Promise<void> {
  const picked = scanned.value.filter(item => scannedSelected.value.indexOf(item.token) >= 0)
  if (!picked.length) {
    notify.warning('请先勾选要导入的账号')
    return
  }
  const groups = new Map<string, string[]>()
  for (const item of picked) {
    const source = item.source || importSource.value
    const list = groups.get(source) ?? []
    list.push(item.token)
    groups.set(source, list)
  }

  importing.value = true
  try {
    let added = 0
    let skipped = 0
    let latest: Snapshot | null = null
    for (const [source, tokens] of groups) {
      const result = await invoke<{ added: number, skipped: number, state: Snapshot }>('import', {
        source,
        text: tokens.join('\n'),
      })
      added += result.added
      skipped += result.skipped
      latest = result.state
    }
    if (latest) {
      applyState(latest)
    }
    importText.value = ''
    importVisible.value = false
    notify.success(
      skipped > 0
        ? `已导入 ${added} 个账号，跳过 ${skipped} 个重复项`
        : `已导入 ${added} 个账号`,
    )
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    importing.value = false
  }
}

async function importAccounts(): Promise<void> {
  const text = importText.value.trim()
  if (!text) {
    notify.warning('请先粘贴 token 或账号 JSON')
    return
  }
  importing.value = true
  try {
    const result = await invoke<{ added: number, skipped: number, state: Snapshot }>('import', {
      source: importSource.value,
      text,
    })
    applyState(result.state)
    importText.value = ''
    importVisible.value = false
    notify.success(
      result.skipped > 0
        ? `已导入 ${result.added} 个账号，跳过 ${result.skipped} 个重复项`
        : `已导入 ${result.added} 个账号`,
    )
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    importing.value = false
  }
}

/** 从文本文件读入导入内容 */
async function importFromFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  try {
    importText.value = await file.text()
    notify.success(`已读取 ${file.name}`)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    input.value = ''
  }
}

async function removeAccount(account: AccountView): Promise<void> {
  const confirmed = await askConfirm({
    message: `确定删除「${account.name}」吗？该账号的本地记录会一并清除。`,
    title: '删除账号',
    confirmText: '删除',
  })
  if (!confirmed) {
    return
  }
  try {
    const next = await invoke<Snapshot>('remove', { id: account.id })
    applyState(next)
    notify.success('账号已删除')
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

// ---------------------------------------------------------------- 登录态位置（气泡）

const targetsVisible = ref(false)
const targetsAccount = ref<AccountView | null>(null)
const targetsScanBusy = ref(false)
const targetsSaving = ref(false)
/** 气泡定位与层级 */
const targetsPos = ref({ left: 0, top: 0 })
const targetsZ = ref(0)
const targetsPanel = ref<HTMLElement | null>(null)
/** 可选位置（来自本地登录态扫描） */
const targetOptions = ref<LoginTarget[]>([])
/** 已勾选的位置，键为 file|key */
const targetChoice = ref<string[]>([])
let targetsSaveTimer: ReturnType<typeof setTimeout> | null = null
/** 悬停收起用的延时器：留出从按钮移到气泡的时间 */
let targetsCloseTimer: ReturnType<typeof setTimeout> | null = null

/** 气泡宽度，定位与视口避让都要用 */
const TARGETS_PANEL_WIDTH = 288

function targetIdOf(target: LoginTarget): string {
  if (target.kind === 'vscode') {
    return `vscode:${target.id ?? ''}`
  }
  if (target.kind === 'trae') {
    return `trae:${target.file ?? ''}`
  }
  return `jetbrains:${target.file ?? ''}|${target.key ?? ''}`
}

/**
 * 位置与账号来源是否属于同一产品。
 *
 * 位置是「某个应用程序里的登录态存储」，只能写它自己产品的令牌：
 * 把 CodeBuddy 的 token 写进 Qoder 的库，两个应用都会坏。
 * 老数据没有 product 时放行（升级前存的勾选不该突然失效）。
 */
function targetMatchesSource(target: LoginTarget, sourceId: string): boolean {
  const product = target.product ?? ''
  if (!product) {
    return true
  }
  if (product === sourceId) {
    return true
  }
  if (product === 'codebuddy-family') {
    return sourceId === 'codebuddy' || sourceId === 'codebuddy-cn' || sourceId === 'workbuddy'
  }
  return false
}

/** 只列这台机器上、且属于当前账号产品的登录态位置 */
const visibleTargetOptions = computed(() => {
  const account = targetsAccount.value
  if (!account) {
    return targetOptions.value
  }
  return targetOptions.value.filter(item => targetMatchesSource(item, account.source))
})

/** 扫描本地登录态，作为可勾选位置；同一 file+key 只保留一条 */
async function loadTargetOptions(): Promise<void> {
  targetsScanBusy.value = true
  try {
    const result = await invoke<{
      accounts: Array<{
        kind?: string
        id?: string
        file?: string
        key?: string
        channel?: string
        product?: string
      }>
    }>('scanLocalAuth')
    const seen: Record<string, boolean> = {}
    const list: LoginTarget[] = []
    for (const item of result.accounts ?? []) {
      // Zed / Codex 的登录态是客户端自有结构，只能导入查看
      if (item.kind === 'zed' || item.kind === 'codex') {
        continue
      }
      if (item.kind === 'vscode') {
        if (!item.id) {
          continue
        }
        const id = `vscode:${item.id}`
        if (seen[id]) {
          continue
        }
        seen[id] = true
        list.push({ kind: 'vscode', id: item.id, channel: item.channel, product: item.product })
        continue
      }
      if (item.kind === 'trae') {
        if (!item.file) {
          continue
        }
        const id = `trae:${item.file}`
        if (seen[id]) {
          continue
        }
        seen[id] = true
        list.push({
          kind: 'trae',
          file: item.file,
          key: item.key,
          channel: item.channel,
          product: item.product,
        })
        continue
      }
      if (!item.file || !item.key) {
        continue
      }
      const id = `jetbrains:${item.file}|${item.key}`
      if (seen[id]) {
        continue
      }
      seen[id] = true
      list.push({
        kind: 'jetbrains',
        file: item.file,
        key: item.key,
        channel: item.channel,
        product: item.product,
      })
    }
    targetOptions.value = list
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    targetsScanBusy.value = false
  }
}

/** 贴在按钮下方；空间不够翻到上方，并限制在视口内 */
function placeTargetsPanel(trigger: HTMLElement): void {
  const rect = trigger.getBoundingClientRect()
  const gap = 6
  const estimated = 240
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - TARGETS_PANEL_WIDTH - 8))
  const below = rect.bottom + gap
  const top = below + estimated > window.innerHeight && rect.top > estimated
    ? rect.top - gap - estimated
    : below
  targetsPos.value = { left, top: Math.max(8, top) }
  targetsZ.value = nextOverlayZIndex()
}

function openTargets(account: AccountView, event: MouseEvent): void {
  cancelCloseTargets()
  // 已经是同一个账号：只刷新位置，别把已勾选的重置掉
  if (!(targetsVisible.value && targetsAccount.value?.id === account.id)) {
    targetsAccount.value = account
    targetChoice.value = (account.targets ?? []).map(targetIdOf)
  }
  const trigger = event.currentTarget as HTMLElement | null
  if (trigger) {
    placeTargetsPanel(trigger)
  }
  targetsVisible.value = true
  if (targetOptions.value.length === 0) {
    void loadTargetOptions()
  }
}

/** 鼠标移出后稍等一下再收起：留出从按钮挪到气泡上的时间 */
function scheduleCloseTargets(): void {
  if (targetsCloseTimer) {
    clearTimeout(targetsCloseTimer)
  }
  targetsCloseTimer = setTimeout(() => {
    targetsCloseTimer = null
    closeTargets()
  }, 200)
}

function cancelCloseTargets(): void {
  if (targetsCloseTimer) {
    clearTimeout(targetsCloseTimer)
    targetsCloseTimer = null
  }
}

/** 收起气泡；还有没落库的勾选就补存一次 */
function closeTargets(): void {
  cancelCloseTargets()
  targetsVisible.value = false
  if (targetsSaveTimer) {
    clearTimeout(targetsSaveTimer)
    targetsSaveTimer = null
    void saveTargets()
  }
}

function toggleTarget(target: LoginTarget): void {
  const id = targetIdOf(target)
  targetChoice.value = targetChoice.value.includes(id)
    ? targetChoice.value.filter(item => item !== id)
    : [...targetChoice.value, id]
  // 勾一下就存，不用再点保存；防抖避免连点打多次请求
  if (targetsSaveTimer) {
    clearTimeout(targetsSaveTimer)
  }
  targetsSaveTimer = setTimeout(() => {
    targetsSaveTimer = null
    void saveTargets()
  }, 400)
}

/** 只更新选择，不关闭气泡（关掉就没法接着勾了） */
async function saveTargets(): Promise<void> {
  const account = targetsAccount.value
  if (!account) {
    return
  }
  // 只保存「这台机器上确实存在、且属于当前产品」的位置：
  // 旧版本存下的跨产品位置（如 CodeBuddy 账号绑了 Qoder）会在这里被自然清掉
  const picked = visibleTargetOptions.value.filter(item => targetChoice.value.includes(targetIdOf(item)))
  targetsSaving.value = true
  try {
    const next = await invoke<Snapshot>('setTargets', { id: account.id, targets: picked })
    applyState(next)
    const fresh = next.accounts.find(item => item.id === account.id)
    if (fresh) {
      targetsAccount.value = fresh
    }
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    targetsSaving.value = false
  }
}

/** 点气泡与触发按钮以外的地方收起 */
function onTargetsPointerDown(event: PointerEvent): void {
  if (!targetsVisible.value) {
    return
  }
  const target = event.target as Node
  if (targetsPanel.value?.contains(target)) {
    return
  }
  if ((target as HTMLElement)?.closest?.('.account-card__targets')) {
    return
  }
  closeTargets()
}

function onTargetsKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && targetsVisible.value) {
    closeTargets()
  }
}

document.addEventListener('pointerdown', onTargetsPointerDown, true)
document.addEventListener('keydown', onTargetsKeydown)

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onTargetsPointerDown, true)
  document.removeEventListener('keydown', onTargetsKeydown)
  if (targetsSaveTimer) {
    clearTimeout(targetsSaveTimer)
  }
  if (targetsCloseTimer) {
    clearTimeout(targetsCloseTimer)
  }
})

async function toggleCurrent(account: AccountView): Promise<void> {
  try {
    const targets = account.targets ?? []
    // 设为当前时，先把 token 写进勾选的位置
    if (!account.current && targets.length > 0) {
      const applied = await invoke<{
        results: Array<{ ok: boolean, channel?: string, error?: string }>
        state: Snapshot
      }>('applyAccount', { id: account.id, targets })
      applyState(applied.state)
      const done = (applied.results ?? []).filter(item => item.ok).length
      const failed = (applied.results ?? []).filter(item => !item.ok)
      if (failed.length > 0) {
        notify.warning(`已写入 ${done} 个位置，${failed.length} 个失败：${failed[0]?.error ?? ''}`)
      }
      else if (done > 0) {
        notify.success(`已写入 ${done} 个登录态位置`)
      }
    }
    const next = await invoke<Snapshot>('setCurrent', { id: account.id, source: account.source })
    applyState(next)
    if (account.current) {
      notify.success('已取消当前账号')
    }
    else if (targets.length === 0) {
      notify.success(`已切换到 ${account.name}`)
    }
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 单个账号动作（刷新余量 / 签到） */
async function runAccountAction(action: ActionConfig, account: AccountView): Promise<void> {
  busyId.value = account.id + ':' + action.id
  try {
    const result = await invoke<{
      results: Array<{ id: string, ok: boolean, error?: string, message?: string, already?: boolean, quota?: Quota }>
      state: Snapshot
    }>('runAction', { action: action.id, source: account.source, ids: [account.id] })
    applyState(result.state)
    const item = result.results[0]
    if (item && !item.ok) {
      notify.error(item.error || '操作失败')
    }
    else if (action.id === 'checkin') {
      // 「今天已签过」与「刚签到」区分提示
      if (item?.already) {
        notify.info(item?.message || '今天已经签到过了')
      }
      else {
        notify.success(item?.message || '签到成功')
      }
    }
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    busyId.value = ''
  }
}

/** 一键签到：签所有支持签到的账号（跨来源），并汇总结果 */
async function runCheckinAll(): Promise<void> {
  busyId.value = 'checkin-all'
  try {
    const result = await invoke<{
      results: Array<{ id: string, ok: boolean, error?: string, message?: string, already?: boolean }>
      state: Snapshot
    }>('runAction', { action: 'checkin-all' })
    applyState(result.state)

    const done = result.results.filter(item => item.ok && !item.already).length
    const skipped = result.results.filter(item => item.ok && item.already).length
    const failed = result.results.filter(item => !item.ok)

    if (failed.length === 0) {
      if (done === 0) {
        notify.info(`没有可签到的账号（${skipped} 个今天已签过）`)
      }
      else {
        const parts = [`新签到 ${done} 个`]
        if (skipped > 0) {
          parts.push(`${skipped} 个今天已签过`)
        }
        notify.success(parts.join('，'))
      }
    }
    else {
      notify.warning(
        `新签 ${done} 个，已签 ${skipped} 个，失败 ${failed.length} 个。${failed[0].error ?? ''}`,
      )
    }
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    busyId.value = ''
  }
}

function quotaText(account: AccountView): string {
  return quotaTextOf(account.quota)
}

/** ISO 时间转本地 HH:mm；存量数据是 UTC，直接截字符串会差时区 */
function formatLocalTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 登录结果里的余量文案（与账号卡片保持一致的口径） */
function quotaTextOf(quota: Quota | null): string {
  if (!quota) {
    return '未查询余量'
  }
  if (quota.unit === 'percent') {
    return `剩余 ${quota.remain}%`
  }
  return `${quota.remain} / ${quota.total}`
}

/** 底部「导入」按钮是否可用：登录模式必须先拿到账号 */
const canImport = computed(() => {
  if (importMode.value === 'oauth') {
    return loginResult.value !== null
  }
  if (importMode.value === 'token') {
    return importText.value.trim().length > 0
  }
  return false
})

function quotaPercent(account: AccountView): number {
  const quota = account.quota
  if (!quota) {
    return 0
  }
  // 百分数口径的余量本身就是百分比，直接当进度条宽度
  if (quota.unit === 'percent') {
    return Math.max(0, Math.min(100, Math.round(quota.remain)))
  }
  if (quota.total <= 0) {
    return 0
  }
  return Math.max(0, Math.min(100, Math.round((quota.remain / quota.total) * 100)))
}

function checkinText(account: AccountView): string {
  if (!account.checkin) {
    return '未签到'
  }
  return account.checkin.message || (account.checkin.state === 'claimed' ? '已签到' : '未签到')
}

onMounted(async () => {
  try {
    await refresh()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
})
</script>

<template>
  <div class="accounts">
    <!-- 左侧来源菜单：搜索 + 多选复选框 -->
    <aside class="accounts__side">
      <!-- 搜索与多选由宿主组件统一提供，插件不再自己拼 -->
      <CheckList
        :items="sortedSourceOptions"
        :model-value="checkedSources"
        placeholder="搜索来源"
        empty-text="没有匹配的来源"
        @update:model-value="onSourcesChange"
      />
    </aside>

    <div class="accounts__main">
      <!-- 头部用宿主的 Toolbar：右侧操作区自动贴右，底边框与内边距统一 -->
      <Toolbar>
        <template #actions>
        <!-- 一键签到：一个按钮签所有支持签到的账号（跨来源，不受左侧过滤影响） -->
        <Button
          v-if="checkinableCount > 0"
          variant="secondary"
          size="sm"
          :loading="busyId === 'checkin-all'"
          :disabled="Boolean(busyId) && busyId !== 'checkin-all'"
          @click="runCheckinAll"
        >
          <Icon name="check" />
          一键签到
        </Button>
        <Button variant="primary" size="sm" @click="importVisible = true">
          <Icon name="plus" />
          导入账号
        </Button>
        </template>
      </Toolbar>

    <div class="accounts__body">
      <div v-if="accounts.length === 0" class="accounts__empty">
        <EmptyState
          icon="inbox"
          :title="`${filterLabel} 下还没有账号`"
          description="支持粘贴 accessToken、email:token 逐行文本，或客户端导出的 JSON。"
        />
      </div>

      <ul v-else class="accounts__grid">
        <li
          v-for="account in accounts"
          :key="account.id"
          class="account-card"
          @contextmenu="openCardMenu($event, account)"
        >
          <div class="account-card__head">
            <span class="account-card__name truncate" :title="account.name">{{ account.name }}</span>
            <Tag v-if="account.current" tone="brand" effect="plain" size="sm">当前</Tag>
            <!-- 插件内选的「当前」与 IDEA 里实际登录的可能不一致，单独标出来 -->
            <Tag v-if="account.ideaCurrent" tone="success" effect="plain" size="sm">IDEA 当前</Tag>
            <!-- 多来源混排时才标来源 -->
            <Tag v-if="sources.length > 1" tone="info" effect="plain" size="sm">
              {{ sourceLabelOf(account.source) }}
            </Tag>
          </div>

          <div class="account-card__quota">
            <div class="account-card__quota-bar">
              <span
                class="account-card__quota-fill"
                :style="{ width: `${quotaPercent(account)}%` }"
              />
            </div>
            <span class="account-card__quota-text">{{ quotaText(account) }}</span>
          </div>

          <div class="account-card__meta">
            <span class="account-card__checkin truncate">{{ checkinText(account) }}</span>
            <span v-if="account.quota?.updatedAt" class="account-card__time">
              更新于 {{ formatLocalTime(account.quota.updatedAt) }}
            </span>
          </div>

          <div class="account-card__actions">
            <!-- 没有登录态写入方案的来源不显示齿轮 -->
            <Button
              v-if="supportsOf(account, 'targets')"
              variant="ghost"
              size="sm"
              class="account-card__targets"
              :class="{ 'is-on': (account.targets?.length ?? 0) > 0 }"
              :title="
                (account.targets?.length ?? 0) > 0
                  ? `已选 ${account.targets?.length} 个登录态位置`
                  : '选择要应用的登录态位置'
              "
              @mouseenter="openTargets(account, $event)"
              @mouseleave="scheduleCloseTargets()"
              @click="openTargets(account, $event)"
            >
              <Icon name="settings" />
            </Button>
            <!-- 没有切换方案的来源不显示「设为当前」 -->
            <Button
              v-if="supportsOf(account, 'switch')"
              variant="ghost"
              size="sm"
              @click="toggleCurrent(account)"
            >
              {{ account.current ? '取消当前' : '设为当前' }}
            </Button>
            <Button
              v-for="action in actionsFor(account)"
              :key="action.id"
              variant="ghost"
              size="sm"
              :loading="busyId === account.id + ':' + action.id"
              @click="runAccountAction(action, account)"
            >
              {{ action.label }}
            </Button>
            <Button variant="ghost" size="sm" @click="removeAccount(account)">
              <Icon name="trash" />
            </Button>
          </div>
        </li>
        </ul>
      </div>
    </div>

    <Dialog v-model="importVisible" title="导入账号" :width="520">
      <div class="accounts-import">
        <div class="accounts-import__field">
          <label class="accounts-import__label">来源</label>
          <!-- 支持输入过滤的单选；来源多时可搜索 -->
          <Combobox
            v-model="importSource"
            :options="importSourceOptions"
            placeholder="搜索并选择来源"
            search-placeholder="输入来源名搜索…"
          />
        </div>

        <!-- 三种登录方式 -->
        <Tabs v-model="importMode" :items="importModes" />

        <input
          ref="fileInput"
          type="file"
          accept=".txt,.json"
          class="accounts-import__file"
          style="display: none"
          @change="importFromFile"
        >

        <div v-if="importMode === 'oauth'" class="accounts-import__panel">
          <template v-if="!loginResult">
            <p class="accounts-import__hint">
              点下面的按钮打开浏览器登录。登录成功后这里会显示账号与余量，确认无误再导入。
            </p>
            <p v-if="loginCode" class="accounts-import__hint accounts-import__code">
              浏览器里要求输入代码时填：<strong>{{ loginCode }}</strong>
            </p>
            <Button v-if="!webLoginBusy" @click="webLogin">
              <Icon name="key" />
              打开浏览器登录
            </Button>
            <Button v-else variant="secondary" @click="cancelWebLogin">
              取消登录
            </Button>
          </template>

          <div v-else class="accounts-import__login-result">
            <div class="accounts-import__login-name">{{ loginResult.name || '未命名账号' }}</div>
            <div
              v-if="loginResult.email && loginResult.email !== loginResult.name"
              class="accounts-import__login-email"
            >
              {{ loginResult.email }}
            </div>
            <div class="accounts-import__login-quota">
              余量 {{ quotaTextOf(loginResult.quota) }}
            </div>
            <Button variant="ghost" size="sm" @click="loginResult = null">
              重新登录
            </Button>
          </div>
        </div>

        <div v-else-if="importMode === 'token'" class="accounts-import__panel">
          <textarea
            v-model="importText"
            class="accounts-import__text"
            rows="7"
            placeholder="每行一个 accessToken，或 email:token；也可以直接粘贴客户端导出的 JSON"
          />
          <div class="accounts-import__file-row">
            <Button variant="secondary" size="sm" @click="fileInput?.click()">
              从文件读取
            </Button>
            <span class="accounts-import__hint">只填进上面的输入框，不会上传</span>
          </div>
        </div>

        <div v-else class="accounts-import__panel">
          <p class="accounts-import__hint">
            自动扫描本机各渠道的登录态并按账号去重，扫到就能直接导入。
          </p>
          <Button variant="secondary" :loading="scanBusy" @click="scanLocalAuth">
            <Icon name="search" />
            扫描本地登录态
          </Button>

          <div v-if="scanned.length" class="accounts-import__scanned">
            <label class="accounts-import__scanned-all">
              <input
                type="checkbox"
                class="sr-only"
                :checked="scannedSelectedCount === scanned.length"
                @change="onToggleAllScanned"
              >
              <CheckMark :checked="scannedSelectedCount === scanned.length" />
              <span>全选（{{ scannedSelectedCount }}/{{ scanned.length }}）</span>
            </label>
            <label
              v-for="item in scanned"
              :key="item.token"
              class="accounts-import__scanned-item"
            >
              <input
                type="checkbox"
                class="sr-only"
                :checked="scannedSelected.indexOf(item.token) >= 0"
                @change="toggleScanned(item.token)"
              >
              <CheckMark :checked="scannedSelected.indexOf(item.token) >= 0" />
              <span class="accounts-import__scanned-name truncate">{{ item.name || item.channel }}</span>
              <span class="accounts-import__scanned-channel">{{ item.channel }}</span>
            </label>
            <Button size="sm" :disabled="scannedSelectedCount === 0" @click="importScanned">
              导入选中的 {{ scannedSelectedCount }} 个账号
            </Button>
          </div>

          <p v-if="scanPending.length" class="accounts-import__hint">
            暂不支持自动扫描：{{ scanPending.join('、') }}（登录态在 SQLite 库里）
          </p>
        </div>
      </div>

      <template #footer>
        <div class="accounts-import__actions">
          <Button variant="ghost" @click="importVisible = false">
            取消
          </Button>
          <!-- 登录态导入用面板内自带的按钮，这里只在网页登录 / 粘贴 Token 下出现 -->
          <Button
            v-if="importMode !== 'file'"
            :loading="importing"
            :disabled="!canImport"
            @click="importMode === 'oauth' ? importLoginResult() : importAccounts()"
          >
            导入
          </Button>
        </div>
      </template>
    </Dialog>

    <!-- 登录态位置气泡：贴在卡片的设置按钮下方，勾选即生效 -->
    <Teleport to="body">
      <div
        v-if="targetsVisible"
        ref="targetsPanel"
        class="accounts-targets-pop"
        @mouseenter="cancelCloseTargets()"
        @mouseleave="scheduleCloseTargets()"
        :style="{
          left: `${targetsPos.left}px`,
          top: `${targetsPos.top}px`,
          width: `${TARGETS_PANEL_WIDTH}px`,
          zIndex: targetsZ,
        }"
      >
        <div class="accounts-targets-pop__head">
          <span class="accounts-targets-pop__title">应用到的登录态位置</span>
          <span v-if="targetsSaving" class="accounts-targets-pop__saving">保存中…</span>
        </div>

        <div v-if="targetsScanBusy" class="accounts-targets-pop__hint">
          正在扫描本地登录态…
        </div>

        <div v-else-if="targetOptions.length === 0" class="accounts-targets-pop__hint">
          没有扫描到可写入的登录态位置。
        </div>

        <!-- 扫到了别的位置、但这台机器上没有当前产品的 -->
        <div v-else-if="visibleTargetOptions.length === 0" class="accounts-targets-pop__hint">
          这台机器上没有 {{ sourceLabelOf(targetsAccount?.source ?? '') }} 的登录态位置。
          先在对应客户端里登录一次，再回来刷新。
        </div>

        <ul v-else class="accounts-targets-pop__list">
          <li v-for="item in visibleTargetOptions" :key="targetIdOf(item)">
            <!-- 整行可点：label 包住隐藏 input，不用对准那个小方块 -->
            <label
              class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5
                transition-colors hover:bg-hover"
            >
              <input
                type="checkbox"
                class="sr-only"
                :checked="targetChoice.includes(targetIdOf(item))"
                @change="toggleTarget(item)"
              >
              <CheckMark :checked="targetChoice.includes(targetIdOf(item))" />
              <span class="accounts-targets-pop__channel truncate">{{ item.channel || 'IntelliJ 系 IDE' }}</span>
            </label>
          </li>
        </ul>
      </div>
    </Teleport>

    <ContextMenu
      v-model:visible="cardMenuVisible"
      :x="cardMenuX"
      :y="cardMenuY"
      :items="CARD_MENU_ITEMS"
      @select="handleCardMenu"
    />
  </div>
</template>

<style scoped>
.accounts {
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

/* 左侧来源菜单：搜索与列表由宿主的 CheckList 组件提供，这里只管外框 */
.accounts__side {
  display: flex;
  flex: 0 0 200px;
  flex-direction: column;
  padding: 12px 10px;
  overflow: hidden;
  border-right: 1px solid var(--color-border);
}

/* 右侧主区：工具栏 + 卡片 */
.accounts__main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.accounts__sources {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.accounts__source {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-text);
  font-size: var(--app-font-size-sm);
  cursor: pointer;
}

.accounts__source:hover {
  background: var(--color-hover);
}

.accounts__source.is-active {
  border-color: var(--color-brand);
  background: var(--color-active);
  color: var(--color-brand);
}

.accounts__source-count {
  color: var(--color-muted);
  font-size: var(--app-font-size-2xs);
  font-variant-numeric: tabular-nums;
}

.accounts__body {
  flex: 1;
  min-height: 0;
  padding: 14px 18px 18px;
  overflow-y: auto;
}

.accounts__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.accounts__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.account-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

/* 来源多选：限宽，避免挤占右侧按钮 */
.account-card__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

/* 省略号由 Tailwind 的 truncate 负责 */
.account-card__name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
}

.account-card__quota {
  display: flex;
  align-items: center;
  gap: 8px;
}

.account-card__quota-bar {
  flex: 1;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-muted) 25%, transparent);
}

.account-card__quota-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--color-brand);
}

.account-card__quota-text {
  color: var(--color-muted);
  font-size: var(--app-font-size-xs);
  font-variant-numeric: tabular-nums;
}

.account-card__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--color-muted);
  font-size: var(--app-font-size-2xs);
}

.account-card__checkin {
  min-width: 0;
}

.account-card__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  padding-top: 2px;
  border-top: 1px dashed var(--color-border);
}

.accounts-import {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.accounts-import__select {
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--surface-color);
  color: var(--text-color);
  font-size: 13px;
  outline: none;
}

.accounts-import__select:focus {
  border-color: var(--brand-color);
}

.accounts-import__scanned {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
}

/* 全选行与逐条都整行可点：外层 label + sr-only input + CheckMark，
   不要再套一层 Checkbox 组件（嵌套 label 会让点击失效） */
.accounts-import__scanned-all {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 2px;
  color: var(--color-muted);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.accounts-import__scanned-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.accounts-import__scanned-name {
  flex: 1;
  min-width: 0;
  font-weight: 500;
}

.accounts-import__scanned-channel {
  color: var(--color-muted);
  font-size: var(--app-font-size-2xs);
  white-space: nowrap;
}

.accounts-import__login-result {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--surface-color);
}

.accounts-import__login-name {
  font-size: 14px;
  font-weight: 600;
}

.accounts-import__login-email,
.accounts-import__login-quota {
  color: var(--color-muted);
  font-size: var(--app-font-size-2xs);
}

.accounts-import__panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}

.accounts-import__file-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.accounts-import__source {
  width: 100%;
}

.accounts-import__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.accounts-import__label {
  color: var(--color-muted);
  font-size: var(--app-font-size-sm);
}

.accounts-import__sources {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.accounts-import__text {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-surface);
  color: var(--color-text);
  font-family: var(--font-mono, monospace);
  font-size: var(--app-font-size-sm);
  line-height: 1.5;
  resize: vertical;
  outline: none;
}

.accounts-import__text:focus {
  border-color: var(--color-brand);
}

.accounts-import__footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.accounts-import__file {
  max-width: 16rem;
  color: var(--color-muted);
  font-size: var(--app-font-size-xs);
}

.accounts-import__hint {
  color: var(--color-muted);
  font-size: var(--app-font-size-2xs);
}

/* 设备码：需要用户照着输进浏览器，等宽字体更好认 */
.accounts-import__code strong {
  font-family: var(--font-mono, monospace);
  letter-spacing: 0.04em;
  color: var(--color-text);
}

.accounts-import__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
/* 位置选择入口：已绑定位置时高亮，一眼看出这个账号配置过 */
.account-card__targets.is-on {
  color: var(--color-brand, #4f46e5);
}

/* 登录态位置气泡：贴按钮定位的轻量浮层 */
.accounts-targets-pop {
  position: fixed;
  padding: 10px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--overlay-bg);
  box-shadow: var(--shadow-md);
}

.accounts-targets-pop__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 2px 8px;
}

.accounts-targets-pop__title {
  font-size: var(--app-font-size-sm, 13px);
  font-weight: 600;
}

.accounts-targets-pop__saving {
  color: var(--color-muted);
  font-size: var(--app-font-size-2xs);
}

.accounts-targets-pop__hint {
  padding: 10px 2px;
  color: var(--color-muted);
  font-size: var(--app-font-size-2xs);
  line-height: 1.5;
}

.accounts-targets-pop__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 224px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

/* 行的 hover、圆角、内边距都在 label 上（Tailwind class），li 只做滚动容器的一行 */

.accounts-targets-pop__channel {
  min-width: 0;
  font-size: var(--app-font-size-sm, 13px);
}
</style>
