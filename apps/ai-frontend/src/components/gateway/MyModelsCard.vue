<template>
  <el-card class="gw-card" shadow="never">
    <template #header>
      <div class="gw-card-head">
        <div class="gw-card-title">
          <el-icon><List /></el-icon>
          <span>我的模型列表 · 增删改</span>
        </div>
        <el-tag size="small" effect="light" type="info">{{ models.length }} 个</el-tag>
      </div>
    </template>

    <p class="gw-card-desc">
      你自己的模型清单（可增删改）：上游探测自动入库，也可手动添加。下方「模型总览」里标注「系统/全局」的模型由系统统一管理，不在此处删除。图像 / 语音 / 视频仅作能力标注，不进入文本路由。
    </p>

    <!-- Add form -->
    <el-form label-position="top" class="gw-add-form">
      <div class="gw-form-row">
        <el-form-item label="供应商" required class="gw-flex">
          <el-select
            v-model="draft.provider"
            filterable
            allow-create
            default-first-option
            placeholder="选择或输入 provider"
          >
            <el-option v-for="p in presetOptions" :key="p" :label="p" :value="p" />
          </el-select>
        </el-form-item>
        <el-form-item label="能力" class="gw-flex">
          <el-select v-model="draft.capability" placeholder="自动识别">
            <el-option label="自动识别" value="" />
            <el-option v-for="c in CAPABILITIES" :key="c.value" :label="c.label" :value="c.value" />
          </el-select>
        </el-form-item>
      </div>
      <el-form-item label="模型 ID" required>
        <el-input v-model="draft.model" placeholder="如 deepseek-chat / gpt-4o-mini" @keyup.enter="onAdd" />
      </el-form-item>
      <div class="gw-actions">
        <el-button type="primary" :loading="busy" @click="onAdd">添加模型</el-button>
      </div>
    </el-form>

    <el-divider />

    <!-- Grouped list by provider -->
    <div v-if="grouped.length === 0" class="gw-empty">还没有模型，先检测上游或手动添加</div>
    <div v-for="g in grouped" :key="g.provider" class="gw-group">
      <div class="gw-group-head">
        <span class="gw-group-name">{{ g.provider }}</span>
        <span class="gw-group-count">{{ g.rows.length }} 个</span>
      </div>
      <div v-for="row in g.rows" :key="row.id" class="gw-mrow" :class="{ 'is-off': !row.isActive }">
        <span class="gw-mname">{{ row.model }}</span>
        <el-select
          :model-value="row.capability"
          size="small"
          class="gw-mcap"
          @change="(v) => onChangeCapability(row, v)"
        >
          <el-option v-for="c in CAPABILITIES" :key="c.value" :label="c.label" :value="c.value" />
        </el-select>
        <el-tag size="small" :type="row.source === 'manual' ? 'success' : 'info'" effect="plain">
          {{ row.source === 'manual' ? '手动' : '检测' }}
        </el-tag>
        <el-switch
          :model-value="row.isActive"
          size="small"
          inline-prompt
          active-text="启"
          inactive-text="停"
          @change="(v) => onToggleActive(row, v)"
        />
        <el-button text type="danger" size="small" @click="onRemove(row)">删除</el-button>
      </div>
    </div>
  </el-card>
</template>

<script setup>
import { reactive, computed } from 'vue'
import { List } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const props = defineProps({
  models: { type: Array, default: () => [] },
  // Built-in provider presets — only used to offer a convenient provider dropdown.
  presets: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['add', 'update', 'remove'])

const CAPABILITIES = [
  { value: 'text', label: '文本' },
  { value: 'audio', label: '语音' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
]

const draft = reactive({ provider: '', model: '', capability: '' })

// Provider dropdown options: preset ids ∪ providers already present in the list.
const presetOptions = computed(() => {
  const set = new Set()
  for (const p of props.presets) if (p && p.id) set.add(p.id)
  for (const m of props.models) if (m && m.provider) set.add(m.provider)
  return Array.from(set).sort()
})

const grouped = computed(() => {
  const map = new Map()
  for (const m of props.models) {
    if (!map.has(m.provider)) map.set(m.provider, { provider: m.provider, rows: [] })
    map.get(m.provider).rows.push(m)
  }
  return Array.from(map.values())
})

function onAdd() {
  const provider = String(draft.provider || '').trim().toLowerCase()
  const model = String(draft.model || '').trim()
  if (!provider) return ElMessage.warning('请填写供应商')
  if (!model) return ElMessage.warning('请填写模型 ID')
  const payload = { provider, model }
  if (draft.capability) payload.capability = draft.capability
  emit('add', payload)
  draft.model = ''
  draft.capability = ''
}

function onChangeCapability(row, capability) {
  if (capability === row.capability) return
  emit('update', { id: row.id, patch: { capability } })
}

function onToggleActive(row, isActive) {
  emit('update', { id: row.id, patch: { isActive } })
}

async function onRemove(row) {
  try {
    await ElMessageBox.confirm(`确认从你的列表删除「${row.model}」吗？`, '删除模型', { type: 'warning' })
    emit('remove', row.id)
  } catch { /* cancelled */ }
}
</script>

<style scoped>
.gw-card { border: 1px solid var(--khy-border); border-radius: var(--khy-radius); }
.gw-card-head { display: flex; align-items: center; justify-content: space-between; }
.gw-card-title { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--khy-text-strong); }
.gw-card-desc { margin: 0 0 14px; color: var(--khy-text-secondary); font-size: 13px; line-height: 1.5; }
.gw-form-row { display: flex; gap: 14px; }
.gw-flex { flex: 1; min-width: 0; }
.gw-actions { display: flex; gap: 10px; }
.gw-empty { color: var(--khy-text-muted); font-size: 13px; padding: 8px 0; }
.gw-group { margin-bottom: 14px; }
.gw-group-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.gw-group-name { font-weight: 600; color: var(--khy-text-strong); font-size: 14px; }
.gw-group-count { margin-left: auto; font-size: 12px; color: var(--khy-text-muted); }
.gw-mrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 7px 10px; border: 1px solid var(--khy-border-light); border-radius: var(--khy-radius-sm); margin-bottom: 6px; }
.gw-mrow.is-off { opacity: 0.55; }
.gw-mname { font-family: var(--khy-font-mono, monospace); font-size: 13px; color: var(--khy-text-main); flex: 1; min-width: 120px; }
.gw-mcap { width: 96px; }
@media (max-width: 640px) { .gw-form-row { flex-direction: column; gap: 0; } }
</style>
