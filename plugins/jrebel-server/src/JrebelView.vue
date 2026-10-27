<script setup lang="ts">
/**
 * JRebel 激活服务面板。
 *
 * 服务器本身跑在插件后端（toolbox.server，只绑 127.0.0.1），
 * 这里只负责：启停、改参数、看日志、复制激活地址与邮箱。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import Field from '@/components/ui/Field.vue'
import Icon from '@/components/ui/Icon.vue'
import Input from '@/components/ui/Input.vue'
import NumberInput from '@/components/ui/NumberInput.vue'
import Switch from '@/components/ui/Switch.vue'
import Tag from '@/components/ui/Tag.vue'
import { copyText } from '@/utils/clipboard'
import { notify } from '@/utils/notify'
import { invoke } from './bridge'

interface ServerConfig {
  port: number
  autoStart: boolean
  offlineDays: number
  email: string
}

interface ServerSnapshot {
  running: boolean
  port: number
  config: ServerConfig
  uuid: string
  activationUrl: string
}

interface LogEntry {
  id: number
  at: string
  method: string
  path: string
  status: number
  durationMs: number
  error?: string
}

const snapshot = ref<ServerSnapshot | null>(null)
const logs = ref<LogEntry[]>([])
const busy = ref(false)
const port = ref(12345)
const offlineDays = ref(30)
const autoStart = ref(true)

/** 轮询句柄 */
let timer: number | null = null
/** 已拉取到的最后一条日志 id */
let lastLogId = 0

const running = computed(() => snapshot.value?.running === true)
const activationUrl = computed(() => snapshot.value?.activationUrl ?? '')
const email = computed(() => snapshot.value?.config.email ?? '')
const uuid = computed(() => snapshot.value?.uuid ?? '')

function applySnapshot(next: ServerSnapshot): void {
  snapshot.value = next
  port.value = next.config.port
  offlineDays.value = next.config.offlineDays
  autoStart.value = next.config.autoStart
}

async function refresh(): Promise<void> {
  const next = await invoke<ServerSnapshot>('status')
  applySnapshot(next)
  if (next.running) {
    const fresh = await invoke<LogEntry[]>('logs', { since: lastLogId })
    if (fresh.length > 0) {
      lastLogId = fresh[fresh.length - 1].id
      // 新的排前面，最多保留 200 条
      logs.value = [...fresh.slice().reverse(), ...logs.value].slice(0, 200)
    }
  }
}

async function toggleServer(): Promise<void> {
  busy.value = true
  try {
    if (running.value) {
      await invoke('stop')
      notify.success('已停止 JRebel 激活服务')
    }
    else {
      const result = await invoke<{ ok: boolean, port?: number, error?: string }>('start')
      if (!result.ok) {
        notify.error(result.error || '启动失败')
      }
      else {
        notify.success(`JRebel 激活服务已启动，端口 ${result.port}`)
      }
    }
    await refresh()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    busy.value = false
  }
}

async function saveSettings(): Promise<void> {
  busy.value = true
  try {
    const next = await invoke<ServerSnapshot>('save', {
      port: port.value,
      offlineDays: offlineDays.value,
      autoStart: autoStart.value,
    })
    applySnapshot(next)
    notify.success('参数已保存')
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    busy.value = false
  }
}

