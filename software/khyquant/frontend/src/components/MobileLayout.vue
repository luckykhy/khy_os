<template>
  <div
    class="mobile-layout"
    @touchstart="onTouchStart"
    @touchmove="onTouchMove"
    @touchend="onTouchEnd"
  >
    <!-- Drawer overlay -->
    <Transition name="fade">
      <div
        v-if="drawerOpen"
        class="drawer-overlay"
        @click="drawerOpen = false"
      />
    </Transition>

    <!-- Swipe drawer menu -->
    <div
      class="drawer-menu"
      :style="drawerStyle"
    >
      <div class="drawer-header">
        <img src="/logo.png" alt="KHY Quant" class="drawer-logo" />
        <div class="drawer-user">
          <img src="/school-badge.svg" alt="avatar" class="drawer-avatar" />
          <span class="drawer-username">{{ userStore.user?.username || '用户' }}</span>
        </div>
      </div>

      <nav class="drawer-nav">
        <div
          v-for="item in menuItems"
          :key="item.path"
          class="drawer-nav-item"
          :class="{ active: isActive(item.path) }"
          @click="navigateTo(item.path)"
        >
          <el-icon :size="22"><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </div>
      </nav>

      <div class="drawer-footer">
        <div class="drawer-mode">
          <div class="drawer-mode-title">界面模式</div>
          <div class="drawer-mode-actions">
            <button
              class="drawer-mode-btn"
              :class="{ active: viewMode === 'auto' }"
              @click="switchViewMode('auto')"
            >
              自动
            </button>
            <button
              class="drawer-mode-btn"
              :class="{ active: viewMode === 'mobile' }"
              @click="switchViewMode('mobile')"
            >
              手机版
            </button>
            <button
              class="drawer-mode-btn"
              :class="{ active: viewMode === 'desktop' }"
              @click="switchViewMode('desktop')"
            >
              电脑版
            </button>
          </div>
        </div>

        <div class="drawer-nav-item logout" @click="handleLogout">
          <el-icon :size="22"><SwitchButton /></el-icon>
          <span>退出登录</span>
        </div>
      </div>
    </div>

    <!-- Top bar -->
    <header class="mobile-top-bar">
      <div class="top-bar-left">
        <button class="hamburger-btn" @click="drawerOpen = !drawerOpen" aria-label="Menu">
          <span class="hamburger-line" />
          <span class="hamburger-line" />
          <span class="hamburger-line" />
        </button>
        <img src="/logo.png" alt="KHY" class="top-bar-logo" />
      </div>
      <div class="top-bar-right">
        <el-badge :value="notificationCount" :hidden="notificationCount === 0">
          <button class="icon-btn" @click="showNotifications" aria-label="Notifications">
            <el-icon :size="22"><Bell /></el-icon>
          </button>
        </el-badge>
        <button class="avatar-btn" @click="navigateTo('/profile')" aria-label="Profile">
          <img src="/school-badge.svg" alt="avatar" class="top-bar-avatar" />
        </button>
      </div>
    </header>

    <!-- Page content -->
    <main class="mobile-page-content">
      <slot />
    </main>

    <!-- Bottom Tab Bar -->
    <nav class="mobile-bottom-nav">
      <button
        v-for="item in bottomTabs"
        :key="item.path"
        class="bottom-tab-btn"
        :class="{ active: isActive(item.path) }"
        @click="navigateTo(item.path)"
      >
        <el-icon :size="20"><component :is="item.icon" /></el-icon>
        <span>{{ item.label }}</span>
      </button>
    </nav>

    <!-- Notification drawer -->
    <el-drawer
      v-model="notificationDrawer"
      title="通知"
      size="90%"
      direction="rtl"
    >
      <div class="notifications-list">
        <div
          v-for="notification in notifications"
          :key="notification.id"
          class="notification-item"
          @click="handleNotificationClick(notification)"
        >
          <div class="notification-icon">
            <el-icon :size="20" :color="getNotificationColor(notification.type)">
              <component :is="getNotificationIcon(notification.type)" />
            </el-icon>
          </div>
          <div class="notification-content">
            <div class="notification-title">{{ notification.title }}</div>
            <div class="notification-message">{{ notification.message }}</div>
            <div class="notification-time">{{ formatTime(notification.createdAt) }}</div>
          </div>
          <div class="notification-badge" v-if="!notification.read" />
        </div>
        <el-empty v-if="notifications.length === 0" description="暂无通知" />
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { ElMessage } from 'element-plus'
import { resolveClientMode, setClientModePreference, notifyClientModeChanged } from '@/utils/clientMode'
import {
  Bell,
  Odometer,
  TrendCharts,
  Document,
  DataAnalysis,
  ShoppingCart,
  ChatDotRound,
  DataBoard,
  Cpu,
  InfoFilled,
  UserFilled,
  SwitchButton
} from '@element-plus/icons-vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const viewMode = ref('auto')

// Drawer state
const drawerOpen = ref(false)

