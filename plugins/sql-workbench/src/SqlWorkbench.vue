<script setup lang="ts">
/**
 * SQL 工作台：把「写模板」和「按模板查数」合成一个入口。
 *
 * 两个模式共用同一个标签页，用右上角的图标按钮来回切换：
 * 检索模式显示花括号（点它去配模板），配置模式显示图表（点它去查数）。
 *
 * 切换时会把当前条件交接过去——模板、数据源、库保持一致，
 * 免得每次换视图都要重新选一遍。
 */
import { ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import Icon from '@/components/ui/Icon.vue'
import SqlConfigView from './SqlConfigView.vue'
import SqlSearchView from './SqlSearchView.vue'
import type { ColumnMeta, DbQueryPayload } from '@/types'

const props = defineProps<{
  /** 所属 Tab 的 ID */
  tabId: number
  /** 从 Tab payload 恢复的状态 */
  initialPayload?: Record<string, unknown>
}>()

const emit = defineEmits<{
  (e: 'change', tabId: number, payload: DbQueryPayload): void
  /** 首次初始化完成 */
  (e: 'ready'): void
}>()

type WorkbenchMode = 'config' | 'search'

/** 两个子视图切换时交接的条件 */
interface WorkbenchSelection {
  templateId: number | null
  connId: number | null
  database: string
}

/** 子视图暴露的接口，用结构类型声明，不依赖 SFC 的类型推断 */
interface SelectionExposing {
  currentSelection?: () => WorkbenchSelection
}

/** 视图模式存本地：下次启动回到上次停留的那个视图 */
const MODE_STORAGE_KEY = 'toolbox.sqlWorkbench.mode'

function loadMode(): WorkbenchMode {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) === 'config' ? 'config' : 'search'
  }
  catch {
    // localStorage 不可用时按默认走
    return 'search'
  }
}

/** 默认进检索模式：多数时候是来查数的，写模板是低频操作 */
const mode = ref<WorkbenchMode>(loadMode())

watch(mode, (value) => {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, value)
  }
  catch {
    // 存不了不影响使用
  }
})
/** 切换前从当前视图取到的条件，作为目标视图的初始选择 */
const seed = ref<WorkbenchSelection | null>(null)
/** 检索模式最近一次查询的结果列：配置模式据此补齐字段映射 */
const lastColumns = ref<ColumnMeta[]>([])

const searchRef = ref<SelectionExposing | null>(null)
const configRef = ref<SelectionExposing | null>(null)

/** 取当前视图的条件；组件还没挂好时返回 null */
function currentSelection(): WorkbenchSelection | null {
  const view = mode.value === 'search' ? searchRef.value : configRef.value
  if (!view || typeof view.currentSelection !== 'function') {
    return null
  }
  return view.currentSelection()
}

function toggleMode(): void {
  seed.value = currentSelection()
  mode.value = mode.value === 'config' ? 'search' : 'config'
}

function handleChange(tabId: number, payload: DbQueryPayload): void {
  emit('change', tabId, payload)
}
</script>

<template>
  <div class="sql-workbench">
    <SqlSearchView
      v-if="mode === 'search'"
      ref="searchRef"
      :tab-id="props.tabId"
      :initial-payload="props.initialPayload ?? {}"
      :seed-template-id="seed?.templateId ?? null"
      :seed-conn-id="seed?.connId ?? null"
      :seed-database="seed?.database ?? ''"
      @change="handleChange"
      @result-columns="(columns) => (lastColumns = columns)"
      @ready="emit('ready')"
    >
      <template #toolbar-end>
        <Button variant="secondary" :title="'切换到模板视图'" @click="toggleMode">
          <Icon name="braces" />
          <span>模板视图</span>
        </Button>
      </template>
    </SqlSearchView>

    <SqlConfigView
      v-else
      ref="configRef"
      :seed-template-id="seed?.templateId ?? null"
      :result-columns="lastColumns"
      @ready="emit('ready')"
    >
      <template #toolbar-end>
        <Button variant="secondary" :title="'切换到查询视图'" @click="toggleMode">
          <Icon name="chart" />
          <span>查询视图</span>
        </Button>
      </template>
    </SqlConfigView>
  </div>
</template>

<style scoped>
.sql-workbench {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
</style>