async function copy(value: string, label: string): Promise<void> {
  try {
    await copyText(value)
    notify.success(`${label}已复制`)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

async function regenerateEmail(): Promise<void> {
  const result = await invoke<{ email: string }>('regenerateEmail')
  if (snapshot.value) {
    snapshot.value.config.email = result.email
  }
}

async function regenerateUuid(): Promise<void> {
  const result = await invoke<{ uid?: string, uuid: string, activationUrl: string }>('regenerateUuid')
  if (snapshot.value) {
    snapshot.value.uuid = result.uuid
    snapshot.value.activationUrl = result.activationUrl
  }
  notify.success('已重新生成激活地址')
}

function clearLogs(): void {
  logs.value = []
}

function timeOf(at: string): string {
  const index = at.indexOf('T')
  return index >= 0 ? at.slice(index + 1, index + 9) : at
}

onMounted(async () => {
  try {
    await refresh()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  // 日志实时看：轮询不去打扰后端 handler，只读本地服务的日志缓冲
  timer = window.setInterval(() => {
    void refresh().catch(() => {})
  }, 1200)
})

onBeforeUnmount(() => {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
})
</script>

<template>
  <div class="jrebel">
    <header class="jrebel__head">
      <div class="jrebel__title">
        <Icon name="key" />
        <span>JRebel 激活服务</span>
        <Tag :tone="running ? 'success' : 'info'" effect="plain" size="sm">
          {{ running ? `运行中 · ${snapshot?.port}` : '未启动' }}
        </Tag>
      </div>
      <div class="jrebel__head-actions">
        <Button
          :variant="running ? 'secondary' : 'primary'"
          size="sm"
          :loading="busy"
          @click="toggleServer"
        >
          <Icon :name="running ? 'pause' : 'play'" />
          {{ running ? '停止服务' : '启动服务' }}
        </Button>
      </div>
    </header>

    <div class="jrebel__body">
      <section class="jrebel__panel">
        <h3 class="jrebel__panel-title">
          激活信息
        </h3>

        <Field label="激活地址">
          <div class="jrebel__row">
            <Input :model-value="activationUrl" readonly size="sm" class="jrebel__grow" />
            <Button variant="ghost" size="sm" title="复制激活地址" @click="copy(activationUrl, '激活地址')">
              <Icon name="document" />
              复制
            </Button>
          </div>
        </Field>

        <Field label="邮箱">
          <div class="jrebel__row">
            <Input :model-value="email" readonly size="sm" class="jrebel__grow" />
            <Button variant="ghost" size="sm" title="随机生成邮箱" @click="regenerateEmail">
              <Icon name="refresh" />
              随机
            </Button>
            <Button variant="ghost" size="sm" title="复制邮箱" @click="copy(email, '邮箱')">
              <Icon name="document" />
              复制
            </Button>
          </div>
        </Field>

        <Field label="UUID">
          <div class="jrebel__row">
            <Input :model-value="uuid" readonly size="sm" class="jrebel__grow" />
            <Button variant="ghost" size="sm" title="重新生成激活地址" @click="regenerateUuid">
              <Icon name="refresh" />
              重置
            </Button>
          </div>
        </Field>

        <p class="jrebel__hint">
          在 JRebel 里选择「激活 → 连接在线授权服务」，地址填上面的激活地址，邮箱随意填。
        </p>
      </section>

      <section class="jrebel__panel">
        <h3 class="jrebel__panel-title">
          服务器参数
        </h3>

        <Field label="端口">
          <NumberInput v-model="port" :min="1024" :max="65535" size="sm" class="jrebel__port" />
        </Field>

        <Field label="离线授权天数">
          <NumberInput v-model="offlineDays" :min="1" :max="180" size="sm" class="jrebel__port" />
        </Field>

        <Field label="随应用启动">
          <div class="jrebel__row">
            <Switch v-model="autoStart" />
            <span class="jrebel__hint is-inline">应用启动时自动拉起激活服务</span>
          </div>
        </Field>

        <div class="jrebel__row is-end">
          <Button variant="secondary" size="sm" :loading="busy" @click="saveSettings">
            保存参数
          </Button>
        </div>
      </section>

      <section class="jrebel__panel is-log">
        <div class="jrebel__log-head">
          <h3 class="jrebel__panel-title">
            请求日志
            <span class="jrebel__log-count">{{ logs.length }}</span>
          </h3>
          <Button variant="ghost" size="sm" @click="clearLogs">
            清空
          </Button>
        </div>

        <ul v-if="logs.length" class="jrebel__logs">
          <li v-for="entry in logs" :key="entry.id" class="jrebel__log" :class="{ 'is-error': entry.status >= 400 || entry.error }">
            <span class="jrebel__log-time">{{ timeOf(entry.at) }}</span>
            <span class="jrebel__log-method">{{ entry.method }}</span>
            <span class="jrebel__log-path" :title="entry.path">{{ entry.path }}</span>
            <span class="jrebel__log-status">{{ entry.status }}</span>
            <span class="jrebel__log-duration">{{ entry.durationMs }}ms</span>
          </li>
        </ul>
        <p v-else class="jrebel__empty">
          还没有请求。IDE 里点一次「激活」或刷新授权就能看到。
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.jrebel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.jrebel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border-color);
}

.jrebel__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.jrebel__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
  padding: 12px 18px 18px;
  overflow: hidden;
}

.jrebel__panel {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--panel-bg, transparent);
}

/* 日志占满第二行整宽 */
.jrebel__panel.is-log {
  grid-column: 1 / -1;
  min-height: 0;
  gap: 6px;
}

.jrebel__panel-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  font-weight: 600;
}

.jrebel__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.jrebel__row.is-end {
  justify-content: flex-end;
  margin-top: 8px;
}

.jrebel__grow {
  flex: 1;
  min-width: 0;
}

.jrebel__port {
  width: 9rem;
}

.jrebel__hint {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
  line-height: 1.6;
}

.jrebel__hint.is-inline {
  margin: 0;
}

.jrebel__log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.jrebel__log-count {
  color: var(--text-muted);
  font-size: var(--app-font-size-2xs);
}

.jrebel__logs {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.jrebel__log {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 4px;
  border-radius: 4px;
  font-size: var(--app-font-size-xs);
  font-variant-numeric: tabular-nums;
}

.jrebel__log:nth-child(even) {
  background: color-mix(in srgb, var(--hover-bg) 60%, transparent);
}

.jrebel__log.is-error {
  color: var(--danger-color);
}

.jrebel__log-time,
.jrebel__log-duration {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.jrebel__log-method {
  flex: 0 0 3.2rem;
  color: var(--text-muted);
}

.jrebel__log-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jrebel__log-status {
  flex: 0 0 2.4rem;
  text-align: right;
}

.jrebel__empty {
  margin: 8px 0;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
}
</style>
