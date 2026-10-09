<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import DataTable from '@/components/ui/DataTable.vue'
import Dialog from '@/components/ui/Dialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Field from '@/components/ui/Field.vue'
import Icon from '@/components/ui/Icon.vue'
import Input from '@/components/ui/Input.vue'
import { askConfirm } from '@/utils/confirm'
import { notify } from '@/utils/notify'
import type { TableColumn } from '@/utils/tableLayout'
import {
  fetchDictionaries,
  fetchDictionaryItems,
  persistDictionary,
  persistDictionaryItems,
  removeDictionary,
} from '@/api/dictionaries'
import { useDictStore } from '@/stores/dictStore'
import { useConfigStore } from '@/stores/configStore'
import { useTabStore } from '@/stores/tabStore'
import { matchesShortcut, shortcutOf } from '@/utils/shortcuts'
import type { Dictionary, DictionaryItem } from '@/types'

/** 词典管理（单例标签页）：维护词典与条目 */

const dictStore = useDictStore()
const configStore = useConfigStore()
const tabStore = useTabStore()

const emit = defineEmits<{
  /** 首次加载完成 */
  (e: 'ready'): void
}>()

function handleSaveShortcut(event: KeyboardEvent) {
  // 仅本页激活时接管快捷键
  if (tabStore.activeSingleton !== 'dictionary') return
  if (event.defaultPrevented) return
  if (!matchesShortcut(event, shortcutOf('save-dictionary', configStore.values.shortcut_config))) return
  event.preventDefault()
  void handleSaveItems()
}

/** 词典列表 */
const dictionaries = ref<Dictionary[]>([])
const loading = ref(false)
const saving = ref(false)
const itemsLoading = ref(false)

/** 当前选中的词典 ID */
const selectedId = ref<number | null>(null)
/** 当前词典的条目草稿 */
const draftItems = ref<DictionaryItem[]>([])

/** 编辑词典的弹窗 */
const dictDialogVisible = ref(false)
const dictForm = reactive<Dictionary>({ id: 0, name: '', description: '' })

/** 当前选中的词典 */
const selectedDictionary = computed(
  () => dictionaries.value.find(item => item.id === selectedId.value) ?? null,
)

// ------------------------------------------------------------ 加载

async function loadDictionaries(keepSelection = true) {
  loading.value = true
  try {
    dictionaries.value = await fetchDictionaries()
    if (!keepSelection || !dictionaries.value.some(item => item.id === selectedId.value)) {
      selectedId.value = dictionaries.value[0]?.id ?? null
    }
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    loading.value = false
  }
}

/** 载入选中词典的条目 */
async function loadItems() {
  if (!selectedId.value) {
    draftItems.value = []
    return
  }
  itemsLoading.value = true
  try {
    draftItems.value = await fetchDictionaryItems(selectedId.value)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
    draftItems.value = []
  }
  finally {
    itemsLoading.value = false
  }
}

/** 切换词典 */
async function handleSelect(id: number) {
  if (selectedId.value === id) {
    return
  }
  selectedId.value = id
  await loadItems()
}

// ------------------------------------------------------------ 词典增删改

function openCreateDictionary() {
  Object.assign(dictForm, { id: 0, name: '', description: '' })
  dictDialogVisible.value = true
}

function openEditDictionary(dict: Dictionary) {
  Object.assign(dictForm, { ...dict })
  dictDialogVisible.value = true
}

async function handleSaveDictionary() {
  if (!dictForm.name.trim()) {
    notify.warning('请输入词典名称')
    return
  }
  saving.value = true
  try {
    const id = await persistDictionary({ ...dictForm })
    notify.success('词典已保存')
    dictDialogVisible.value = false
    // 新建的词典自动选中
    if (!dictForm.id && id) {
      selectedId.value = id
    }
    await loadDictionaries()
    await loadItems()
    await refreshCache()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    saving.value = false
  }
}

