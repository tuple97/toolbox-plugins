<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import Checkbox from '@/components/ui/Checkbox.vue'
import ColorInput from '@/components/ui/ColorInput.vue'
import Field from '@/components/ui/Field.vue'
import Icon from '@/components/ui/Icon.vue'
import Input from '@/components/ui/Input.vue'
import NumberInput from '@/components/ui/NumberInput.vue'
import Combobox from '@/components/ui/Combobox.vue'
import TabGroup from '@/components/ui/TabGroup.vue'
import Tag from '@/components/ui/Tag.vue'
import { askConfirm } from '@/utils/confirm'
import { notify } from '@/utils/notify'
import {
  fetchConnection,
  fetchConnections,
  persistConnection,
  removeConnection,
  testConnection,
} from '@/api/db'
import ConnectionMetadataDialog from '@/components/ConnectionMetadataDialog.vue'
import { Events } from '@wailsio/runtime'
import { useMetadataStore } from '@/stores/metadataStore'
import { useConfigStore } from '@/stores/configStore'
import { useTabStore } from '@/stores/tabStore'
import { matchesShortcut, shortcutOf } from '@/utils/shortcuts'
import type { ConnectionEnv, DBConnection } from '@/types'

/** 连接管理（单例标签页）：左列表 + 右详情（基本 / 高级 / SSL）；连接变更后广播 connections:changed */

const emit = defineEmits<{
  /** 首次加载完成（父级据此关闭 loading 遮罩） */
  (e: 'ready'): void
}>()
const configStore = useConfigStore()
const tabStore = useTabStore()

/** 支持的数据库类型 */
const DB_TYPES = [
  { value: 'mysql', label: 'MySQL' },
  { value: 'postgres', label: 'PostgreSQL' },
]

/** 各类型默认端口 */
const DEFAULT_PORTS: Record<string, number> = {
  mysql: 3306,
  postgres: 5432,
}

/** SSL 模式（统一取值，后端按方言映射：MySQL → tls，PostgreSQL → sslmode） */
const SSL_MODES = [
  { value: 'disable', label: 'disable（不加密）' },
  { value: 'prefer', label: 'prefer（优先加密）' },
  { value: 'require', label: 'require（必须加密，不校验证书）' },
  { value: 'verify-ca', label: 'verify-ca（校验 CA）' },
  { value: 'verify-full', label: 'verify-full（校验 CA 与主机名）' },
]

/** 各 SSL 模式的说明 */
const SSL_HINTS: Record<string, string> = {
  disable: '不加密',
  prefer: '优先加密，不支持则明文',
  require: '强制加密，不校验证书',
  'verify-ca': '校验证书签发机构，需填 CA 路径',
  'verify-full': '校验证书与主机名，需填 CA 路径',
}

/** 详情页签 */
const activeTab = ref('basic')

/** 详情页签定义（SSL 页签的「已启用」圆点走 #tab-ssl 插槽） */
const CONN_TABS = [
  { value: 'basic', label: '基本' },
  { value: 'advanced', label: '高级' },
  { value: 'ssl', label: 'SSL' },
]

/** SSL 页的说明文案 */
const sslHint = computed(() => SSL_HINTS[form.sslMode] ?? SSL_HINTS.disable)

const connections = ref<DBConnection[]>([])
const loading = ref(false)
const testing = ref(false)
const saving = ref(false)

/** 正在编辑的连接 ID（0 表示新建），同时用作列表选中态 */
const editingId = ref(0)
const form = reactive<DBConnection>(createEmptyForm())

/** 元数据缓存（与查询页补全共用同一份） */
const metadataStore = useMetadataStore()
/** 元数据查看弹窗 */
const metadataVisible = ref(false)
/** 元数据刷新中 */
const metadataRefreshing = ref(false)

/** 当前编辑的已保存连接；新建（未保存）时为 null */
const savedConnection = computed(
  () => connections.value.find(item => item.id === editingId.value) ?? null,
)

function createEmptyForm(): DBConnection {
  return {
    id: 0,
    name: '',
    dbType: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    database: '',
    username: '',
    password: '',
    extra: '',
    note: '',
    color: '',
    charset: '',
    defaultSchema: '',
    connectTimeoutSecs: 10,
    queryTimeoutSecs: 60,
    keepaliveSecs: 30,
    sslMode: 'disable',
    sslCaPath: '',
    sslCertPath: '',
    sslKeyPath: '',
    urlParams: '',
    readOnly: false,
    isLocal: false,
    isTest: false,
    isProduction: false,
  }
}