// Touch tracking for edge swipe
const touchStartX = ref(0)
const touchStartY = ref(0)
const touchCurrentX = ref(0)
const isSwiping = ref(false)
const EDGE_THRESHOLD = 25 // px from left edge to trigger swipe
const SWIPE_MIN = 60 // min px to open drawer
const DRAWER_WIDTH = 280

const drawerStyle = computed(() => {
  if (drawerOpen.value && !isSwiping.value) {
    return { transform: 'translateX(0)' }
  }
  if (isSwiping.value) {
    const dx = Math.max(0, Math.min(DRAWER_WIDTH, touchCurrentX.value - touchStartX.value))
    return { transform: `translateX(${dx - DRAWER_WIDTH}px)`, transition: 'none' }
  }
  return { transform: `translateX(-${DRAWER_WIDTH}px)` }
})

const onTouchStart = (e) => {
  const x = e.touches[0].clientX
  const y = e.touches[0].clientY
  touchStartX.value = x
  touchStartY.value = y
  touchCurrentX.value = x
  // Only start swipe tracking if touch begins near left edge (and drawer is closed)
  if (x < EDGE_THRESHOLD && !drawerOpen.value) {
    isSwiping.value = true
  }
  // If drawer is open, track for close swipe
  if (drawerOpen.value) {
    isSwiping.value = true
  }
}

const onTouchMove = (e) => {
  if (!isSwiping.value) return
  touchCurrentX.value = e.touches[0].clientX
}

const onTouchEnd = () => {
  if (!isSwiping.value) {
    return
  }
  const dx = touchCurrentX.value - touchStartX.value
  if (!drawerOpen.value && dx > SWIPE_MIN) {
    drawerOpen.value = true
  } else if (drawerOpen.value && dx < -SWIPE_MIN) {
    drawerOpen.value = false
  }
  isSwiping.value = false
}

// Menu items
const menuItems = [
  { path: '/dashboard', label: '主页', icon: 'Odometer' },
  { path: '/trading', label: '智能交易', icon: 'TrendCharts' },
  { path: '/strategies', label: '策略管理', icon: 'Document' },
  { path: '/backtest', label: '回测分析', icon: 'DataAnalysis' },
  { path: '/trades', label: '交易记录', icon: 'ShoppingCart' },
  { path: '/data-sources', label: '数据源', icon: 'DataBoard' },
  { path: '/agent-architecture', label: '智能体架构', icon: 'Cpu' },
  { path: '/announcements', label: '通知公告', icon: 'Bell' },
  { path: '/feedback', label: '意见反馈', icon: 'ChatDotRound' },
  { path: '/profile', label: '个人中心', icon: 'UserFilled' },
]

const bottomTabs = [
  { path: '/dashboard', label: '主页', icon: 'Odometer' },
  { path: '/trading', label: '交易', icon: 'TrendCharts' },
  { path: '/strategies', label: '策略', icon: 'Document' },
  { path: '/trades', label: '记录', icon: 'ShoppingCart' },
  { path: '/profile', label: '我的', icon: 'UserFilled' }
]

// Notifications
const notificationDrawer = ref(false)
const notificationCount = ref(3)
const notifications = ref([
  {
    id: 1, type: 'success', title: '回测完成',
    message: '策略“箱体突破”回测已结束',
    createdAt: new Date(), read: false
  },
  {
    id: 2, type: 'warning', title: '系统提醒',
    message: '账户余额偏低，请注意风险控制',
    createdAt: new Date(Date.now() - 3600000), read: false
  },
  {
    id: 3, type: 'info', title: '公告通知',
    message: '系统将于今晚 22:00 进行维护',
    createdAt: new Date(Date.now() - 7200000), read: true
  }
])

const isActive = (path) => route.path === path || route.path.startsWith(path + '/')

const navigateTo = (path) => {
  drawerOpen.value = false
  router.push(path)
}

const showNotifications = () => {
  notificationDrawer.value = true
}

const handleNotificationClick = (notification) => {
  notification.read = true
  notificationCount.value = notifications.value.filter(n => !n.read).length
}

const handleLogout = () => {
  drawerOpen.value = false
  userStore.logout()
  ElMessage.success('已退出登录')
  router.push('/login')
}

const syncViewMode = () => {
  viewMode.value = resolveClientMode().preference
}

const switchViewMode = (mode) => {
  setClientModePreference(mode)
  syncViewMode()
  drawerOpen.value = false
  notifyClientModeChanged()
  if (mode === 'auto') ElMessage.success('已切换为自动适配模式')
  else if (mode === 'mobile') ElMessage.success('已切换为手机版')
  else ElMessage.success('已切换为电脑版')
}

const getNotificationIcon = (type) => {
  const map = { success: 'SuccessFilled', warning: 'WarningFilled', error: 'CircleCloseFilled', info: 'InfoFilled' }
  return map[type] || 'InfoFilled'
}

const getNotificationColor = (type) => {
  const map = { success: '#67c23a', warning: '#e6a23c', error: '#f56c6c', info: '#409eff' }
  return map[type] || '#409eff'
}

