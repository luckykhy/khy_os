<template>
  <Transition name="offline-bar">
    <div v-if="!isOnline" class="offline-bar">
      <svg class="offline-bar__icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
        <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4c-1.48 0-2.85.43-4.01 1.17l1.46 1.46C10.21 6.23 11.08 6 12 6c3.04 0 5.5 2.46 5.5 5.5v.5H19c1.66 0 3 1.34 3 3 0 1.13-.64 2.11-1.56 2.62l1.45 1.45C23.16 18.16 24 16.68 24 15c0-2.64-2.05-4.78-4.65-4.96zM3 5.27l2.75 2.74C2.56 8.15 0 10.77 0 14c0 3.31 2.69 6 6 6h11.73l2 2 1.27-1.27L4.27 4 3 5.27zM7.73 10l8 8H6c-2.21 0-4-1.79-4-4s1.79-4 4-4h1.73z"/>
      </svg>
      <span>当前无网络连接，部分功能可能不可用</span>
    </div>
  </Transition>
</template>

<script setup>
import { useOnlineStatus } from '@/composables/useOnlineStatus'

const { isOnline } = useOnlineStatus()
</script>

<style scoped>
.offline-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 16px;
  background: #e6a23c;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  text-align: center;
}

.offline-bar__icon {
  flex-shrink: 0;
}

/* Transition */
.offline-bar-enter-active,
.offline-bar-leave-active {
  transition: all 0.3s ease;
}

.offline-bar-enter-from,
.offline-bar-leave-to {
  opacity: 0;
  transform: translateY(-100%);
}
</style>
