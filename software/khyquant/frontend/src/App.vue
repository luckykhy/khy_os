<template>
  <GlobalErrorBoundary>
    <router-view />
  </GlobalErrorBoundary>
  <!-- PWA: offline banner (all platforms) + update prompt (web only) -->
  <OfflineIndicator />
  <PwaUpdatePrompt v-if="!isNativePlatform" />
  <!-- 🔥 全局同步通知组件 -->
  <SyncNotification />
  <FirstLaunchLoader
    :visible="showFirstLaunchLoader"
    :progress="launchProgress"
    :status-text="launchStatus"
    :step-text="launchStep"
  />
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useUserStore } from '@/stores/user'
import SyncNotification from '@/components/SyncNotification.vue'
import GlobalErrorBoundary from '@/components/GlobalErrorBoundary.vue'
import FirstLaunchLoader from '@/components/FirstLaunchLoader.vue'
import OfflineIndicator from '@/components/OfflineIndicator.vue'
import PwaUpdatePrompt from '@/components/PwaUpdatePrompt.vue'

const userStore = useUserStore()

// Detect Capacitor native shell — skip PWA SW prompt inside WebView
const isNativePlatform = computed(() => {
  try {
    // @capacitor/core sets this when running inside a native app
    return typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true
  } catch {
    return false
  }
})
const showFirstLaunchLoader = ref(false)
const launchProgress = ref(0)
const launchStatus = ref('正在准备应用资源...')
const launchStep = ref('初始化')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function updateLaunch(step, progress, statusText) {
  launchStep.value = step
  launchProgress.value = progress
  launchStatus.value = statusText
}

function runWhenIdle(task) {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    window.requestIdleCallback(() => task().catch(() => null), { timeout: 1200 })
    return
  }
  setTimeout(() => {
    task().catch(() => null)
  }, 80)
}

async function ensureUserInfo() {
  if (userStore.isAuthenticated() && !userStore.user) {
    try {
      await userStore.fetchUserInfo()
    } catch (error) {
      await userStore.logout({ skipRemote: true })
    }
  }
}

async function preloadCriticalChunks() {
  await import('@/views/Dashboard.vue').catch(() => null)
}

function preloadNonCriticalChunks() {
  runWhenIdle(async () => {
    await Promise.all([
      import('@/views/Trading.vue'),
      import('@/components/TradingAgentsBotSimple.vue')
    ])
  })
}

async function runLaunchSequence() {
  const firstLaunch = localStorage.getItem('khy_first_launch_done') !== 'true'
  if (!firstLaunch) return

  showFirstLaunchLoader.value = true
  updateLaunch('读取配置', 12, '正在读取本地配置与网络模式...')
  await sleep(100)

  updateLaunch('预热页面', 34, '正在预加载核心页面...')
  await preloadCriticalChunks()
  await sleep(80)

  updateLaunch('恢复登录', 62, '正在恢复账号状态...')
  await ensureUserInfo()
  await sleep(90)

  updateLaunch('完成', 100, '资源加载完成，正在进入系统...')
  localStorage.setItem('khy_first_launch_done', 'true')
  await sleep(120)
  showFirstLaunchLoader.value = false

  // 非关键模块放到空闲时预热，减少首启阻塞
  preloadNonCriticalChunks()
}

// 应用启动时获取用户信息
onMounted(async () => {
  await runLaunchSequence()
  await ensureUserInfo()
  preloadNonCriticalChunks()

  window.dispatchEvent(new Event('khy-app-ready'))
})
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html,
body,
#app {
  width: 100%;
  overflow-x: hidden;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background-color: #f5f7fa;
}

#app {
  min-height: 100vh;
}
</style>
