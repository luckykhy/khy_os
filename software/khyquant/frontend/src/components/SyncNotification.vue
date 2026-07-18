<template>
  <transition name="slide-fade">
    <div v-if="visible" class="sync-notification" :class="notificationClass">
      <div class="notification-icon">
        <el-icon v-if="type === 'loading'" class="rotating"><Loading /></el-icon>
        <el-icon v-else-if="type === 'success'"><CircleCheck /></el-icon>
        <el-icon v-else-if="type === 'warning'"><Warning /></el-icon>
        <el-icon v-else-if="type === 'error'"><CircleClose /></el-icon>
        <el-icon v-else><InfoFilled /></el-icon>
      </div>
      
      <div class="notification-content">
        <div class="notification-title">{{ title }}</div>
        <div class="notification-message">{{ message }}</div>
        <div v-if="details" class="notification-details">{{ details }}</div>
      </div>
      
      <el-icon class="notification-close" @click="close"><Close /></el-icon>
    </div>
  </transition>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Loading, CircleCheck, Warning, CircleClose, InfoFilled, Close } from '@element-plus/icons-vue'
import websocketService from '@/services/websocketService'

const visible = ref(false)
const type = ref('info') // loading, success, warning, error, info
const title = ref('')
const message = ref('')
const details = ref('')
let autoCloseTimer = null

const notificationClass = computed(() => {
  return `notification-${type.value}`
})

// Show notification
function show(options) {
  type.value = options.type || 'info'
  title.value = options.title || '通知'
  message.value = options.message || ''
  details.value = options.details || ''
  visible.value = true

  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer)
  }

  if (type.value !== 'loading') {
    const duration = options.duration || 5000
    autoCloseTimer = setTimeout(() => {
      close()
    }, duration)
  }
}

// Close notification
function close() {
  visible.value = false
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer)
    autoCloseTimer = null
  }
}

// Handle instrument sync notification from shared WebSocket
function handleSyncNotification(data) {
  const syncData = data.data
  if (!syncData) return

  switch (syncData.type) {
    case 'sync_start':
      show({
        type: 'loading',
        title: '数据同步',
        message: syncData.message,
        details: `第 ${syncData.syncCount} 次同步`
      })
      break

    case 'sync_success':
      show({
        type: 'success',
        title: '同步成功',
        message: syncData.message,
        details: `总计 ${syncData.totalInstruments} 个标的,新增 ${syncData.newInstruments} 个`,
        duration: 4000
      })
      break

    case 'sync_complete':
      show({
        type: 'success',
        title: '同步完成',
        message: syncData.message,
        details: `总计 ${syncData.totalInstruments} 个标的`,
        duration: 3000
      })
      break

    case 'sync_warning':
      show({
        type: 'warning',
        title: '同步警告',
        message: syncData.message,
        duration: 4000
      })
      break

    case 'sync_error':
      show({
        type: 'error',
        title: '同步失败',
        message: syncData.message,
        details: syncData.error,
        duration: 6000
      })
      break
  }
}

onMounted(() => {
  // Listen to instrument_sync events from the shared WebSocket singleton
  websocketService.on('instrument_sync', handleSyncNotification)
})

onUnmounted(() => {
  websocketService.off('instrument_sync', handleSyncNotification)
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer)
  }
})

// 暴露方法供外部调用
defineExpose({
  show,
  close
})
</script>

<style scoped>
.sync-notification {
  position: fixed;
  top: 80px;
  right: 20px;
  min-width: 320px;
  max-width: 400px;
  background: white;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  padding: 16px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  z-index: 9999;
  transition: all 0.3s ease;
}

.sync-notification:hover {
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
}

.notification-icon {
  font-size: 24px;
  flex-shrink: 0;
}

.notification-loading .notification-icon {
  color: #409eff;
}

.notification-success .notification-icon {
  color: #67c23a;
}

.notification-warning .notification-icon {
  color: #e6a23c;
}

.notification-error .notification-icon {
  color: #f56c6c;
}

.notification-info .notification-icon {
  color: #909399;
}

.notification-content {
  flex: 1;
  min-width: 0;
}

.notification-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 4px;
}

.notification-message {
  font-size: 14px;
  color: #606266;
  margin-bottom: 4px;
}

.notification-details {
  font-size: 12px;
  color: #909399;
}

.notification-close {
  font-size: 16px;
  color: #909399;
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.2s;
}

.notification-close:hover {
  color: #606266;
}

.rotating {
  animation: rotate 1s linear infinite;
}

@keyframes rotate {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* 动画效果 */
.slide-fade-enter-active {
  transition: all 0.3s ease;
}

.slide-fade-leave-active {
  transition: all 0.3s ease;
}

.slide-fade-enter-from {
  transform: translateX(100%);
  opacity: 0;
}

.slide-fade-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .sync-notification {
    top: 60px;
    right: 10px;
    left: 10px;
    min-width: auto;
    max-width: none;
  }
}
</style>
