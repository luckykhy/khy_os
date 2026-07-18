<template>
  <el-dialog
    :model-value="modelValue"
    title="导入 Coze 工作流"
    width="860px"
    top="6vh"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @open="onOpen"
  >
    <div class="coze-import">
      <div class="import-toolbar">
        <el-button :icon="Upload" :loading="enumerating" @click="triggerUpload">上传集合 zip</el-button>
        <el-button :icon="Refresh" :loading="catalogLoading" @click="loadCatalog">刷新内置画廊</el-button>
        <input
          ref="fileInput"
          type="file"
          accept=".zip,.json,application/zip,application/json"
          style="display: none"
          @change="onFileChange"
        />
      </div>

      <el-tabs v-model="activeTab" @tab-change="onTabChange">
        <el-tab-pane label="内置画廊" name="builtin" />
        <el-tab-pane label="我的上传" name="upload" />
      </el-tabs>

      <div class="gallery-controls">
        <el-input
          v-model="search"
          placeholder="按名称搜索…"
          clearable
          :prefix-icon="SearchIcon"
          class="search-box"
        />
        <span v-if="entries.length" class="count-hint">
          共 {{ entries.length }} 个工作流<template v-if="skipped"> · 跳过 {{ skipped }} 个无法解析</template>
        </span>
      </div>

      <el-empty
        v-if="!busy && !entries.length"
        :description="emptyText"
      />

      <div v-loading="busy" :class="{ 'grid-loading': busy }">
        <div v-if="pagedEntries.length" class="entry-grid">
          <div v-for="entry in pagedEntries" :key="entry.index" class="entry-card">
            <div class="entry-card__head">
              <span class="entry-card__name" :title="entry.name">{{ entry.name }}</span>
              <el-tag size="small" type="info">{{ entry.nodeCount }} 节点</el-tag>
            </div>

            <div v-if="typeChips(entry.report).length" class="entry-card__chips">
              <el-tag
                v-for="chip in typeChips(entry.report)"
                :key="chip"
                size="small"
                effect="plain"
                class="type-chip"
              >{{ chip }}</el-tag>
            </div>

            <div v-if="warnings(entry.report).length" class="entry-card__warnings">
              <el-tag
                v-for="(w, wi) in warnings(entry.report)"
                :key="wi"
                size="small"
                :type="w.type"
                effect="light"
              >{{ w.text }}</el-tag>
            </div>
            <div v-else class="entry-card__clean">
              <el-tag size="small" type="success" effect="plain">原生可执行</el-tag>
            </div>

            <div class="entry-card__actions">
              <template v-if="installedMap[entry.index]">
                <el-tag type="success" size="small" effect="dark">已安装</el-tag>
                <el-button text type="primary" :icon="EditPen" @click="openEditor(installedMap[entry.index])">
                  打开编辑器
                </el-button>
              </template>
              <el-button
                v-else
                type="primary"
                size="small"
                :icon="Download"
                :loading="installing === entry.index"
                :disabled="installing !== -1"
                @click="install(entry)"
              >安装</el-button>
            </div>
          </div>
        </div>

        <div v-if="filteredEntries.length > pageSize" class="gallery-pagination">
          <el-pagination
            v-model:current-page="page"
            :page-size="pageSize"
            :total="filteredEntries.length"
            layout="prev, pager, next, total"
            background
          />
        </div>
      </div>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Upload, Refresh, Download, EditPen, Search as SearchIcon } from '@element-plus/icons-vue'
import { useWorkflow } from '@/composables/useWorkflow'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'installed'])

const router = useRouter()
const { enumerateCoze, cozeCatalog, installCozeEntry } = useWorkflow()

const activeTab = ref('builtin')
const fileInput = ref(null)

const sessionId = ref(null)
const entries = ref([])
const total = ref(0)
const skipped = ref(0)
const installedMap = ref({}) // entry.index -> created workflow id

const catalogLoading = ref(false)
const enumerating = ref(false)
const installing = ref(-1)
const search = ref('')
const page = ref(1)
const pageSize = 12

const busy = computed(() => catalogLoading.value || enumerating.value)

const emptyText = computed(() => {
  if (activeTab.value === 'builtin') {
    return '内置画廊为空（在 KHY_COZE_CATALOG_DIR 放入 Coze 集合 zip 后刷新）'
  }
  return '点击上方「上传集合 zip」选择一个 Coze 导出的 .zip'
})

