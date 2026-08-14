<template>
  <div class="system-mgmt-page">
    <el-alert
      type="info"
      show-icon
      :closable="false"
      style="margin-bottom: 16px"
    >
      <template #title>
        统一管理面 · 所有资源在此可视化管理，与 <code>khy manage</code> 命令走同一后端漏斗，永不矛盾。
      </template>
    </el-alert>

    <el-card shadow="never" v-loading="loadingResources">
      <template #header>
        <div class="card-header">
          <span class="card-title">可管理资源</span>
          <el-button size="small" :loading="loadingResources" @click="fetchResources">刷新</el-button>
        </div>
      </template>

      <el-tabs v-model="activeId" @tab-change="onTabChange">
        <el-tab-pane
          v-for="r in resources"
          :key="r.id"
          :label="r.label"
          :name="r.id"
        >
          <div class="resource-meta">
            <el-tag size="small" effect="plain">来源: {{ r.source }}:{{ r.sourceDetail }}</el-tag>
            <el-tag
              v-for="cap in r.capabilities"
              :key="cap"
              size="small"
              :type="cap === 'list' ? 'info' : 'primary'"
              effect="plain"
              style="margin-left: 6px"
            >{{ cap }}</el-tag>
          </div>

          <div class="actions-bar">
            <el-button
              v-if="r.capabilities.includes('list')"
              size="small"
              :loading="loadingItems"
              @click="loadList(r.id)"
            >刷新列表</el-button>
            <el-button
              v-for="cap in writeCapabilities(r)"
              :key="cap"
              size="small"
              type="primary"
              @click="openOpDialog(r, cap)"
            >{{ cap }}</el-button>
          </div>

          <el-table
            v-if="r.capabilities.includes('list')"
            :data="items"
            v-loading="loadingItems"
            size="small"
            stripe
            style="margin-top: 12px"
          >
            <el-table-column
              v-for="col in columns"
              :key="col"
              :prop="col"
              :label="col"
              show-overflow-tooltip
              min-width="120"
            >
              <template #default="{ row }">
                <span>{{ renderCell(row[col]) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" min-width="200" fixed="right">
              <template #default="{ row }">
                <el-button
                  v-for="cap in rowCapabilities(r)"
                  :key="cap"
                  size="small"
                  :type="cap === 'delete' ? 'danger' : 'default'"
                  text
                  @click="openRowOp(r, cap, row)"
                >{{ cap }}</el-button>
              </template>
            </el-table-column>
          </el-table>

          <el-empty
            v-else
            description="该资源无 list 能力，请使用上方操作按钮"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- Op argument dialog (schema-driven) -->
    <el-dialog v-model="opDialogVisible" :title="opDialogTitle" width="520px">
      <el-form label-width="120px">
        <el-form-item
          v-for="field in opFields"
          :key="field.name"
          :label="field.name"
          :required="field.required"
        >
          <el-input
            v-model="opArgs[field.name]"
            :type="field.name === 'password' ? 'password' : 'text'"
            :placeholder="field.required ? '必填' : '可选'"
          />
        </el-form-item>
        <el-empty v-if="!opFields.length" description="该操作无需参数" :image-size="60" />
      </el-form>
      <template #footer>
        <el-button @click="opDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="invoking" @click="submitOp">执行</el-button>
      </template>
    </el-dialog>

    <!-- Result dialog -->
    <el-dialog v-model="resultVisible" title="执行结果" width="640px">
      <pre class="result-block">{{ resultText }}</pre>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { manageAPI } from '@/api/manage'

const resources = ref([])
const activeId = ref('')
const loadingResources = ref(false)
const loadingItems = ref(false)
const items = ref([])
const columns = ref([])

const opDialogVisible = ref(false)
const opDialogTitle = ref('')
const opFields = ref([])
const opArgs = reactive({})
const invoking = ref(false)
let currentResource = null
let currentOp = ''

const resultVisible = ref(false)
const resultText = ref('')

function writeCapabilities(r) {
  // Capabilities that create new state (no per-row target). Row-scoped ops are
  // rendered per row instead.
  return r.capabilities.filter((c) => c === 'create' || c === 'add')
}

function rowCapabilities(r) {
  return r.capabilities.filter((c) => !['list', 'create', 'add'].includes(c))
}

function renderCell(val) {
  if (val == null) return '—'
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

async function fetchResources() {
  loadingResources.value = true
  try {
    const res = await manageAPI.listResources()
    if (res && res.success && Array.isArray(res.data)) {
      resources.value = res.data
      if (res.data.length && !activeId.value) {
        activeId.value = res.data[0].id
        onTabChange(activeId.value)
      }
    } else {
      ElMessage.error((res && res.error) || '获取资源列表失败')
    }
  } catch (err) {
    ElMessage.error(err.message || '获取资源列表失败')
  } finally {
    loadingResources.value = false
  }
}

function currentResourceById(id) {
  return resources.value.find((r) => r.id === id) || null
}

function onTabChange(id) {
  const r = currentResourceById(id)
  items.value = []
  columns.value = []
  if (r && r.capabilities.includes('list')) loadList(id)
}

async function loadList(id) {
  loadingItems.value = true
  try {
    const res = await manageAPI.invoke(id, 'list', {})
    if (res && res.success) {
      const data = res.data || {}
      const arrKey = Object.keys(data).find((k) => Array.isArray(data[k]))
      const rows = arrKey ? data[arrKey] : []
      items.value = rows
      // Derive columns from the union of row keys (objects) or a single value col.
      const keys = new Set()
      for (const row of rows) {
        if (row && typeof row === 'object') Object.keys(row).forEach((k) => keys.add(k))
      }
      columns.value = keys.size ? [...keys] : (rows.length ? ['value'] : [])
      if (!keys.size && rows.length) items.value = rows.map((v) => ({ value: v }))
    } else {
      ElMessage.error((res && res.error) || '加载列表失败')
    }
  } catch (err) {
    ElMessage.error(err.message || '加载列表失败')
  } finally {
    loadingItems.value = false
  }
}

function fieldsForOp(r, op) {
  const schema = (r.schema && r.schema[op]) || {}
  return Object.keys(schema).map((name) => ({
    name,
    required: !!schema[name].required,
    type: schema[name].type || 'string',
  }))
}

function openOpDialog(r, op, prefill = {}) {
  currentResource = r
  currentOp = op
  opDialogTitle.value = `${r.label} · ${op}`
  opFields.value = fieldsForOp(r, op)
  Object.keys(opArgs).forEach((k) => delete opArgs[k])
  for (const f of opFields.value) opArgs[f.name] = prefill[f.name] != null ? prefill[f.name] : ''
  opDialogVisible.value = true
}

async function openRowOp(r, op, row) {
  // delete is destructive → confirm before invoking.
  if (op === 'delete') {
    try {
      await ElMessageBox.confirm(
        `确认删除该 ${r.label} 记录？此操作不可撤销。`,
        '确认删除',
        { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      return
    }
  }
  const fields = fieldsForOp(r, op)
  // Prefill identity fields from the row (id / keyId / provider).
  const prefill = {}
  for (const f of fields) {
    if (row[f.name] != null) prefill[f.name] = row[f.name]
  }
  // If every field is satisfied by the row (and none is a secret like password), invoke directly.
  const needsInput = fields.some((f) => f.required && (prefill[f.name] == null || prefill[f.name] === '') || f.name === 'password')
  if (!needsInput) {
    await invokeOp(r, op, prefill)
    return
  }
  openOpDialog(r, op, prefill)
}

async function submitOp() {
  await invokeOp(currentResource, currentOp, { ...opArgs })
}

async function invokeOp(r, op, args) {
  invoking.value = true
  try {
    const res = await manageAPI.invoke(r.id, op, args)
    if (res && res.success) {
      const data = res.data
      // Tiered install responses surface manualOnly / offline.
      if (data && data.manualOnly) {
        ElMessageBox.alert(
          `${data.reason || '需手动执行'}\n\n命令: ${data.displayCommand || ''}`,
          '需要手动操作',
          { confirmButtonText: '知道了' }
        ).catch(() => {})
      } else if (data && data.offline) {
        ElMessage.error(data.error || '当前离线，无法执行')
      } else {
        ElMessage.success(`${r.label} ${op} 成功`)
      }
      resultText.value = JSON.stringify(data, null, 2)
      opDialogVisible.value = false
      if (r.capabilities.includes('list')) loadList(r.id)
    } else {
      ElMessage.error((res && res.error) || `${op} 执行失败`)
      resultText.value = JSON.stringify(res, null, 2)
      resultVisible.value = true
    }
  } catch (err) {
    ElMessage.error(err.message || `${op} 执行失败`)
  } finally {
    invoking.value = false
  }
}

fetchResources()
</script>

<style scoped>
.system-mgmt-page {
  padding: 4px;
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-title {
  font-weight: 600;
  font-size: 15px;
}
.resource-meta {
  margin-bottom: 12px;
}
.actions-bar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.result-block {
  font-family: monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 50vh;
  overflow: auto;
  background: var(--el-fill-color-light);
  padding: 12px;
  border-radius: 6px;
}
</style>