/** 加载连接列表 */
async function load() {
  loading.value = true
  try {
    connections.value = await fetchConnections()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    loading.value = false
  }
}

/** 广播连接变更，供其他标签页刷新 */
function notifyChanged() {
  void Events.Emit('connections:changed')
}

/** 当前连接的环境标识；本地 / 测试 / 生产互斥，空串表示未标记 */
const envMark = computed<ConnectionEnv>(() => {
  if (form.isProduction) {
    return 'production'
  }
  if (form.isTest) {
    return 'test'
  }
  if (form.isLocal) {
    return 'local'
  }
  return ''
})

/** 切换环境标识：勾选一个清掉其它两个，再点已勾选的取消标记 */
function toggleEnv(env: Exclude<ConnectionEnv, ''>, checked: boolean) {
  const next = checked ? env : ''
  form.isLocal = next === 'local'
  form.isTest = next === 'test'
  form.isProduction = next === 'production'
}

/** 切换数据库类型时同步默认端口 */
function handleTypeChange(type: string) {
  form.port = DEFAULT_PORTS[type] ?? form.port
}

/** 进入「新建」状态：清空表单并回到基本页 */
function startCreate() {
  Object.assign(form, createEmptyForm())
  editingId.value = 0
  activeTab.value = 'basic'
}

/** 把某个连接载入右侧详情 */
function selectConnection(conn: DBConnection) {
  // 老数据可能缺后加的列，这里补一层默认值
  Object.assign(form, {
    ...createEmptyForm(),
    ...conn,
    // 已保存的密码不回填：留空即表示不修改
    password: '',
    connectTimeoutSecs: conn.connectTimeoutSecs || 10,
    queryTimeoutSecs: conn.queryTimeoutSecs || 60,
    keepaliveSecs: conn.keepaliveSecs || 30,
    sslMode: conn.sslMode || 'disable',
  })
  editingId.value = conn.id
  activeTab.value = 'basic'
}

/** 构造提交给后端的表单副本（密码留空表示不修改，取回已存密文补上） */
async function buildPayload(): Promise<DBConnection> {
  const payload = { ...form } as DBConnection
  if (!payload.password && editingId.value) {
    payload.password = (await fetchConnection(editingId.value)).password
  }
  return payload
}

/** 查看 / 刷新元数据前的校验：必须已保存连接 */
function requireSavedConnection(): DBConnection | null {
  const conn = savedConnection.value
  if (!conn) {
    notify.warning('请先保存连接，再查看或刷新元数据')
  }
  return conn
}

/** 打开元数据查看弹窗（库 / 表 / 字段） */
function handleViewMetadata() {
  if (requireSavedConnection()) {
    metadataVisible.value = true
  }
}

/** 刷新该连接的元数据：清缓存后重新拉取库列表与当前库的表列表 */
async function handleRefreshMetadata() {
  const conn = requireSavedConnection()
  if (!conn) {
    return
  }
  metadataRefreshing.value = true
  try {
    // 库以表单里填写的为准（未填时用连接自身配置的库）
    await metadataStore.refreshConnection(conn.id, form.database || conn.database || '')
    notify.success('元数据已刷新')
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    metadataRefreshing.value = false
  }
}

/** 测试连接（未改密码时用已保存的密码） */
async function handleTest() {
  testing.value = true
  try {
    await testConnection(await buildPayload())
    notify.success('连接成功')
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    testing.value = false
  }
}

/** 保存连接 */
async function handleSave() {
  // 保存中忽略重复触发（快捷键连按 / 连点按钮）
  if (saving.value) {
    return
  }
  if (!form.name.trim()) {
    // 名称在「基本」页：校验失败先切过去，否则用户在别的页签上看不到要填什么
    activeTab.value = 'basic'
    notify.warning('请输入连接名称')
    return
  }
  saving.value = true
  try {
    const id = await persistConnection(await buildPayload())
    notify.success('保存成功')
    await load()
    // 新建成功后停在刚保存的这条上（editingId 从 0 变成新 ID）
    const saved = connections.value.find(item => item.id === id)
    if (saved) {
      selectConnection(saved)
    }
    notifyChanged()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    saving.value = false
  }
}