const filteredEntries = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return entries.value
  return entries.value.filter((e) => String(e.name || '').toLowerCase().includes(q))
})

const pagedEntries = computed(() => {
  const start = (page.value - 1) * pageSize
  return filteredEntries.value.slice(start, start + pageSize)
})

watch([search, entries], () => { page.value = 1 })

function resetCatalog() {
  sessionId.value = null
  entries.value = []
  total.value = 0
  skipped.value = 0
  installedMap.value = {}
  search.value = ''
  page.value = 1
}

function applyResult(res) {
  sessionId.value = res?.sessionId || null
  entries.value = Array.isArray(res?.entries) ? res.entries : []
  total.value = res?.total || entries.value.length
  skipped.value = res?.skipped || 0
  installedMap.value = {}
  page.value = 1
}

async function loadCatalog() {
  catalogLoading.value = true
  try {
    const res = await cozeCatalog()
    applyResult(res)
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '加载内置画廊失败')
  } finally {
    catalogLoading.value = false
  }
}

function onTabChange(name) {
  resetCatalog()
  if (name === 'builtin') loadCatalog()
}

// Reset to a clean built-in view each time the dialog opens.
function onOpen() {
  activeTab.value = 'builtin'
  resetCatalog()
  loadCatalog()
}

function triggerUpload() {
  activeTab.value = 'upload'
  if (fileInput.value) {
    fileInput.value.value = '' // allow re-selecting the same file
    fileInput.value.click()
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

async function onFileChange(evt) {
  const file = evt.target.files && evt.target.files[0]
  if (!file) return
  enumerating.value = true
  resetCatalog()
  try {
    const contentBase64 = await readFileAsBase64(file)
    const res = await enumerateCoze({ contentBase64 })
    applyResult(res)
    ElMessage.success(`已解析 ${entries.value.length} 个工作流`)
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '解析失败')
  } finally {
    enumerating.value = false
  }
}

function typeChips(report) {
  const counts = report?.typeCounts
  if (!counts || typeof counts !== 'object') return []
  return Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a])
    .slice(0, 6)
    .map((t) => `${t}×${counts[t]}`)
}

function warnings(report) {
  const out = []
  if (!report) return out
  const codeCount = report.typeCounts && report.typeCounts.code
  if (codeCount) {
    out.push({ type: 'danger', text: `含 ${codeCount} 个 code 节点（Python，原生执行会失败）` })
  }
  if (report.unsupported && report.unsupported.length) {
    out.push({ type: 'warning', text: `${report.unsupported.length} 个节点降级为工具调用` })
  }
  if (report.warnings && report.warnings.length) {
    out.push({ type: 'info', text: `${report.warnings.length} 项近似转换` })
  }
  if (report.droppedComments) {
    out.push({ type: 'info', text: `忽略 ${report.droppedComments} 个注释` })
  }
  return out
}

async function install(entry) {
  if (!sessionId.value) {
    ElMessage.warning('会话已过期，请重新加载画廊')
    return
  }
  installing.value = entry.index
  try {
    const wf = await installCozeEntry({ sessionId: sessionId.value, index: entry.index, name: entry.name })
    installedMap.value = { ...installedMap.value, [entry.index]: wf.id }
    emit('installed', wf)
    ElMessage.success(`已安装：${wf.name}`)
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '安装失败')
  } finally {
    installing.value = -1
  }
}

function openEditor(id) {
  emit('update:modelValue', false)
  router.push({ name: 'WorkflowEditor', params: { id } })
}
</script>

<style scoped>
.coze-import {
  min-height: 320px;
}
.import-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}
.gallery-controls {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 4px 0 16px;
}
.search-box {
  max-width: 320px;
}
.count-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.grid-loading {
  min-height: 160px;
}
.entry-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
  max-height: 56vh;
  overflow-y: auto;
  padding: 2px;
}
.entry-card {
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.entry-card:hover {
  border-color: var(--el-color-primary-light-5);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
}
.entry-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.entry-card__name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.entry-card__chips,
.entry-card__warnings {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.type-chip {
  font-family: var(--el-font-family-mono, monospace);
}
.entry-card__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: auto;
  padding-top: 4px;
}
.gallery-pagination {
  display: flex;
  justify-content: center;
  margin-top: 18px;
}
</style>
