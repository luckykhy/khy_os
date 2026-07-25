<template>
  <el-card class="gw-card" shadow="never">
    <template #header>
      <div class="gw-card-head">
        <div class="gw-card-title">
          <el-icon><Key /></el-icon>
          <span>{{ title }}</span>
        </div>
        <el-tag size="small" effect="light" type="info">{{ providers.length }} 条密钥</el-tag>
      </div>
    </template>

    <p class="gw-card-desc">{{ description }}</p>

    <!-- Add form -->
    <el-form :inline="false" label-position="top" class="gw-add-form">
      <el-form-item v-if="presets.length" label="供应商预设（选一个自动填充，仍可改）">
        <el-select v-model="presetId" placeholder="自定义 / 选择常见供应商" clearable @change="onPickPreset">
          <el-option label="自定义" value="" />
          <el-option v-for="p in presets" :key="p.id" :label="p.label || p.id" :value="p.id" />
        </el-select>
        <ProviderLinks v-if="selectedLinks" :links="selectedLinks" />
      </el-form-item>
      <div class="gw-form-row">
        <el-form-item label="Provider" required class="gw-flex">
          <el-input v-model="draft.provider" placeholder="如 openai / deepseek / acme" />
        </el-form-item>
        <el-form-item label="显示名（可选）" class="gw-flex">
          <el-input v-model="draft.displayName" placeholder="Acme Cloud" />
        </el-form-item>
      </div>
      <el-form-item label="API Key" required>
        <el-input v-model="draft.key" type="password" show-password autocomplete="new-password" :placeholder="keyPlaceholder" />
      </el-form-item>
      <el-form-item label="初始模型（可选，逗号/换行分隔，可稍后再加）">
        <el-input
          v-model="draft.models"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 3 }"
          placeholder="如 deepseek-chat, deepseek-reasoner"
        />
      </el-form-item>
      <div class="gw-actions">
        <el-button type="primary" :loading="busy" @click="onAdd">添加密钥</el-button>
        <el-button @click="onOpenWizard">配置向导（测试 / 一键导入模型）</el-button>
      </div>
    </el-form>

    <el-divider />

    <!-- Grouped list -->
    <div v-if="grouped.length === 0" class="gw-empty">还没有自定义 provider 密钥</div>
    <div v-for="g in grouped" :key="g.provider" class="gw-group">
      <div class="gw-group-head">
        <span class="gw-group-name">{{ g.provider }}<span v-if="g.displayName" class="gw-group-alias"> · {{ g.displayName }}</span></span>
        <div class="gw-group-actions">
          <el-button text type="primary" size="small" @click="onEditProvider(g)">编辑 / 测试</el-button>
          <el-button text type="primary" size="small" @click="onAddModel(g.provider)">+ 添加模型</el-button>
          <el-button text type="danger" size="small" @click="onRemoveProvider(g.provider)">删除整组</el-button>
        </div>
      </div>
      <div v-for="entry in g.entries" :key="entry.id" class="gw-entry">
        <div class="gw-entry-row">
          <!-- Inline replace: clicking 替换 turns the masked key into an editable
               input in place (no popup). 确认 emits the new key; 取消 restores. -->
          <template v-if="editingId === entry.id">
            <el-input
              ref="editInputRef"
              v-model="editValue"
              type="password"
              show-password
              size="small"
              autocomplete="new-password"
              :placeholder="`输入新的 API Key 替换 ${entry.keyMasked}`"
              class="gw-entry-edit"
              @keyup.enter="onConfirmReplace(entry)"
              @keyup.esc="onCancelReplace"
            />
            <div class="gw-entry-actions">
              <el-button text type="primary" size="small" :disabled="!editValue.trim()" @click="onConfirmReplace(entry)">确认</el-button>
              <el-button text size="small" @click="onCancelReplace">取消</el-button>
            </div>
          </template>
          <template v-else>
            <div class="gw-entry-meta">
              <code class="gw-entry-key">{{ entry.keyMasked }}</code>
              <span v-if="entry.label" class="gw-entry-label">{{ entry.label }}</span>
              <el-tag v-if="!entry.isActive" size="small" type="info" effect="plain">停用</el-tag>
              <el-tag size="small" type="info" effect="plain">{{ modelsFor(g.provider).length }} 模型</el-tag>
            </div>
            <div class="gw-entry-actions">
              <el-button text type="primary" size="small" @click="onReplaceEntry(entry)">替换</el-button>
              <el-button text type="danger" size="small" @click="onRemoveEntry(entry.id)">移除</el-button>
            </div>
          </template>
        </div>
        <!-- Model "branches": each key forks into the models reachable through its
             provider (a provider's keys share one model list). Honest tree view so
             the user sees, per key, exactly which models it serves. -->
        <ul class="gw-branches">
          <li
            v-for="(m, i) in modelsFor(g.provider)"
            :key="m.id ?? m.model"
            class="gw-branch"
            :class="{ 'is-off': m.isActive === false }"
          >
            <span class="gw-branch-tee">{{ i === modelsFor(g.provider).length - 1 ? '└─' : '├─' }}</span>
            <span class="gw-branch-model">{{ m.model }}</span>
            <el-tag v-if="capLabel(m.capability)" size="small" effect="plain" class="gw-branch-cap">{{ capLabel(m.capability) }}</el-tag>
            <el-button
              v-if="m.id != null"
              text
              type="danger"
              size="small"
              class="gw-branch-x"
              title="从该供应商删除此模型"
              @click="onRemoveModel(m)"
            >×</el-button>
          </li>
          <li v-if="!modelsFor(g.provider).length" class="gw-branch gw-branch-empty">
            <span class="gw-branch-tee">└─</span>
            <span>暂无模型 · 点上方「+ 添加模型」或到「模型总览」检测</span>
          </li>
        </ul>
      </div>
    </div>
  </el-card>
</template>

<script setup>
import { reactive, ref, computed, nextTick } from 'vue'
import { Key } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import ProviderLinks from './ProviderLinks.vue'
import { validateProviderDraft, buildProviderPayload } from './customProviderForm.js'

const props = defineProps({
  scope: { type: String, default: 'user' },
  providers: { type: Array, default: () => [] },
  // The user's own model rows ({ id, provider, model, capability, isActive }).
  // Used to draw each key's model "branches"; a provider's keys share its list.
  models: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
  // Built-in common-provider presets (from useUserGateway.providerPresets).
  presets: { type: Array, default: () => [] },
})
const emit = defineEmits(['add', 'add-model', 'remove-entry', 'remove-provider', 'replace-entry', 'remove-model', 'open-config'])

// Capability → short label for branch tags (kept local; mirrors useModelPivots).
const CAP_LABELS = { text: '文本', audio: '语音', image: '图片', video: '视频' }
function capLabel(c) { return CAP_LABELS[c] || (c && c !== 'text' ? c : '') }

const isUser = computed(() => props.scope !== 'global')
const title = computed(() => (isUser.value ? '我的自定义 Provider 密钥池' : '全局自定义 Provider 密钥池'))
const description = computed(() => (isUser.value
  ? '为兼容 provider 维护你自己的密钥池，同 provider 可放多把 key 轮询。密钥仅你可见，加密存储。'
  : '全局自定义 provider 密钥池。'))

const draft = reactive({ provider: '', displayName: '', key: '', models: '', baseUrl: '', apiFormat: '', endpoint: '' })
const presetId = ref('')

// Links of the currently picked preset (home/console/docs), surfaced so the user
// knows where to obtain a key. null when no preset is selected or it has none.
const selectedLinks = computed(() => {
  const p = props.presets.find((x) => x.id === presetId.value)
  return p && p.links && Object.keys(p.links).length ? p.links : null
})

// Placeholder for the API Key field: the picked preset's example sk (e.g. Agnes
// shows `sk-agnes-xxxx`) so the user sees the expected shape; falls back to a
// generic hint. Example text only — never a real secret.
const keyPlaceholder = computed(() => {
  const p = props.presets.find((x) => x.id === presetId.value)
  return (p && p.keyExample) ? p.keyExample : 'sk-...'
})

// Picking a preset only fills the form; the user still supplies the key and may
// edit the provider id. Presets carry baseUrl/apiFormat so the post-save probe
// can discover this provider's /v1/models automatically.
function onPickPreset(id) {
  const p = props.presets.find((x) => x.id === id)
  if (!p) return
  draft.provider = p.id
  if (!draft.displayName) draft.displayName = p.label || ''
  draft.baseUrl = p.baseUrl || ''
  draft.apiFormat = p.apiFormat || ''
  draft.endpoint = p.baseUrl || ''
}

// Group flat entries by provider for display.
const grouped = computed(() => {
  const map = new Map()
  for (const p of props.providers) {
    if (!map.has(p.provider)) {
      map.set(p.provider, { provider: p.provider, displayName: p.displayName || '', entries: [] })
    }
    const g = map.get(p.provider)
    if (!g.displayName && p.displayName) g.displayName = p.displayName
    g.entries.push(p)
  }
  return Array.from(map.values())
})

// Index the user's model rows by provider (case-insensitive) so each key group
// can fork into its models. A provider's keys share one list, so every key in a
// group shows the same branches — that is the honest relationship.
const modelsByProvider = computed(() => {
  const map = new Map()
  for (const m of props.models) {
    if (!m || !m.provider) continue
    const key = String(m.provider).toLowerCase()
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(m)
  }
  return map
})
function modelsFor(provider) {
  return modelsByProvider.value.get(String(provider || '').toLowerCase()) || []
}

// Delete a single model branch (confirm first — drops it from the provider's
// list for every key). The orchestrator owns the actual mutation by row id.
async function onRemoveModel(m) {
  if (!m || m.id == null) return
  try {
    await ElMessageBox.confirm(`确认删除模型「${m.model}」吗？`, '删除模型', { type: 'warning' })
    emit('remove-model', m.id)
  } catch { /* cancelled */ }
}

function onAdd() {
  // Validation + payload shape (incl. optional seed-model parsing) live in the
  // tested pure helper; the component stays a thin view.
  const err = validateProviderDraft(draft)
  if (err) return ElMessage.warning(err)
  // payload.models is always an array (possibly empty); the orchestrator seeds
  // each model after the key is created, then refreshes the catalog.
  emit('add', buildProviderPayload(draft))
  draft.provider = ''
  draft.displayName = ''
  draft.key = ''
  draft.models = ''
  draft.baseUrl = ''
  draft.apiFormat = ''
  draft.endpoint = ''
  presetId.value = ''
}

// Add a model directly from a provider's key group — answers "for this key, add
// a model" right where the user manages keys (the orchestrator prompts for the
// id and calls the per-user models API). Tied to the provider (a provider's
// keys share its model list), consistent with the catalog's by-provider pivot.
function onAddModel(provider) {
  emit('add-model', provider)
}

// Open the interactive config wizard. "新增" starts blank; "编辑 / 测试" prefills
// from the group's primary key entry (the row carrying baseUrl/apiFormat) so the
// user can test the connection, import discovered models, rotate the key, or even
// rename the provider — all from one dialog. The parent owns the dialog host.
function onOpenWizard() {
  emit('open-config', { mode: 'add', provider: '', entry: null })
}
function onEditProvider(g) {
  const entry = (g.entries && g.entries[0]) || null
  emit('open-config', { mode: 'edit', provider: g.provider, entry })
}

function onRemoveEntry(id) {
  emit('remove-entry', id)
}

// Replace a single key in place via an inline input (no popup). `editingId`
// tracks which entry is in edit mode; `editValue` holds the typed new key.
const editingId = ref(null)
const editValue = ref('')
const editInputRef = ref(null)

function onReplaceEntry(entry) {
  editingId.value = entry.id
  editValue.value = ''
  // Focus the input once it renders. A ref inside v-for may resolve to an array;
  // only one entry is ever in edit mode, so pick the first live instance.
  nextTick(() => {
    const r = editInputRef.value
    const el = Array.isArray(r) ? r.find(Boolean) : r
    if (el && typeof el.focus === 'function') el.focus()
  })
}

function onCancelReplace() {
  editingId.value = null
  editValue.value = ''
}

function onConfirmReplace(entry) {
  const key = editValue.value.trim()
  if (!key) return ElMessage.warning('请输入新的 API Key')
  emit('replace-entry', { id: entry.id, key })
  onCancelReplace()
}

async function onRemoveProvider(provider) {
  try {
    await ElMessageBox.confirm(`确认删除 provider「${provider}」的全部密钥吗？`, '删除整组', { type: 'warning' })
    emit('remove-provider', provider)
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
.gw-group-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.gw-group-actions { display: flex; align-items: center; gap: 2px; }
.gw-group-name { font-weight: 600; color: var(--khy-text-strong); font-size: 14px; }
.gw-group-alias { color: var(--khy-text-muted); font-weight: 400; }
.gw-entry { padding: 7px 10px; border: 1px solid var(--khy-border-light); border-radius: var(--khy-radius-sm); margin-bottom: 6px; }
.gw-entry-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.gw-entry-edit { flex: 1; min-width: 0; }
.gw-entry-meta { display: flex; align-items: center; gap: 10px; min-width: 0; }
.gw-entry-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.gw-entry-key { font-family: var(--khy-font-mono, monospace); font-size: 12px; color: var(--khy-text-main); }
.gw-entry-label { color: var(--khy-text-muted); font-size: 12px; }
/* Model branch tree under each key. */
.gw-branches { list-style: none; margin: 6px 0 0; padding: 0 0 0 4px; }
.gw-branch { display: flex; align-items: center; gap: 8px; padding: 2px 0; min-width: 0; }
.gw-branch-tee { font-family: var(--khy-font-mono, monospace); color: var(--khy-text-muted); user-select: none; }
.gw-branch-model { font-family: var(--khy-font-mono, monospace); font-size: 12px; color: var(--khy-text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-branch-cap { flex-shrink: 0; }
.gw-branch-x { padding: 0 4px; min-height: auto; font-size: 14px; line-height: 1; }
.gw-branch.is-off .gw-branch-model { color: var(--khy-text-muted); text-decoration: line-through; }
.gw-branch-empty { color: var(--khy-text-muted); font-size: 12px; }
@media (max-width: 640px) { .gw-form-row { flex-direction: column; gap: 0; } }
</style>
