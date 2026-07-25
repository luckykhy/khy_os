<template>
  <el-dialog
    :model-value="visible"
    :title="mode === 'edit' ? '编辑供应商 / 密钥' : '新增供应商 / 密钥'"
    width="560px"
    :close-on-click-modal="false"
    append-to-body
    @update:model-value="(v) => emit('update:visible', v)"
    @open="syncFromProps"
  >
    <el-form label-position="top" class="pcd-form">
      <!-- Preset picker (add mode only): auto-fills provider/baseUrl/apiFormat so
           a common provider is one click away; everything stays editable. -->
      <el-form-item v-if="mode === 'add' && presets.length" label="供应商预设（选一个自动填充，仍可改）">
        <el-select v-model="presetId" placeholder="自定义 / 选择常见供应商" clearable @change="onPickPreset">
          <el-option label="自定义" value="" />
          <el-option v-for="p in presets" :key="p.id" :label="p.label || p.id" :value="p.id" />
        </el-select>
        <ProviderLinks v-if="selectedLinks" :links="selectedLinks" />
      </el-form-item>

      <div class="pcd-row">
        <el-form-item label="Provider" required class="pcd-flex">
          <el-input v-model="form.provider" placeholder="如 openai / deepseek / acme" />
          <div v-if="mode === 'edit'" class="pcd-hint">改名将把该供应商下的模型一并迁移到新名下</div>
        </el-form-item>
        <el-form-item label="显示名（可选）" class="pcd-flex">
          <el-input v-model="form.displayName" placeholder="Acme Cloud" />
        </el-form-item>
      </div>

      <el-form-item label="API Key" :required="mode === 'add'">
        <el-input
          v-model="form.key"
          type="password"
          show-password
          autocomplete="new-password"
          :placeholder="mode === 'edit' ? '留空表示不修改现有 Key' : keyPlaceholder"
        />
      </el-form-item>

      <div class="pcd-row">
        <el-form-item label="Base URL（可选）" class="pcd-flex">
          <el-input v-model="form.baseUrl" placeholder="https://api.example.com/v1" />
        </el-form-item>
        <el-form-item label="接口格式" class="pcd-flex">
          <el-select v-model="form.apiFormat" placeholder="默认 OpenAI 兼容" clearable>
            <el-option v-for="f in API_FORMATS" :key="f.value" :label="f.label" :value="f.value" />
          </el-select>
        </el-form-item>
      </div>

      <el-form-item label="模型（可输入回车添加，或用下方「测试连接」自动发现）">
        <el-select
          v-model="form.models"
          multiple
          filterable
          allow-create
          default-first-option
          :reserve-keyword="false"
          placeholder="如 deepseek-chat、gpt-4o-mini"
          class="pcd-models"
        >
          <el-option v-for="m in form.models" :key="m" :label="m" :value="m" />
        </el-select>
      </el-form-item>

      <!-- Test connection: a dry-run probe of the current config (never persists).
           On success the discovered models can be imported into the tag list. -->
      <div class="pcd-test">
        <el-button :loading="testing" @click="onTest">测试连接</el-button>
        <span v-if="testState === 'ok'" class="pcd-test-ok">
          ✓ 连接成功，发现 {{ discovered.length }} 个模型
        </span>
        <span v-else-if="testState === 'empty'" class="pcd-test-warn">
          ✓ 连接可用，但该上游未返回模型列表（可手动填写）
        </span>
        <span v-else-if="testState === 'fail'" class="pcd-test-fail">✗ {{ testError }}</span>
      </div>

      <div v-if="discovered.length" class="pcd-discovered">
        <div class="pcd-discovered-head">
          <span>发现的模型</span>
          <el-button text type="primary" size="small" @click="importAllDiscovered">全部导入</el-button>
        </div>
        <div class="pcd-discovered-tags">
          <el-tag
            v-for="d in discovered"
            :key="d.id"
            :type="form.models.includes(d.id) ? 'success' : 'info'"
            effect="plain"
            class="pcd-disc-tag"
            @click="importOneDiscovered(d.id)"
          >
            {{ d.id }}
            <span v-if="capLabel(d.capability)" class="pcd-disc-cap">· {{ capLabel(d.capability) }}</span>
            <span class="pcd-disc-add">{{ form.models.includes(d.id) ? '✓' : '+' }}</span>
          </el-tag>
        </div>
      </div>
    </el-form>

    <template #footer>
      <el-button @click="emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="busy" @click="onSubmit">
        {{ mode === 'edit' ? '保存修改' : '创建' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { reactive, ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import ProviderLinks from './ProviderLinks.vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  // 'add' opens a blank form; 'edit' prefills from `entry` + `initialModels`.
  mode: { type: String, default: 'add' },
  // The provider entry being edited (id/provider/displayName/baseUrl/apiFormat/...).
  entry: { type: Object, default: null },
  // Current models for the edited provider ({ model } rows or plain id strings).
  initialModels: { type: Array, default: () => [] },
  presets: { type: Array, default: () => [] },
  // Async dry-run tester: (payload) => { ok, count, models:[{id,capability}], error }.
  tester: { type: Function, default: null },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['update:visible', 'submit'])

// Supported upstream interface formats (single source — mirrors the backend's
// API_FORMATS in userGatewayConfigService).
const API_FORMATS = [
  { value: 'openai', label: 'OpenAI 兼容 (/v1)' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'gemini', label: 'Google Gemini' },
]

const CAP_LABELS = { text: '文本', audio: '语音', image: '图片', video: '视频' }
function capLabel(c) { return CAP_LABELS[c] || (c && c !== 'text' ? c : '') }

const form = reactive({ provider: '', displayName: '', key: '', baseUrl: '', apiFormat: '', endpoint: '', models: [] })
const presetId = ref('')

// Test-connection state (reset on every open / re-test).
const testing = ref(false)
const testState = ref('') // '' | 'ok' | 'empty' | 'fail'
const testError = ref('')
const discovered = ref([]) // [{ id, capability }]

// Normalize the initialModels prop (rows or strings) to a de-duplicated id list.
function modelIds(list) {
  const out = []
  const seen = new Set()
  for (const m of Array.isArray(list) ? list : []) {
    const id = String((m && (m.model ?? m.id)) ?? m ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

// Reset the form from props whenever the dialog opens, so add/edit never leaks
// stale state between openings.
function syncFromProps() {
  presetId.value = ''
  testing.value = false
  testState.value = ''
  testError.value = ''
  discovered.value = []
  if (props.mode === 'edit' && props.entry) {
    form.provider = props.entry.provider || ''
    form.displayName = props.entry.displayName || ''
    form.key = '' // never prefill the secret; empty means "keep current"
    form.baseUrl = props.entry.baseUrl || ''
    form.apiFormat = props.entry.apiFormat || ''
    form.endpoint = props.entry.endpoint || ''
    form.models = modelIds(props.initialModels)
  } else {
    form.provider = ''
    form.displayName = ''
    form.key = ''
    form.baseUrl = ''
    form.apiFormat = ''
    form.endpoint = ''
    form.models = []
  }
}

const selectedLinks = computed(() => {
  const p = props.presets.find((x) => x.id === presetId.value)
  return p && p.links && Object.keys(p.links).length ? p.links : null
})

const keyPlaceholder = computed(() => {
  const p = props.presets.find((x) => x.id === presetId.value)
  return (p && p.keyExample) ? p.keyExample : 'sk-...'
})

function onPickPreset(id) {
  const p = props.presets.find((x) => x.id === id)
  if (!p) return
  form.provider = p.id
  if (!form.displayName) form.displayName = p.label || ''
  form.baseUrl = p.baseUrl || ''
  form.apiFormat = p.apiFormat || ''
  form.endpoint = p.baseUrl || ''
}

async function onTest() {
  if (typeof props.tester !== 'function') return
  const apiKey = form.key.trim()
  // In edit mode an empty key means "reuse the stored one" — but the dry-run
  // probe can't read the stored secret, so we require a key to test.
  if (!apiKey) {
    return ElMessage.warning(props.mode === 'edit'
      ? '测试连接需要填入 API Key（留空仅用于保存时不修改）'
      : '请先填写 API Key')
  }
  if (!form.baseUrl.trim() && !form.endpoint.trim()) {
    return ElMessage.warning('请填写 Base URL 后再测试')
  }
  testing.value = true
  testState.value = ''
  testError.value = ''
  try {
    const res = await props.tester({
      baseUrl: form.baseUrl.trim(),
      endpoint: form.endpoint.trim(),
      apiKey,
      apiFormat: form.apiFormat.trim() || undefined,
    })
    const list = Array.isArray(res?.models) ? res.models : []
    discovered.value = list
    if (res?.ok) {
      testState.value = list.length ? 'ok' : 'empty'
    } else {
      testState.value = 'fail'
      testError.value = res?.error || '测试失败'
    }
  } catch (err) {
    testState.value = 'fail'
    testError.value = err?.response?.data?.message || err?.message || '测试失败'
  } finally {
    testing.value = false
  }
}

function importOneDiscovered(id) {
  if (!form.models.includes(id)) form.models.push(id)
}

function importAllDiscovered() {
  for (const d of discovered.value) {
    if (d && d.id && !form.models.includes(d.id)) form.models.push(d.id)
  }
}

function onSubmit() {
  const provider = form.provider.trim().toLowerCase()
  if (!provider) return ElMessage.warning('请填写 Provider')
  if (props.mode === 'add' && !form.key.trim()) return ElMessage.warning('请填写 API Key')

  // Emit the full desired state; the parent diffs against the current entry/models
  // (add → create + seed; edit → updateProvider + sync models by new provider name).
  emit('submit', {
    mode: props.mode,
    id: props.entry?.id ?? null,
    provider,
    displayName: form.displayName.trim(),
    key: form.key.trim(), // '' in edit mode = keep current key
    baseUrl: form.baseUrl.trim(),
    apiFormat: form.apiFormat.trim(),
    endpoint: form.endpoint.trim(),
    models: form.models.map((m) => String(m).trim()).filter(Boolean),
    initialModels: modelIds(props.initialModels),
  })
}
</script>

<style scoped>
.pcd-form { margin-top: -8px; }
.pcd-row { display: flex; gap: 14px; }
.pcd-flex { flex: 1; min-width: 0; }
.pcd-hint { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.4; margin-top: 2px; }
.pcd-models { width: 100%; }
.pcd-test { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.pcd-test-ok { font-size: 12px; color: var(--el-color-success); }
.pcd-test-warn { font-size: 12px; color: var(--el-color-warning); }
.pcd-test-fail { font-size: 12px; color: var(--el-color-danger); }
.pcd-discovered {
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--el-fill-color-lighter);
}
.pcd-discovered-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 12px; color: var(--el-text-color-secondary); }
.pcd-discovered-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.pcd-disc-tag { cursor: pointer; user-select: none; }
.pcd-disc-cap { opacity: 0.7; margin-left: 2px; }
.pcd-disc-add { margin-left: 4px; font-weight: 700; }
@media (max-width: 640px) { .pcd-row { flex-direction: column; gap: 0; } }
</style>