async function handleDeleteDictionary(dict: Dictionary) {
  const confirmed = await askConfirm({
    message: `确定删除词典「${dict.name}」及其全部条目吗？已绑定该词典的字段映射会失效。`,
    title: '删除词典',
    confirmText: '删除',
    tone: 'danger',
  })
  if (!confirmed) {
    return
  }

  try {
    await removeDictionary(dict.id)
    notify.success('已删除')
    await loadDictionaries(false)
    await loadItems()
    await refreshCache()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

// ------------------------------------------------------------ 条目编辑

/** 条目表列 */
const ITEM_COLUMNS: TableColumn[] = [
  { key: 'value', label: '原始值', minWidth: 150 },
  { key: 'meaning', label: '显示文本', minWidth: 150 },
  { key: 'description', label: '备注', minWidth: 180 },
  { key: 'actions', label: '操作', width: 80, align: 'center' },
]

/** 条目表空态文案 */
const itemsEmptyText = computed(() =>
  itemsLoading.value ? '正在读取条目…' : '暂无条目，点击「添加条目」')

/** 新增一行空条目 */
function addItem() {
  if (!selectedId.value) {
    notify.warning('请先选择或新建词典')
    return
  }
  draftItems.value.push({
    id: 0,
    dictionaryId: selectedId.value,
    value: '',
    meaning: '',
    description: '',
    sortOrder: draftItems.value.length,
  })
}

/** 删除一行 */
function removeItem(index: number) {
  draftItems.value.splice(index, 1)
}

/** 保存全部条目 */
async function handleSaveItems() {
  if (!selectedId.value) {
    return
  }
  const invalid = draftItems.value.some(item => !item.value.trim())
  if (invalid) {
    notify.warning('存在「原始值」为空的条目，请填写或删除')
    return
  }

  saving.value = true
  try {
    await persistDictionaryItems(selectedId.value, draftItems.value)
    notify.success('条目已保存')
    await loadItems()
    await refreshCache()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    saving.value = false
  }
}

/** 刷新全局词典缓存 */
async function refreshCache() {
  await dictStore.loadAll()
}

onMounted(async () => {
  window.addEventListener('keydown', handleSaveShortcut)
  try {
    await loadDictionaries()
    await loadItems()
  }
  finally {
    // 失败也要上报
    emit('ready')
  }
})

onBeforeUnmount(() => window.removeEventListener('keydown', handleSaveShortcut))
</script>

<template>
  <div class="dict-view">
    <header class="dict-view__head">
      <div class="dict-view__title">
        <span class="dict-view__bar" aria-hidden="true" />
        <span>词典</span>
      </div>

      <Button @click="openCreateDictionary">
        <Icon name="plus" />
        <span>新建词典</span>
      </Button>
    </header>

    <div class="dict-view__body">
      <!-- 左：词典列表 -->
      <aside class="dict-view__list">
        <ul class="dict-view__items">
          <li v-for="dict in dictionaries" :key="dict.id" class="dict-view__item"
            :class="{ 'is-active': dict.id === selectedId }" @click="handleSelect(dict.id)">
            <div class="dict-view__item-main">
              <span class="dict-view__item-name">{{ dict.name }}</span>
              <span class="dict-view__item-desc">{{ dict.description }}</span>
            </div>
            <Icon name="pencil" class="dict-view__item-edit" title="编辑" @click.stop="openEditDictionary(dict)" />
            <Icon name="trash" class="dict-view__item-del" title="删除" @click.stop="handleDeleteDictionary(dict)" />
          </li>

          <li v-if="!dictionaries.length" class="dict-view__empty">
            {{ loading ? '正在读取词典…' : '暂无词典，点击右上角新建' }}
          </li>
        </ul>
      </aside>

      <!-- 右：条目编辑 -->
      <section class="dict-view__detail">
        <template v-if="selectedDictionary">
          <div class="dict-view__detail-head">
            <span class="dict-view__detail-name">{{ selectedDictionary.name }}</span>
            <small>{{ draftItems.length }} 条</small>

            <div class="dict-view__detail-actions">
              <Button size="sm" variant="secondary" @click="addItem">
                <Icon name="plus" />
                <span>添加条目</span>
              </Button>
              <Button size="sm" :loading="saving" @click="handleSaveItems">
                保存条目
              </Button>
            </div>
          </div>

          <!-- 可编辑表格：改完点「保存条目」提交 -->
          <DataTable :columns="ITEM_COLUMNS" :rows="draftItems" size="sm" class="min-h-0 flex-1"
            :empty-text="itemsEmptyText">
            <template #cell-value="{ row }">
              <Input v-model="row.value" size="sm" placeholder="" />
            </template>
            <template #cell-meaning="{ row }">
              <Input v-model="row.meaning" size="sm" placeholder="" />
            </template>
            <template #cell-description="{ row }">
              <Input v-model="row.description" size="sm" placeholder="" />
            </template>
            <template #cell-actions="{ index }">
              <Button variant="ghost" size="sm" class="text-danger" @click="removeItem(index)">
                删除
              </Button>
            </template>
          </DataTable>
        </template>

        <EmptyState v-else description="请在左侧选择或新建词典" />
      </section>
    </div>

    <Dialog v-model="dictDialogVisible" :title="dictForm.id ? '编辑词典' : '新建词典'" :width="460">
      <div class="flex flex-col gap-1">
        <Field label="名称" required label-width="80px">
          <Input v-model="dictForm.name" placeholder="" />
        </Field>
        <Field label="描述" label-width="80px">
          <Input v-model="dictForm.description" type="textarea" :rows="2" placeholder="" />
        </Field>
      </div>

      <template #footer>
        <Button variant="secondary" size="sm" @click="dictDialogVisible = false">取消</Button>
        <Button size="sm" :loading="saving" @click="handleSaveDictionary">
          保存
        </Button>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.dict-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 16px 20px;
}

.dict-view__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex: 0 0 auto;
  margin-bottom: 14px;
}

.dict-view__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--app-font-size-lg);
  font-weight: 600;
}

.dict-view__bar {
  width: 3px;
  height: 15px;
  border-radius: 2px;
  background: var(--brand-color);
}

.dict-view__title small {
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
  font-weight: 400;
}

/* 左列表 + 右明细 */
.dict-view__body {
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

.dict-view__list {
  display: flex;
  flex-direction: column;
  flex: 0 0 240px;
  min-height: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.dict-view__items {
  flex: 1;
  margin: 0;
  padding: 6px;
  list-style: none;
  overflow: auto;
}

.dict-view__item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.dict-view__item:hover {
  background: var(--hover-bg);
}

.dict-view__item.is-active {
  background: var(--active-bg);
}

.dict-view__item-main {
  flex: 1;
  min-width: 0;
}

.dict-view__item-name {
  display: block;
  font-size: var(--app-font-size);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dict-view__item-desc {
  display: block;
  margin-top: 2px;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dict-view__item-edit,
.dict-view__item-del {
  flex: 0 0 auto;
  color: var(--text-muted);
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease;
}

.dict-view__item:hover .dict-view__item-edit,
.dict-view__item:hover .dict-view__item-del {
  opacity: 1;
}

.dict-view__item-edit:hover {
  color: var(--brand-color);
}

.dict-view__item-del:hover {
  color: var(--danger-color);
}

.dict-view__empty {
  padding: 20px 10px;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  text-align: center;
}

.dict-view__detail {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.dict-view__detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  font-size: var(--app-font-size);
  font-weight: 600;
}

.dict-view__detail-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dict-view__detail-head small {
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
  font-weight: 400;
}

.dict-view__detail-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

</style>
