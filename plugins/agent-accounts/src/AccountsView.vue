<script setup lang="ts">
/**
 * Agent 账号面板。
 *
 * 账号数据、余量查询、签到都在插件后端（backend/index.js），
 * 这里只负责按来源分栏展示、触发动作与导入。
 */
import { computed, onMounted, ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import Dialog from '@/components/ui/Dialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Icon from '@/components/ui/Icon.vue'
import Tag from '@/components/ui/Tag.vue'
import { askConfirm } from '@/utils/confirm'
import { notify } from '@/utils/notify'
import { invoke } from './bridge'

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
}

interface Snapshot {
  sources: SourceConfig[]
  actions: ActionConfig[]
  accounts: AccountView[]
  current: Record<string, string>
}

const state = ref<Snapshot | null>(null)
const activeSource = ref('')
const busyId = ref('')
const sourceBusy = ref(false)

const importVisible = ref(false)
const importSource = ref('')
const importText = ref('')
const importing = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const sources = computed(() => state.value?.sources ?? [])
const activeSourceLabel = computed(
  () => sources.value.find(item => item.id === activeSource.value)?.label ?? '账号',
)
const accounts = computed(() => {
  const list = state.value?.accounts ?? []
  return list.filter(item => item.source === activeSource.value)
})
const accountActions = computed(() => {
  const list = state.value?.actions ?? []
  return list.filter(item => item.scope === 'account' && item.sources.indexOf(activeSource.value) >= 0)
})
const sourceActions = computed(() => {
  const list = state.value?.actions ?? []
  return list.filter(item => item.scope === 'source' && item.sources.indexOf(activeSource.value) >= 0)
})

function countOf(sourceId: string): number {
  return (state.value?.accounts ?? []).filter(item => item.source === sourceId).length
}

function applyState(next: Snapshot): void {
  state.value = next
  if (!activeSource.value && next.sources.length > 0) {
    activeSource.value = next.sources[0].id
  }
  if (!importSource.value && next.sources.length > 0) {
    importSource.value = next.sources[0].id
  }
}

async function refresh(): Promise<void> {
  const next = await invoke<Snapshot>('state')
  applyState(next)
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
    activeSource.value = importSource.value
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

/** 从文本文件读入导入内容（浏览器 File API，不需要插件有文件权限） */
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
      results: Array<{ id: string, ok: boolean, error?: string, message?: string, quota?: Quota }>
      state: Snapshot
    }>('runAction', { action: action.id, source: account.source, ids: [account.id] })
    applyState(result.state)
    const item = result.results[0]
    if (item && !item.ok) {
      notify.error(item.error || '操作失败')
    }
    else if (action.id === 'checkin') {
      notify.success(item?.message || '签到完成')
    }
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    busyId.value = ''
  }
}

/** 来源级动作（一键签到） */
async function runSourceAction(action: ActionConfig): Promise<void> {
  if (accounts.value.length === 0) {
    notify.warning('该来源下还没有账号')
    return
  }
  sourceBusy.value = true
  try {
    const result = await invoke<{
      results: Array<{ id: string, ok: boolean, error?: string, message?: string }>
      state: Snapshot
    }>('runAction', { action: action.id, source: activeSource.value })
    applyState(result.state)
    const failed = result.results.filter(item => !item.ok)
    if (failed.length === 0) {
      notify.success(`${action.label}完成：${result.results.length} 个账号`)
    }
    else {
      notify.error(`${action.label}：${failed.length} 个账号失败，${failed[0].error ?? ''}`)
    }
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    sourceBusy.value = false
  }
}

function quotaText(account: AccountView): string {
  if (!account.quota) {
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
      <div class="accounts__sources">
        <button
          v-for="source in sources"
          :key="source.id"
          type="button"
          class="accounts__source"
          :class="{ 'is-active': source.id === activeSource }"
          @click="activeSource = source.id"
        >
          {{ source.label }}
          <span class="accounts__source-count">{{ countOf(source.id) }}</span>
        </button>
      </div>

      <div class="accounts__head-actions">
        <Button
          v-for="action in sourceActions"
          :key="action.id"
          variant="secondary"
          size="sm"
          :loading="sourceBusy"
          @click="runSourceAction(action)"
        >
          <Icon name="check" />
          {{ action.label }}
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
          :title="`${activeSourceLabel} 下还没有账号`"
          description="支持粘贴 accessToken、email:token 逐行文本，或客户端导出的 JSON。"
        />
      </div>

      <ul v-else class="accounts__grid">
        <li v-for="account in accounts" :key="account.id" class="account-card">
          <div class="account-card__head">
            <span class="account-card__name" :title="account.name">{{ account.name }}</span>
            <Tag v-if="account.current" tone="brand" effect="plain" size="sm">当前</Tag>
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
              v-for="action in accountActions"
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
          <div class="accounts-import__sources">
            <button
              v-for="source in sources"
              :key="source.id"
              type="button"
              class="accounts__source"
              :class="{ 'is-active': source.id === importSource }"
              @click="importSource = source.id"
            >
              {{ source.label }}
            </button>
          </div>
        </div>

        <div class="accounts-import__field">
          <label class="accounts-import__label">账号内容</label>
          <textarea
            v-model="importText"
            class="accounts-import__text"
            rows="8"
            placeholder="每行一个 accessToken，或 email:token；也可以直接粘贴客户端导出的 JSON"
          />
        </div>

        <div class="accounts-import__footer">
          <input
            ref="fileInput"
            type="file"
            accept=".txt,.json"
            class="accounts-import__file"
            @change="importFromFile"
          >
          <span class="accounts-import__hint">
            从文件读取只会填进上面的输入框，不会上传。
          </span>
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
  border-bottom: 1px solid var(--border-color);
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
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: transparent;
  color: var(--text-color);
  font-size: var(--app-font-size-sm);
  cursor: pointer;
}

.accounts__source:hover {
  background: var(--hover-bg);
}

.accounts__source.is-active {
  border-color: var(--brand-color);
  background: var(--active-bg);
  color: var(--brand-color);
}

.accounts__source-count {
  color: var(--text-muted);
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
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.account-card__head {
  display: flex;
  align-items: center;
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
  background: color-mix(in srgb, var(--text-muted) 25%, transparent);
}

.account-card__quota-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--brand-color);
}

.account-card__quota-text {
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
  font-variant-numeric: tabular-nums;
}

.account-card__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--text-muted);
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
  border-top: 1px dashed var(--border-color);
}

.accounts-import {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.accounts-import__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.accounts-import__label {
  color: var(--text-muted);
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
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--surface-color);
  color: var(--text-color);
  font-family: var(--editor-font, monospace);
  font-size: var(--app-font-size-sm);
  line-height: 1.5;
  resize: vertical;
  outline: none;
}

.accounts-import__text:focus {
  border-color: var(--brand-color);
}

.accounts-import__footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.accounts-import__file {
  max-width: 16rem;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}

.accounts-import__hint {
  color: var(--text-muted);
  font-size: var(--app-font-size-2xs);
}

.accounts-import__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
