<template>
  <Transition name="pwa-toast">
    <div v-if="needRefresh" class="pwa-update-toast">
      <span class="pwa-update-text">发现新版本，更新后体验更佳</span>
      <div class="pwa-update-actions">
        <button class="pwa-btn pwa-btn--later" @click="close">稍后</button>
        <button class="pwa-btn pwa-btn--update" @click="updateServiceWorker(true)">
          立即更新
        </button>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { useRegisterSW } from 'virtual:pwa-register/vue'

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000 // 60 minutes

const {
  needRefresh,
  updateServiceWorker,
} = useRegisterSW({
  onRegisteredSW(swUrl, registration) {
    if (!registration) return
    // Periodically check for SW updates
    setInterval(() => {
      registration.update()
    }, UPDATE_CHECK_INTERVAL_MS)
  },
  onRegisterError(error) {
    console.error('SW registration error:', error)
  },
})

function close() {
  needRefresh.value = false
}
</script>

<style scoped>
.pwa-update-toast {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10000;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 20px;
  background: #303133;
  color: #fff;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  font-size: 14px;
  max-width: 480px;
  width: calc(100% - 40px);
}

.pwa-update-text {
  flex: 1;
}

.pwa-update-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.pwa-btn {
  border: none;
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.pwa-btn:hover {
  opacity: 0.85;
}

.pwa-btn--later {
  background: transparent;
  color: #909399;
}

.pwa-btn--update {
  background: #409eff;
  color: #fff;
}

/* Transition */
.pwa-toast-enter-active,
.pwa-toast-leave-active {
  transition: all 0.3s ease;
}

.pwa-toast-enter-from,
.pwa-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(20px);
}
</style>
