<script setup lang="ts">
/** Agent 账号面板：按来源展示账号，并触发动作与导入。 */
import { computed, onMounted, ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import Combobox from '@/components/ui/Combobox.vue'
import Dialog from '@/components/ui/Dialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Icon from '@/components/ui/Icon.vue'
import MultiSelect from '@/components/ui/MultiSelect.vue'
import Tabs from '@/components/ui/Tabs.vue'
import Tag from '@/components/ui/Tag.vue'
import { askConfirm } from '@/utils/confirm'
import { notify } from '@/utils/notify'
import { invoke, openExternal } from './bridge'

interface SourceConfig {
  id: string
  label: string
  api: string
  capabilities: { usage?: boolean, checkin?: boolean }
}

interface Quota {
  remain: number
  total: number
  cycleEnd: string
  packages: number
  updatedAt: string
}

interface AccountView {
  id: string
  source: string
  name: string
  addedAt: string
  updatedAt: string
  quota: Quota | null
  checkin: { state?: string, message?: string, lastAt?: string, streak?: number } | null
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

/** 账号卡片上的动作（签到无需先设为当前账号） */
function actionsFor(_account: AccountView): ActionConfig[] {
  return accountActions.value
}

/** 一键签到：来源级动作，跟随来源过滤 */
const checkinAllActions = computed(() => {
  const list = state.value?.actions ?? []
  return list.filter(
    item => item.scope === 'source' && item.sources.some(id => sourceMatch(id)),
  )
})

/** 一键签到按钮分组：每个有账号的可见来源一个按钮 */
const checkinGroups = computed(() => {
  const action = checkinAllActions.value.find(item => item.id === 'checkin-all')
  if (!action) {
    return []
  }
  return sources.value
    .filter(item => sourceMatch(item.id) && action.sources.indexOf(item.id) >= 0)
    .filter(item => countOf(item.id) > 0)
    .map(item => ({ sourceId: item.id, label: item.label }))
})
const sourceOptions = computed(() =>
  sources.value.map(item => ({
    label: `${item.label}（${countOf(item.id)}）`,
    value: item.id,
  })))
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
const IMPORT_MODES = [
  { value: 'oauth', label: '网页登录' },
  { value: 'token', label: '粘贴 Token' },
  { value: 'file', label: '登录态导入' },
]
const importMode = ref('oauth')

const webLoginBusy = ref(false)

/** 网页登录：打开授权页并轮询取回 token，填入导入框 */
async function webLogin(): Promise<void> {
  if (!importSource.value) {
    notify.warning('请先选择来源')
    return
  }

  webLoginBusy.value = true
  try {
    const start = await invoke<{
      authUrl: string
      expiresIn: number
      intervalMs: number
    }>('oauthStart', { source: importSource.value })

    openExternal(start.authUrl)
    notify.info('已在浏览器打开登录页，登录完成后会自动填回 token')

    const interval = start.intervalMs > 0 ? start.intervalMs : 1500
    const deadline = Date.now() + start.expiresIn * 1000
    while (Date.now() < deadline) {
      // 轮询由前端驱动，后端每次只回一个结果
      await new Promise(resolve => setTimeout(resolve, interval))
      const result = await invoke<{ done: boolean, token?: string, email?: string }>('oauthPoll')
      if (!result.done || !result.token) {
        continue
      }
      importText.value = result.email ? `${result.email}:${result.token}` : result.token
      // 切到 token 页签展示取回结果
      importMode.value = 'token'
      notify.success('token 已取回，点「导入」即可添加')
      return
    }
    notify.warning('登录超时，请重新发起')
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    webLoginBusy.value = false
  }
}

const scanBusy = ref(false)
const scanned = ref<Array<{ token: string, channel: string, file: string }>>([])
/** 尚不支持自动扫描的渠道 */
const scanPending = ref<string[]>([])

/** 扫描本机各渠道的登录态 */
async function scanLocalAuth(): Promise<void> {
  scanBusy.value = true
  try {
    const result = await invoke<{
      accounts: Array<{ token: string, channel: string, file: string }>
      pending: string[]
    }>('scanLocalAuth')
    scanned.value = result.accounts ?? []
    scanPending.value = result.pending ?? []
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

/** 把扫到的账号一次性导入 */
async function importScanned(): Promise<void> {
  if (!scanned.value.length) {
    return
  }
  importText.value = scanned.value.map(item => item.token).join('\n')
  await importAccounts()
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

async function toggleCurrent(account: AccountView): Promise<void> {
  try {
    const next = await invoke<Snapshot>('setCurrent', { id: account.id, source: account.source })
    applyState(next)
    notify.success(account.current ? '已取消当前账号' : `已切换到 ${account.name}`)
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

/** 一键签到：按来源给该来源下所有账号签到，并汇总结果 */
async function runCheckinAll(sourceId: string): Promise<void> {
  const busyKey = 'checkin-all:' + sourceId
  busyId.value = busyKey
  try {
    const result = await invoke<{
      results: Array<{ id: string, ok: boolean, error?: string, message?: string, already?: boolean }>
      state: Snapshot
    }>('runAction', { action: 'checkin-all', source: sourceId })
    applyState(result.state)

    const label = sourceLabelOf(sourceId)
    const done = result.results.filter(item => item.ok && !item.already).length
    const skipped = result.results.filter(item => item.ok && item.already).length
    const failed = result.results.filter(item => !item.ok)

    if (failed.length === 0) {
      if (done === 0) {
        notify.info(`${label}：没有可签到的账号（${skipped} 个今天已签过）`)
      }
      else {
        const parts = [`新签到 ${done} 个`]
        if (skipped > 0) {
          parts.push(`${skipped} 个今天已签过`)
        }
        notify.success(`${label}：${parts.join('，')}`)
      }
    }
    else {
      notify.warning(
        `${label}：新签 ${done} 个，已签 ${skipped} 个，失败 ${failed.length} 个。${failed[0].error ?? ''}`,
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

function quotaText(account: AccountView): string {  if (!account.quota) {
    return '未查询余量'
  }
  return `${account.quota.remain} / ${account.quota.total}`
}

function quotaPercent(account: AccountView): number {
  if (!account.quota || account.quota.total <= 0) {
    return 0
  }
  return Math.max(0, Math.min(100, Math.round((account.quota.remain / account.quota.total) * 100)))
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
    <header class="accounts__head">
      <!-- 来源可多选过滤：默认全选，取消勾选即隐藏该来源账号 -->
      <MultiSelect
        v-model="activeSources"
        :options="sourceOptions"
        placeholder="来源"
        class="accounts__filter"
      />

      <div class="accounts__head-actions">
        <!-- 一键签到：每个来源一个按钮，仅该来源有账号时显示 -->
        <Button
          v-for="group in checkinGroups"
          :key="'checkin-all:' + group.sourceId"
          variant="secondary"
          size="sm"
          :loading="busyId === 'checkin-all:' + group.sourceId"
          :disabled="Boolean(busyId) && busyId !== 'checkin-all:' + group.sourceId"
          @click="runCheckinAll(group.sourceId)"
        >
          <Icon name="check" />
          一键签到{{ checkinGroups.length > 1 ? `·${group.label}` : '' }}
        </Button>
        <Button variant="primary" size="sm" @click="importVisible = true">
          <Icon name="plus" />
          导入账号
        </Button>
      </div>
    </header>

    <div class="accounts__body">
      <div v-if="accounts.length === 0" class="accounts__empty">
        <EmptyState
          icon="inbox"
          :title="`${filterLabel} 下还没有账号`"
          description="支持粘贴 accessToken、email:token 逐行文本，或客户端导出的 JSON。"
        />
      </div>

      <ul v-else class="accounts__grid">
        <li v-for="account in accounts" :key="account.id" class="account-card">
          <div class="account-card__head">
            <span class="account-card__name" :title="account.name">{{ account.name }}</span>
            <Tag v-if="account.current" tone="brand" effect="plain" size="sm">当前</Tag>
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
            <span class="account-card__checkin">{{ checkinText(account) }}</span>
            <span v-if="account.quota?.updatedAt" class="account-card__time">
              更新于 {{ account.quota.updatedAt.slice(11, 16) }}
            </span>
          </div>

          <div class="account-card__actions">
            <Button variant="ghost" size="sm" @click="toggleCurrent(account)">
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

    <Dialog v-model="importVisible" title="导入账号" :width="520">
      <div class="accounts-import">
        <div class="accounts-import__field">
          <label class="accounts-import__label">来源</label>
          <!-- 弹窗内浮层易被裁剪，这里用原生 select -->
          <select v-model="importSource" class="accounts-import__select">
            <option v-for="source in sources" :key="source.id" :value="source.id">
              {{ source.label }}
            </option>
          </select>
        </div>

        <!-- 三种登录方式 -->
        <Tabs v-model="importMode" :items="IMPORT_MODES" />

        <input
          ref="fileInput"
          type="file"
          accept=".txt,.json"
          class="accounts-import__file"
          style="display: none"
          @change="importFromFile"
        >

        <div v-if="importMode === 'oauth'" class="accounts-import__panel">
          <p class="accounts-import__hint">
            点下面的按钮打开浏览器登录；完成后 token 会自动填到「粘贴 Token」页签。
          </p>
          <Button :loading="webLoginBusy" @click="webLogin">
            <Icon name="key" />
            打开浏览器登录
          </Button>
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
            <div
              v-for="item in scanned"
              :key="item.token"
              class="accounts-import__scanned-item"
            >
              <span>{{ item.channel }}</span>
              <code>…{{ item.token.slice(-8) }}</code>
            </div>
            <Button size="sm" @click="importScanned">
              导入这 {{ scanned.length }} 个账号
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
          <Button :loading="importing" @click="importAccounts">
            导入
          </Button>
        </div>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.accounts {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.accounts__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 18px;
  border-bottom: 1px solid var(--color-border);
}

.accounts__sources,
.accounts__head-actions {
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
.accounts__filter {
  width: 14rem;
  flex: 0 0 auto;
}

.account-card__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.account-card__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.accounts-import__scanned-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}

.accounts-import__scanned-item code {
  color: var(--text-muted);
  font-family: var(--font-mono);
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

.accounts-import__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