/** 删除连接 */
async function handleDelete(conn: DBConnection) {
  // 取消是正常分支，直接走下面的判断
  const confirmed = await askConfirm({
    message: `确定删除连接「${conn.name}」吗？其下的 SQL 模板也会一并删除。`,
    title: '删除连接',
    confirmText: '删除',
    tone: 'danger',
  })
  if (!confirmed) {
    return
  }

  try {
    await removeConnection(conn.id)
    notify.success('已删除')
    await load()
    // 删掉的正是当前编辑项时，回落到列表首项（没有就进入新建）
    if (editingId.value === conn.id) {
      const next = connections.value[0]
      if (next) {
        selectConnection(next)
      }
      else {
        startCreate()
      }
    }
    notifyChanged()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** Ctrl/Cmd + S 保存当前连接（顺手拦掉浏览器的「保存网页」） */
function handleSaveShortcut(event: KeyboardEvent) {
  // 单例页面会用 v-show 常驻；只有当前可见页面可以处理自己的快捷键。
  if (tabStore.activeSingleton !== 'connections') {
    return
  }
  if (event.defaultPrevented) {
    return
  }
  if (!matchesShortcut(event, shortcutOf('save-connection', configStore.values.shortcut_config))) {
    return
  }
  event.preventDefault()
  void handleSave()
}

onMounted(async () => {
  window.addEventListener('keydown', handleSaveShortcut)
  try {
    await load()
    // 默认展示第一条连接；没有任何连接时进入新建
    const first = connections.value[0]
    if (first) {
      selectConnection(first)
    }
    else {
      startCreate()
    }
  }
  finally {
    // 失败也要上报，否则遮罩会一直盖住界面
    emit('ready')
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleSaveShortcut)
})
</script>

<template>
  <div class="conn-workspace">
    <div class="conn-mgr">
      <!-- 左：连接列表 -->
      <aside class="conn-mgr__list">
        <div class="conn-mgr__list-head">
          <span>连接列表</span>
          <Button size="sm" @click="startCreate">
            <Icon name="plus" />
            <span>新建</span>
          </Button>
        </div>

        <ul class="conn-mgr__items">
          <li
            v-for="item in connections"
            :key="item.id"
            class="conn-mgr__item"
            :class="{ 'is-active': item.id === editingId }"
            :title="item.note || item.name"
            @click="selectConnection(item)"
          >
            <div class="conn-mgr__item-main">
              <span class="conn-mgr__item-name">
                <span v-if="item.color" class="conn-mgr__dot" :style="{ background: item.color }" />
                <span class="conn-mgr__item-text">{{ item.name }}</span>
                <Tag v-if="item.isLocal" size="sm" tone="success" effect="plain">本地</Tag>
                <Tag v-if="item.isTest" size="sm" tone="warning" effect="plain">测试</Tag>
                <Tag v-if="item.isProduction" size="sm" tone="danger" effect="plain">生产</Tag>
                <Tag v-if="item.readOnly" size="sm" tone="info" effect="plain">只读</Tag>
              </span>
              <span class="conn-mgr__item-addr">
                {{ item.dbType }} · {{ item.host }}:{{ item.port }}/{{ item.database }}
              </span>
            </div>
            <Icon
              name="trash"
              class="conn-mgr__item-del"
              title="删除"
              @click.stop="handleDelete(item)"
            />
          </li>

          <li v-if="!connections.length" class="conn-mgr__empty">
            暂无连接，点击新建创建
          </li>
        </ul>
      </aside>

      <!-- 右：所选连接的详情 -->
      <section class="conn-mgr__editor">
        <header class="conn-mgr__editor-head">
          <span class="conn-mgr__editor-title">
            {{ editingId ? '编辑连接' : '新建连接' }}
          </span>

          <div class="conn-mgr__editor-actions">
            <!-- 元数据：查看 / 刷新 -->
            <Button
              variant="secondary"
              size="icon"
              :disabled="!editingId"
              title="查看元数据（库 / 表 / 字段）"
              @click="handleViewMetadata"
            >
              <Icon name="search" />
            </Button>
            <Button
              variant="secondary"
              size="icon"
              :disabled="!editingId"
              :loading="metadataRefreshing"
              title="刷新元数据"
              @click="handleRefreshMetadata"
            >
              <Icon name="refresh" />
            </Button>

            <Button variant="secondary" :loading="testing" @click="handleTest">测试连接</Button>
            <Button :loading="saving" title="保存（Ctrl+S）" @click="handleSave">
              保存
            </Button>
          </div>
        </header>

        <div class="conn-mgr__form">
          <TabGroup v-model="activeTab" :items="CONN_TABS" class="conn-mgr__tabs">
            <!-- 基本：连接地址与账号 -->
            <template #panel-basic>
              <Field label="名称" required label-width="100px">
                <Input v-model="form.name" placeholder="如：生产库" />
              </Field>

              <Field label="类型" required label-width="100px">
                <Combobox
                  v-model="form.dbType"
                  :options="DB_TYPES"
                  @update:model-value="handleTypeChange"
                />
              </Field>

              <Field label="主机" label-width="100px">
                <Input v-model="form.host" placeholder="127.0.0.1" />
              </Field>

              <Field label="端口" label-width="100px">
                <NumberInput v-model="form.port" :min="1" :max="65535" />
              </Field>

              <Field label="数据库" label-width="100px">
                <Input v-model="form.database" />
              </Field>

              <Field label="用户名" label-width="100px">
                <Input v-model="form.username" />
              </Field>

              <Field label="密码" label-width="100px">
                <Input
                  v-model="form.password"
                  type="password"
                  placeholder="留空沿用已保存密码"
                  show-password
                />
              </Field>

              <Field label="备注" label-width="100px">
                <Input v-model="form.note" placeholder="可选，连接列表悬停展示" />
              </Field>

              <Field label="标记" label-width="100px">
                <div class="conn-form__markers">
                  <ColorInput v-model="form.color" />

                  <!-- 环境标识（互斥） -->
                  <Checkbox
                    :model-value="envMark === 'local'"
                    @update:model-value="toggleEnv('local', $event)"
                  >
                    本地库
                  </Checkbox>
                  <Checkbox
                    :model-value="envMark === 'test'"
                    @update:model-value="toggleEnv('test', $event)"
                  >
                    测试库
                  </Checkbox>
                  <Checkbox
                    :model-value="envMark === 'production'"
                    @update:model-value="toggleEnv('production', $event)"
                  >
                    生产库
                  </Checkbox>

                  <Checkbox v-model="form.readOnly">只读连接</Checkbox>
                </div>
              </Field>
            </template>

            <!-- 高级：方言、超时与自定义参数 -->
            <template #panel-advanced>
              <Field v-if="form.dbType === 'mysql'" label="字符集" label-width="100px">
                <Input v-model="form.charset" placeholder="默认 utf8mb4" />
              </Field>
              <Field v-else label="默认模式" label-width="100px">
                <Input v-model="form.defaultSchema" placeholder="如 public" />
              </Field>

              <Field label="连接超时" label-width="100px">
                <div class="flex items-center gap-2">
                  <NumberInput v-model="form.connectTimeoutSecs" :min="1" :max="600" />
                  <span class="conn-form__unit">秒（默认 10）</span>
                </div>
              </Field>

              <Field label="查询超时" label-width="100px">
                <div class="flex items-center gap-2">
                  <NumberInput v-model="form.queryTimeoutSecs" :min="1" :max="3600" />
                  <span class="conn-form__unit">秒（默认 60）</span>
                </div>
              </Field>

              <Field label="空闲回收" label-width="100px">
                <div class="flex items-center gap-2">
                  <NumberInput v-model="form.keepaliveSecs" :min="1" :max="3600" />
                  <span class="conn-form__unit">秒（默认 30）</span>
                </div>
              </Field>

              <Field label="附加参数" label-width="100px">
                <Input
                  v-model="form.urlParams"
                  type="textarea"
                  :rows="3"
                  placeholder="key=value&key2=value2"
                />
              </Field>
            </template>

            <!-- SSL 页签上的小圆点表示已启用（只影响页签外观，不影响无障碍名称） -->
            <template #tab-ssl>
              <span class="conn-form__tab">
                SSL
                <span v-if="form.sslMode !== 'disable'" class="conn-form__tab-dot" />
              </span>
            </template>

            <!-- SSL：单独一页 -->
            <template #panel-ssl>
              <Field label="SSL 模式" label-width="100px">
                <Combobox v-model="form.sslMode" :options="SSL_MODES" />
              </Field>

              <template v-if="form.sslMode !== 'disable'">
                <Field label="CA 证书" label-width="100px">
                  <Input v-model="form.sslCaPath" placeholder="/etc/ssl/ca.pem" />
                </Field>
                <Field label="客户端证书" label-width="100px">
                  <Input v-model="form.sslCertPath" placeholder="/etc/ssl/client.pem" />
                </Field>
                <Field label="客户端私钥" label-width="100px">
                  <Input v-model="form.sslKeyPath" placeholder="/etc/ssl/client.key" />
                </Field>
              </template>

              <p class="conn-form__tip conn-form__tip--ssl">
                {{ sslHint }}
              </p>
            </template>
          </TabGroup>
        </div>
      </section>
    </div>

    <!-- 元数据查看：库 / 表 / 字段 -->
    <ConnectionMetadataDialog
      v-model:visible="metadataVisible"
      :connection="savedConnection"
    />
  </div>
</template>

<style scoped>
/* 标签页内：内容铺满可用区域，各分区内部自行滚动 */
.conn-workspace {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.conn-mgr {
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
.conn-mgr__list {
  display: flex;
  flex-direction: column;
  flex: 0 0 260px;
  min-height: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.conn-mgr__list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 0 0 auto;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  font-size: var(--app-font-size);
  font-weight: 600;
}

.conn-mgr__items {
  flex: 1;
  margin: 0;
  padding: 6px;
  list-style: none;
  overflow: auto;
}

.conn-mgr__item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.conn-mgr__item:hover {
  background: var(--hover-bg);
}

.conn-mgr__item.is-active {
  background: var(--active-bg);
}

.conn-mgr__item-main {
  flex: 1;
  min-width: 0;
}

.conn-mgr__item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--app-font-size);
}

.conn-mgr__item-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conn-mgr__item-addr {
  display: block;
  margin-top: 3px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--app-font-size-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 颜色点：环境标记，与表单里的颜色选择器同一取值 */
.conn-mgr__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.conn-mgr__item-del {
  flex: 0 0 auto;
  opacity: 0;
  color: var(--text-muted);
}

.conn-mgr__item:hover .conn-mgr__item-del {
  opacity: 1;
}

.conn-mgr__item-del:hover {
  color: var(--danger-color);
}

.conn-mgr__empty {
  padding: 20px 10px;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  text-align: center;
}

/* 右侧详情：头部固定，页签区吃掉剩余空间 */
.conn-mgr__editor {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  gap: 10px;
  overflow: hidden;
}

.conn-mgr__editor-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
}

.conn-mgr__editor-title {
  font-size: var(--app-font-size-lg);
  font-weight: 600;
}

.conn-mgr__editor-note {
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}

/* 操作按钮靠最右侧 */
.conn-mgr__editor-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

/*
 * 编辑器操作行：按钮间距只由 gap 决定。
 * （旧样式里那条 `.el-button + .el-button { margin-left: 0 }` 是在抵消
 * Element Plus 给相邻按钮加的 12px，随组件库一起去掉了。）
 */

.conn-mgr__form {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/* 页签区：外框 + 表头固定 + 内容区内部滚动 */
.conn-mgr__tabs {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.conn-mgr__tabs :deep(.app-tabgroup__tabs) {
  flex: 0 0 auto;
  padding: 6px 12px 0;
}

.conn-mgr__tabs :deep(.app-tabgroup__content) {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px 16px;
}

/* 标记行：颜色选择器与两个开关放在一行 */
.conn-form__markers {
  display: flex;
  align-items: center;
  gap: 16px;
}

.conn-form__tip {
  margin: -6px 0 10px 100px;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}

/* SSL 页的说明段落 */
.conn-form__tip--ssl {
  margin-left: 0;
  line-height: 1.6;
}

/* SSL 页签：启用后带小圆点 */
.conn-form__tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.conn-form__tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success-color);
}

.conn-form__unit {
  margin-left: 8px;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}
</style>
