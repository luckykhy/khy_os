<template>
  <div v-if="hasError" class="global-error-boundary">
    <el-result
      icon="error"
      title="页面加载出现问题"
      sub-title="系统已捕获异常，请点击重试恢复页面。"
    >
      <template #extra>
        <el-button type="primary" @click="handleRetry">重试</el-button>
      </template>
    </el-result>
  </div>
  <slot v-else />
</template>

<script setup>
import { onErrorCaptured, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getFriendlyErrorMessage } from '@/utils/errorMessage'

const hasError = ref(false)

onErrorCaptured((error) => {
  hasError.value = true
  ElMessage.error(getFriendlyErrorMessage(error, '页面渲染异常，请重试'))
  return false
})

function handleRetry() {
  hasError.value = false
  window.location.reload()
}
</script>

<style scoped>
.global-error-boundary {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: #f5f7fa;
}
</style>
