<template>
  <el-card class="gw-card" shadow="never">
    <template #header>
      <div class="gw-card-head">
        <div class="gw-card-title">
          <el-icon><PictureFilled /></el-icon>
          <span>图像生成模型</span>
        </div>
        <el-tag size="small" effect="light" :type="isAuto ? 'info' : 'success'">
          {{ isAuto ? '自动' : '已指定' }}
        </el-tag>
      </div>
    </template>

    <p class="gw-card-desc">
      选择文生图 / 绘图使用的模型。留空（自动）时按可用后端的固定优先级自动选择：{{ autoOrderText }}。
    </p>

    <el-form label-position="top">
      <el-form-item label="图像模型">
        <el-select
          :model-value="selectValue"
          :loading="busy"
          placeholder="自动选择"
          style="width: 100%"
          @change="onChange"
        >
          <el-option label="自动（自动选择可用且效果好的）" value="auto" />
          <el-option
            v-for="opt in mergedOptions"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
      </el-form-item>
    </el-form>

    <div v-if="!mergedOptions.length" class="gw-empty">
      未检测到已配置的图像后端。请先在网关中配置 OpenAI 兼容 / Agnes / 国内 API / 本地 SD 任一后端。
    </div>
    <div v-else class="gw-img-current">
      当前：<strong>{{ currentLabel }}</strong>
    </div>
  </el-card>
</template>

<script setup>
import { computed } from 'vue'
import { PictureFilled } from '@element-plus/icons-vue'

const props = defineProps({
  // { backend, model } — '' / 'auto' backend means auto.
  current: { type: Object, default: () => ({ backend: 'auto', model: '' }) },
  // [{ backend, model, supportsEdit }] selectable image models.
  options: { type: Array, default: () => [] },
  // Fixed auto precedence (display only).
  autoOrder: { type: Array, default: () => ['openai', 'agnes', 'domestic', 'sd_webui'] },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['update'])

const autoOrderText = computed(() => props.autoOrder.join(' > '))

const currentBackend = computed(() =>
  String(props.current?.backend || '').trim().toLowerCase())
const currentModel = computed(() => String(props.current?.model || '').trim())
const isAuto = computed(() => !currentBackend.value || currentBackend.value === 'auto')

function optValue(o) {
  return `${o.backend}::${o.model || ''}`
}
function optLabel(o) {
  return o.model ? `${o.backend} · ${o.model}` : o.backend
}

// Normalized option list; if the current pin isn't among the catalog options
// (e.g. its model env changed), surface it anyway so the UI reflects reality.
const mergedOptions = computed(() => {
  const list = (props.options || []).map((o) => ({
    backend: o.backend,
    model: o.model || '',
    value: optValue(o),
    label: optLabel(o),
  }))
  if (!isAuto.value) {
    const cur = { backend: currentBackend.value, model: currentModel.value }
    if (!list.some((o) => o.value === optValue(cur))) {
      list.unshift({ ...cur, value: optValue(cur), label: optLabel(cur) + '（当前）' })
    }
  }
  return list
})

const selectValue = computed(() =>
  isAuto.value ? 'auto' : `${currentBackend.value}::${currentModel.value}`)

const currentLabel = computed(() => {
  if (isAuto.value) return '自动选择'
  return currentModel.value ? `${currentBackend.value} · ${currentModel.value}` : currentBackend.value
})

function onChange(value) {
  if (value === 'auto') {
    emit('update', { backend: 'auto', model: '' })
    return
  }
  const idx = String(value).indexOf('::')
  const backend = idx >= 0 ? value.slice(0, idx) : value
  const model = idx >= 0 ? value.slice(idx + 2) : ''
  emit('update', { backend, model })
}
</script>

<style scoped>
.gw-img-current {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.gw-empty {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  padding: 8px 0;
}
</style>