const formatTime = (date) => {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  const hrs = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  if (hrs < 24) return `${hrs} 小时前`
  if (days < 7) return `${days} 天前`
  return new Date(date).toLocaleDateString()
}

onMounted(() => {
  syncViewMode()
  window.addEventListener('khy-client-mode-changed', syncViewMode)
})

onUnmounted(() => {
  window.removeEventListener('khy-client-mode-changed', syncViewMode)
})
</script>

<style scoped>
.mobile-layout {
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--bg-secondary, #f5f7fa);
  touch-action: manipulation;
  overflow-x: hidden;
}

/* ===== Drawer overlay ===== */
.drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 900;
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* ===== Drawer menu ===== */
.drawer-menu {
  position: fixed;
  top: 0;
  left: 0;
  width: 280px;
  height: 100%;
  height: 100dvh;
  background: linear-gradient(180deg, #1f2d3d 0%, #304156 100%);
  z-index: 950;
  transform: translateX(-280px);
  transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  flex-direction: column;
  padding-top: env(safe-area-inset-top);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.drawer-header {
  padding: 24px 20px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.drawer-logo {
  height: 28px;
  margin-bottom: 16px;
}

.drawer-user {
  display: flex;
  align-items: center;
  gap: 10px;
}

.drawer-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.3);
}

.drawer-username {
  color: #fff;
  font-size: 15px;
  font-weight: 500;
}

.drawer-nav {
  flex: 1;
  padding: 8px 0;
}

.drawer-nav-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 20px;
  color: rgba(255, 255, 255, 0.75);
  font-size: 15px;
  cursor: pointer;
  min-height: 48px;
  transition: background 0.2s;
}

.drawer-nav-item:active {
  background: rgba(255, 255, 255, 0.12);
}

.drawer-nav-item.active {
  color: #409eff;
  background: rgba(64, 158, 255, 0.15);
  border-right: 3px solid #409eff;
}

.drawer-nav-item.logout {
  color: rgba(255, 100, 100, 0.85);
}

.drawer-footer {
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  padding-bottom: env(safe-area-inset-bottom);
}

.drawer-mode {
  padding: 12px 20px 8px;
}

.drawer-mode-title {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 8px;
}

.drawer-mode-actions {
  display: flex;
  gap: 8px;
}

.drawer-mode-btn {
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.85);
  border-radius: 999px;
  font-size: 12px;
  padding: 6px 10px;
  min-height: 32px;
}

.drawer-mode-btn.active {
  background: rgba(64, 158, 255, 0.22);
  border-color: rgba(64, 158, 255, 0.65);
  color: #9bc9ff;
}

/* ===== Top bar ===== */
.mobile-top-bar {
  position: sticky;
  top: 0;
  z-index: 200;
  height: 56px;
  padding-top: env(safe-area-inset-top);
  background: linear-gradient(135deg, #304156 0%, #1f2d3d 100%);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-left: 12px;
  padding-right: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.top-bar-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.hamburger-btn {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  width: 44px;
  height: 44px;
  padding: 10px;
  background: none;
  border: none;
  cursor: pointer;
}

.hamburger-line {
  display: block;
  width: 22px;
  height: 2px;
  background: #fff;
  border-radius: 1px;
}

.top-bar-logo {
  height: 26px;
}

.top-bar-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.icon-btn {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.85);
  border-radius: 50%;
}

.icon-btn:active {
  background: rgba(255, 255, 255, 0.12);
}

.avatar-btn {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
}

.top-bar-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.3);
}

/* ===== Page content ===== */
.mobile-page-content {
  min-height: calc(100vh - 56px);
  min-height: calc(100dvh - 56px);
  padding-bottom: calc(72px + env(safe-area-inset-bottom));
}

.mobile-bottom-nav {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: calc(62px + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
  background: rgba(31, 45, 61, 0.98);
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  z-index: 850;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.bottom-tab-btn {
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.72);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  font-size: 11px;
  cursor: pointer;
}

.bottom-tab-btn.active {
  color: #5da8ff;
}

.bottom-tab-btn:active {
  background: rgba(255, 255, 255, 0.08);
}

/* ===== Notifications ===== */
.notifications-list {
  padding: 0;
}

.notification-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  border-bottom: 1px solid var(--border-light, #eee);
  position: relative;
  min-height: 44px;
}

.notification-item:active {
  background: var(--bg-secondary, #f5f5f5);
}

.notification-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--bg-secondary, #f5f5f5);
  display: flex;
  align-items: center;
  justify-content: center;
}

.notification-content { flex: 1; }
.notification-title { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
.notification-message { font-size: 13px; color: var(--text-secondary, #666); line-height: 1.4; margin-bottom: 4px; }
.notification-time { font-size: 12px; color: var(--text-tertiary, #999); }

.notification-badge {
  position: absolute;
  top: 20px;
  right: 16px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--danger-color, #f56c6c);
}

/* ===== Desktop: hide entire mobile layout (safety net — Layout.vue switches) ===== */
@media (min-width: 769px) {
  .mobile-layout { display: none; }
}
</style>
