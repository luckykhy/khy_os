<template>
  <!-- text -->
  <el-input
    v-if="field.widget === 'text' || field.widget === 'var-ref'"
    :model-value="modelValue"
    :placeholder="field.widget === 'var-ref' ? '变量名' : ''"
    size="small"
    @update:model-value="emitValue"
  />

  <!-- textarea -->
  <el-input
    v-else-if="field.widget === 'textarea'"
    :model-value="modelValue"
    type="textarea"
    :autosize="{ minRows: 2, maxRows: 8 }"
    size="small"
    @update:model-value="emitValue"
  />

  <!-- number -->
  <el-input-number
    v-else-if="field.widget === 'number'"
    :model-value="Number(modelValue) || 0"
    :min="0"
    size="small"
    controls-position="right"
    style="width: 100%"
    @update:model-value="emitValue"
  />

  <!-- select -->
  <el-select
    v-else-if="field.widget === 'select'"
    :model-value="modelValue"
    size="small"
    style="width: 100%"
    @update:model-value="emitValue"
  >
    <el-option v-for="opt in field.options || []" :key="opt" :label="opt" :value="opt" />
  </el-select>

  <!-- code (JSON object or raw source) -->
  <div v-else-if="field.widget === 'code'" class="nf-code">
    <el-input
      :model-value="codeText"
      type="textarea"
      :autosize="{ minRows: 3, maxRows: 14 }"
      size="small"
      spellcheck="false"
      :class="{ 'nf-code--invalid': codeInvalid }"
      @update:model-value="onCodeInput"
    />
    <span v-if="codeInvalid" class="nf-code__warn">JSON 格式无效（暂未保存该字段）</span>
  </div>

  <!-- string-list -->
  <div v-else-if="field.widget === 'string-list'" class="nf-list">
    <div v-for="(item, i) in listValue" :key="i" class="nf-list__row">
      <el-input
        :model-value="item"
        size="small"
        @update:model-value="(v) => updateListItem(i, v)"
      />
      <el-button :icon="Delete" size="small" text @click="removeListItem(i)" />
    </div>
    <el-button :icon="Plus" size="small" text @click="addListItem">添加</el-button>
  </div>

  <!-- keyvalue-list -->
  <div v-else-if="field.widget === 'keyvalue-list'" class="nf-list">
    <div v-for="(row, i) in kvValue" :key="i" class="nf-list__row">
      <el-input
        :model-value="row.key"
        size="small"
        placeholder="键"
        @update:model-value="(v) => updateKv(i, 'key', v)"
      />
      <el-input
        :model-value="row.value"
        size="small"
        placeholder="值"
        @update:model-value="(v) => updateKv(i, 'value', v)"
      />
      <el-button :icon="Delete" size="small" text @click="removeKv(i)" />
    </div>
    <el-button :icon="Plus" size="small" text @click="addKv">添加</el-button>
  </div>

  <!-- fallback -->
  <el-input v-else :model-value="modelValue" size="small" @update:model-value="emitValue" />
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { Delete, Plus } from '@element-plus/icons-vue'

const props = defineProps({
  field: { type: Object, required: true },
  modelValue: { default: null },
})
const emit = defineEmits(['update:modelValue'])

function emitValue(v) {
  emit('update:modelValue', v)
}

// ── code widget (JSON object <-> text) ──────────────────────────────────────
const isJson = computed(() => (props.field.language || '') === 'json')
const codeInvalid = ref(false)
const codeText = ref('')

function syncCodeText() {
  if (isJson.value) {
    try {
      codeText.value = JSON.stringify(props.modelValue ?? {}, null, 2)
    } catch {
      codeText.value = ''
    }
  } else {
    codeText.value = props.modelValue == null ? '' : String(props.modelValue)
  }
  codeInvalid.value = false
}
watch(() => props.modelValue, syncCodeText, { immediate: true })

function onCodeInput(text) {
  codeText.value = text
  if (isJson.value) {
    try {
      const parsed = JSON.parse(text || '{}')
      codeInvalid.value = false
      emitValue(parsed)
    } catch {
      codeInvalid.value = true // keep typing; don't persist malformed JSON
    }
  } else {
    emitValue(text)
  }
}

// ── string-list ─────────────────────────────────────────────────────────────
const listValue = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []))
function addListItem() { emitValue([...listValue.value, '']) }
function updateListItem(i, v) {
  const next = listValue.value.slice()
  next[i] = v
  emitValue(next)
}
function removeListItem(i) { emitValue(listValue.value.filter((_, idx) => idx !== i)) }

// ── keyvalue-list ───────────────────────────────────────────────────────────
const kvValue = computed(() =>
  (Array.isArray(props.modelValue) ? props.modelValue : []).map((r) =>
    r && typeof r === 'object' ? { key: r.key ?? '', value: r.value ?? '' } : { key: '', value: '' },
  ),
)
function addKv() { emitValue([...kvValue.value, { key: '', value: '' }]) }
function updateKv(i, k, v) {
  const next = kvValue.value.map((row) => ({ ...row }))
  next[i][k] = v
  emitValue(next)
}
function removeKv(i) { emitValue(kvValue.value.filter((_, idx) => idx !== i)) }
</script>

<style scoped>
.nf-list { display: flex; flex-direction: column; gap: 6px; }
.nf-list__row { display: flex; gap: 6px; align-items: center; }
.nf-code__warn { display: block; margin-top: 4px; font-size: 11px; color: var(--el-color-danger); }
.nf-code :deep(textarea) { font-family: var(--el-font-family-mono, monospace); font-size: 12px; }
.nf-code--invalid :deep(textarea) { border-color: var(--el-color-danger); }
</style>
