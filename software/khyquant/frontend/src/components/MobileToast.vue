<template>
  <Transition name="toast-fade">
    <div
      v-if="visible"
      class="mobile-toast"
      :class="[`toast-${type}`, { 'toast-important': important }]"
      @click="handleClick"
    >
      <div class="toast-icon">
        <el-icon v-if="type === 'success'"><CircleCheck /></el-icon>
        <el-icon v-else-if="type === 'error'"><CircleClose /></el-icon>
        <el-icon v-else-if="type === 'warning'"><Warning /></el-icon>
        <el-icon v-else><InfoFilled /></el-icon>
      </div>
      
      <div class="toast-content">
        <p class="toast-message">{{ message }}</p>
        <p v-if="description" class="toast-description">{{ description }}</p>
      </div>
      
      <button v-if="important" class="toast-close" @click.stop="close">
        <el-icon><Close /></el-icon>
      </button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { CircleCheck, CircleClose, Warning, InfoFilled, Close } from '@element-plus/icons-vue'

interface Props {
  message: string
  description?: string
  type?: 'success' | 'error' | 'warning' | 'info'
  duration?: number
  important?: boolean
  vibrate?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  type: 'info',
  duration: 3000,
  important: false,
  vibrate: true
})

const emit = defineEmits<{
  'close': []
}>()

const visible = ref(false)
let timer: number | null = null

// 显示Toast
const show = () => {
  visible.value = true
  
  // 触觉反馈
  if (props.vibrate && navigator.vibrate) {
    if (props.type === 'error') {
      navigator.vibrate([50, 50, 50]) // 三次短震动
    } else if (props.type === 'warning') {
      navigator.vibrate([50, 30, 50]) // 两次短震动
    } else {
      navigator.vibrate(50) // 单次短震动
    }
  }
  
  // 自动关闭（重要提示除外）
  if (!props.important && props.duration > 0) {
    timer = window.setTimeout(() => {
      close()
    }, props.duration)
  }
}

// 关闭Toast
const close = () => {
  visible.value = false
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  emit('close')
}

// 点击处理
const handleClick = () => {
  if (props.important) {
    // 重要提示需要手动确认
    return
  }
  close()
}

// 组件挂载时显示
onMounted(() => {
  show()
})

// 监听message变化，重新显示
watch(() => props.message, () => {
  if (visible.value) {
    close()
    setTimeout(() => {
      show()
    }, 100)
  }
})

defineExpose({
  show,
  close
})
</script>

<style scoped>
.mobile-toast {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  min-width: 280px;
  max-width: 90vw;
  background: rgba(0, 0, 0, 0.9);
  backdrop-filter: blur(10px);
  border-radius: var(--radius-lg);
  padding: 20px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  z-index: 9999;
  cursor: pointer;
  user-select: none;
}

.mobile-toast.toast-important {
  cursor: default;
  min-height: 120px;
}

/* Toast类型样式 */
.toast-success {
  border: 2px solid #67c23a;
}

.toast-success .toast-icon {
  color: #67c23a;
}

.toast-error {
  border: 2px solid #f56c6c;
}

.toast-error .toast-icon {
  color: #f56c6c;
}

.toast-warning {
  border: 2px solid #e6a23c;
}

.toast-warning .toast-icon {
  color: #e6a23c;
}

.toast-info {
  border: 2px solid #409eff;
}

.toast-info .toast-icon {
  color: #409eff;
}

/* Toast图标 */
.toast-icon {
  font-size: 32px;
  flex-shrink: 0;
  margin-top: 2px;
}

/* Toast内容 */
.toast-content {
  flex: 1;
  min-width: 0;
}

.toast-message {
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  margin: 0 0 4px 0;
  line-height: 1.5;
  word-wrap: break-word;
}

.toast-description {
  font-size: 14px;
  color: #ccc;
  margin: 0;
  line-height: 1.5;
  word-wrap: break-word;
}

/* 关闭按钮 */
.toast-close {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 50%;
  color: #fff;
  font-size: 18px;
  cursor: pointer;
  transition: background 0.2s;
}

.toast-close:active {
  background: rgba(255, 255, 255, 0.2);
  transform: scale(0.9);
}

/* 过渡动画 */
.toast-fade-enter-active {
  animation: toast-in 0.3s ease-out;
}

.toast-fade-leave-active {
  animation: toast-out 0.2s ease-in;
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.8);
  }
  to {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
}

@keyframes toast-out {
  from {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
  to {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.8);
  }
}

/* 小屏幕优化 */
@media (max-width: 480px) {
  .mobile-toast {
    min-width: 260px;
    padding: 16px;
  }
  
  .toast-icon {
    font-size: 28px;
  }
  
  .toast-message {
    font-size: 15px;
  }
  
  .toast-description {
    font-size: 13px;
  }
}
</style>
