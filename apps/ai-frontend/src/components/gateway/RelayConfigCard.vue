<template>
  <el-card class="gw-card" shadow="never">
    <template #header>
      <div class="gw-card-head">
        <div class="gw-card-title">
          <el-icon><Connection /></el-icon>
          <span>{{ title }}</span>
        </div>
        <el-tag :type="sourceTag.type" size="small" effect="light">{{ sourceTag.label }}</el-tag>
      </div>
    </template>

    <p class="gw-card-desc">{{ description }}</p>

    <el-form label-position="top" class="gw-form">
      <el-form-item v-if="presets.length" label="供应商预设（选一个自动填充，仍可改）">
        <el-select v-model="presetId" placeholder="自定义 / 选择常见供应商" clearable @change="onPickPreset">
          <el-option label="自定义" value="" />
          <el-option v-for="p in presets" :key="p.id" :label="p.label || p.id" :value="p.id" />
        </el-select>
        <ProviderLinks v-if="selectedLinks" :links="selectedLinks" />
      </el-form-item>

      <el-form-item label="上游地址 (Base URL)" required>
        <el-input v-model="form.baseUrl" placeholder="https://your-relay.example.com/v1" />
      </el-form-item>

      <div class="gw-form-row">
        <el-form-item label="模型 ID" required class="gw-flex">
          <el-input v-model="form.modelId" placeholder="claude-sonnet-4-20250514" />
        </el-form-item>
        <el-form-item label="协议格式" class="gw-flex">
          <el-select v-model="form.apiFormat" placeholder="openai">
            <el-option v-for="f in API_FORMATS" :key="f.value" :label="f.label" :value="f.value" />
          </el-select>
        </el-form-item>
      </div>

      <el-form-item label="鉴权头字段">
        <el-select v-model="form.apiKeyField" placeholder="authorization_bearer">
          <el-option v-for="k in KEY_FIELDS" :key="k.value" :label="k.label" :value="k.value" />
        </el-select>
      </el-form-item>

      <el-form-item>
        <template #label>
          <span>API Key</span>
          <span v-if="config?.hasApiKey" class="gw-hint">（已配置：{{ config.apiKeyMasked }}，留空保持不变）</span>
          <span v-else class="gw-hint">（尚未配置）</span>
        </template>
        <el-input
          v-model="form.apiKey"
          type="password"
          show-password
          autocomplete="new-password"
          :placeholder="config?.hasApiKey ? '留空则沿用现有密钥' : 'sk-...'"
        />
      </el-form-item>

      <div class="gw-actions">
        <el-button type="primary" :loading="saving" @click="onSave">保存配置</el-button>
        <el-button
          v-if="config?.hasApiKey"
          type="danger"
          plain
          :loading="saving"
          @click="onClearKey"
        >清除密钥</el-button>
      </div>
    </el-form>
  </el-card>
</template>

<script setup>
import { reactive, ref, computed, watch } from 'vue'
import { Connection } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import ProviderLinks from './ProviderLinks.vue'

const props = defineProps({
  // 'user' for the multi-tenant page, 'global' for the admin page (future reuse).
  scope: { type: String, default: 'user' },
  config: { type: Object, default: null },
  saving: { type: Boolean, default: false },
  // Built-in common-provider presets (from useUserGateway.providerPresets).
  presets: { type: Array, default: () => [] },
})
const emit = defineEmits(['save'])

const API_FORMATS = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'gemini', label: 'Gemini' },
]
const KEY_FIELDS = [
  { value: 'authorization_bearer', label: 'Authorization: Bearer' },
  { value: 'x-api-key', label: 'x-api-key' },
  { value: 'x-goog-api-key', label: 'x-goog-api-key' },
]

const isUser = computed(() => props.scope !== 'global')
const title = computed(() => (isUser.value ? '我的上游中转' : '全局上游中转'))
const description = computed(() => (isUser.value
  ? '配置你自己的第三方 Claude/OpenAI 中转上游。CC 客户端请求会在运行时路由到这里，与他人完全隔离。'
  : '全局默认上游，未配置 per-user 上游的请求回落到此。'))

const sourceTag = computed(() => {
  if (props.config?.source === 'user') return { type: 'success', label: '已配置' }
  if (props.config?.source === 'global') return { type: 'info', label: '全局' }
  return { type: 'info', label: '未配置' }
})

const form = reactive({
  baseUrl: '',
  modelId: '',
  apiFormat: 'openai',
  apiKeyField: 'authorization_bearer',
  apiKey: '',
})

const presetId = ref('')

// Links of the currently picked preset (home/console/docs), surfaced so the user
// knows where to obtain a key. null when no preset is selected or it has none.
const selectedLinks = computed(() => {
  const p = props.presets.find((x) => x.id === presetId.value)
  return p && p.links && Object.keys(p.links).length ? p.links : null
})

// Picking a preset only fills the form; every field stays editable and the key
// is always supplied by the user (presets are key-less).
function onPickPreset(id) {
  const p = props.presets.find((x) => x.id === id)
  if (!p) return
  form.baseUrl = p.baseUrl || ''
  if (p.defaultModel) form.modelId = p.defaultModel
  if (p.apiFormat) form.apiFormat = p.apiFormat
  if (p.keyField) form.apiKeyField = p.keyField
}

watch(() => props.config, (cfg) => {
  if (!cfg) return
  form.baseUrl = cfg.baseUrl || ''
  form.modelId = cfg.modelId || ''
  form.apiFormat = cfg.apiFormat || 'openai'
  form.apiKeyField = cfg.apiKeyField || 'authorization_bearer'
  form.apiKey = '' // never prefill secrets
}, { immediate: true })

function onSave() {
  if (!form.baseUrl.trim()) return ElMessage.warning('请填写上游地址')
  if (!form.modelId.trim()) return ElMessage.warning('请填写模型 ID')
  const payload = {
    baseUrl: form.baseUrl.trim(),
    modelId: form.modelId.trim(),
    apiFormat: form.apiFormat,
    apiKeyField: form.apiKeyField,
  }
  if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim()
  emit('save', payload)
}

function onClearKey() {
  emit('save', {
    baseUrl: form.baseUrl.trim(),
    modelId: form.modelId.trim(),
    apiFormat: form.apiFormat,
    apiKeyField: form.apiKeyField,
    clearApiKey: true,
  })
}
</script>

<style scoped>
.gw-card { border: 1px solid var(--khy-border); border-radius: var(--khy-radius); }
.gw-card-head { display: flex; align-items: center; justify-content: space-between; }
.gw-card-title { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--khy-text-strong); }
.gw-card-desc { margin: 0 0 14px; color: var(--khy-text-secondary); font-size: 13px; line-height: 1.5; }
.gw-form-row { display: flex; gap: 14px; }
.gw-flex { flex: 1; min-width: 0; }
.gw-hint { color: var(--khy-text-muted); font-size: 12px; font-weight: 400; margin-left: 6px; }
.gw-actions { display: flex; gap: 10px; margin-top: 4px; }
@media (max-width: 640px) { .gw-form-row { flex-direction: column; gap: 0; } }
</style>
