<template>
  <TradingAgentsBot />

  <MobileLayout v-if="isMobileDevice">
    <router-view />
  </MobileLayout>
  
  <el-container v-else class="layout-container">
    <el-header class="top-header" :class="{ 'is-collapsed': isHeaderCollapsed }">
      <div class="header-content">
        <div class="header-left">
          <div class="logo-section">
            <img src="/logo.png" alt="KHY量化交易系统" class="logo-image" />
          </div>
          
          <el-menu
            :default-active="activeMenu"
            mode="horizontal"
            router
            background-color="transparent"
            text-color="#fff"
            active-text-color="#409eff"
            class="top-menu"
          >
            <el-menu-item
              v-for="item in allMenuItems"
              :key="item.path"
              :index="item.path"
              :class="{ 'admin-only-item': item.adminOnly }"
              v-show="!item.adminOnly || isAdmin"
            >
              <el-icon><component :is="item.icon" /></el-icon>
              <span>{{ item.label }}</span>
            </el-menu-item>
          </el-menu>
        </div>
        
        <div class="header-actions">
          <el-tag size="small" type="info" effect="plain" class="mode-tag">
            {{ modeLabel }}
          </el-tag>

          <div v-if="isAdmin" class="admin-entrance">
            <el-button 
              type="primary" 
              size="small" 
              @click="goToAdmin"
              class="admin-btn"
            >
              <el-icon><Setting /></el-icon>
              管理后台
            </el-button>
          </div>
          
          <el-dropdown @command="handleCommand">
            <span class="user-info">
              <img src="/school-badge.svg" alt="用户" class="user-badge" />
              {{ userStore.user?.username }}
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="profile">个人中心</el-dropdown-item>
                <el-dropdown-item command="api-keys">API Key 管理</el-dropdown-item>
                <el-dropdown-item command="view-auto" divided>界面: 自动适配</el-dropdown-item>
                <el-dropdown-item command="view-mobile">界面: 强制手机版</el-dropdown-item>
                <el-dropdown-item command="view-desktop">界面: 强制电脑版</el-dropdown-item>
                <el-dropdown-item v-if="isAdmin" command="admin" divided>
                  <el-icon><Setting /></el-icon>
                  管理后台
                </el-dropdown-item>
                <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>
    </el-header>
    
    <div class="header-toggle-btn" @click="toggleHeader">
      <el-icon>
        <ArrowDownBold v-if="isHeaderCollapsed" />
        <ArrowUpBold v-else />
      </el-icon>
    </div>
    
    <div class="main-content" :class="{ 'header-collapsed': isHeaderCollapsed }">
      <router-view />
    </div>
  </el-container>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { ElMessage } from 'element-plus'
import TradingAgentsBot from '@/components/TradingAgentsBotSimple.vue'
import MobileLayout from '@/components/MobileLayout.vue'
import { getAllMenuItems } from '@/plugins/pluginManager'
import { resolveClientMode, setClientModePreference, notifyClientModeChanged } from '@/utils/clientMode'
import {
  ArrowDown,
  Setting,
  ArrowDownBold,
  ArrowUpBold
} from '@element-plus/icons-vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

const isMobileDevice = ref(false)
const clientModePreference = ref('auto')
const resolvedClientMode = ref('desktop')

const modeLabel = computed(() => {
  if (clientModePreference.value === 'mobile') return '手机版'
  if (clientModePreference.value === 'desktop') return '电脑版'
  return resolvedClientMode.value === 'mobile' ? '自动-手机' : '自动-电脑'
})

const checkDevice = () => {
  const mode = resolveClientMode()
  clientModePreference.value = mode.preference
  resolvedClientMode.value = mode.resolved
  isMobileDevice.value = mode.resolved === 'mobile'
}

const isHeaderCollapsed = ref(false)

const activeMenu = computed(() => route.path)

const isAdmin = computed(() => {
  return userStore.user?.role === 'admin'
})

const allMenuItems = computed(() => getAllMenuItems())

const toggleHeader = () => {
  isHeaderCollapsed.value = !isHeaderCollapsed.value
}

const handleCommand = (command) => {
  if (command === 'logout') {
    userStore.logout()
    ElMessage.success('已退出登录')
    router.push('/login')
  } else if (command === 'profile') {
    router.push('/profile')
  } else if (command === 'api-keys') {
    router.push('/api-keys')
  } else if (command === 'admin') {
    goToAdmin()
  } else if (command === 'view-auto') {
    setClientModePreference('auto')
    checkDevice()
    notifyClientModeChanged()
    ElMessage.success('已切换为自动适配模式')
  } else if (command === 'view-mobile') {
    setClientModePreference('mobile')
    checkDevice()
    notifyClientModeChanged()
    ElMessage.success('已切换为手机版')
  } else if (command === 'view-desktop') {
    setClientModePreference('desktop')
    checkDevice()
    notifyClientModeChanged()
    ElMessage.success('已切换为电脑版')
  }
}

const goToAdmin = () => {
  if (userStore.user?.role === 'admin') {
    router.push('/admin/dashboard')
    ElMessage.success('正在跳转到管理后台')
  } else {
    ElMessage.error('权限不足，无法访问管理后台')
  }
}

onMounted(() => {
  checkDevice()
  window.addEventListener('resize', checkDevice)
  window.addEventListener('orientationchange', checkDevice)
  window.addEventListener('khy-client-mode-changed', checkDevice)
})

onUnmounted(() => {
  window.removeEventListener('resize', checkDevice)
  window.removeEventListener('orientationchange', checkDevice)
  window.removeEventListener('khy-client-mode-changed', checkDevice)
})
</script>

<style scoped>
.layout-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.mode-tag {
  margin-right: 8px;
}

.top-header {
  background: linear-gradient(135deg, #304156 0%, #1f2d3d 100%);
  border-bottom: 2px solid #409eff;
  padding: 0;
  height: 42px;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  transition: all 0.3s ease;
}

.top-header.is-collapsed {
  transform: translateY(-42px);
}

.header-toggle-btn {
  position: fixed;
  top: 42px;
  left: 50%;
  transform: translateX(-50%);
  width: 50px;
  height: 20px;
  background: linear-gradient(135deg, #304156 0%, #1f2d3d 100%);
  border: 1px solid #409eff;
  border-top: none;
  border-radius: 0 0 10px 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 998;
  transition: all 0.3s ease;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.top-header.is-collapsed + .header-toggle-btn {
  top: 0;
  z-index: 1001;
}

.header-toggle-btn:hover {
  background: linear-gradient(135deg, #409eff 0%, #2d7dd2 100%);
  height: 24px;
}

.header-toggle-btn .el-icon {
  color: #fff;
  font-size: 14px;
  transition: color 0.3s;
}

.header-toggle-btn:hover .el-icon {
  color: #fff;
}

.header-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 100%;
  padding: 0 20px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 30px;
  flex: 1;
}

.logo-section {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 0;
}

.logo-image {
  height: 32px;
  max-height: 32px;
  width: auto;
  max-width: 180px;
  object-fit: contain;
  object-position: left center;
  cursor: pointer;
  transition: transform 0.3s ease;
  display: block;
}

.logo-image:hover {
  transform: scale(1.05);
}

.top-menu {
  border-bottom: none;
  background: transparent;
  flex: 1;
}

.top-menu .el-menu-item {
  color: rgba(255, 255, 255, 0.8);
  border-bottom: 2px solid transparent;
  height: 42px;
  line-height: 42px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 5px;
}

.top-menu .el-menu-item:hover {
  background-color: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.top-menu .el-menu-item.is-active {
  background-color: rgba(64, 158, 255, 0.2);
  color: #409eff;
  border-bottom-color: #409eff;
}

.top-menu .el-menu-item .el-icon {
  font-size: 16px;
}

.top-menu .el-menu-item span {
  font-size: 13px;
}

.menu-badge-icon {
  width: 16px;
  height: 16px;
  object-fit: contain;
  vertical-align: middle;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 15px;
}

.admin-entrance {
  display: flex;
  align-items: center;
}

.admin-btn {
  background: linear-gradient(135deg, #ff6b6b, #ee5a24);
  border: none;
  border-radius: 20px;
  padding: 8px 16px;
  font-size: 12px;
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(255, 107, 107, 0.3);
  transition: all 0.3s ease;
}

.admin-btn:hover {
  background: linear-gradient(135deg, #ee5a24, #ff6b6b);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(255, 107, 107, 0.4);
}

.admin-btn:active {
  transform: translateY(0);
}

.user-info {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: #fff;
  padding: 8px 12px;
  border-radius: 4px;
  transition: all 0.3s;
}

.user-info:hover {
  background-color: rgba(255, 255, 255, 0.1);
}

.user-badge {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid rgba(255, 255, 255, 0.3);
  transition: all 0.3s ease;
}

.user-info:hover .user-badge {
  border-color: rgba(255, 255, 255, 0.6);
  transform: scale(1.05);
}

.main-content {
  background-color: #f5f7fa;
  padding: 0;
  margin-top: 42px;
  height: calc(100vh - 42px);
  overflow: auto;
  position: relative;
  transition: all 0.3s ease;
  z-index: 1;
}

.main-content.header-collapsed {
  margin-top: 0;
  height: 100vh;
}

.main-content > :not(.professional-trading) {
  padding: var(--content-padding);
  min-height: 100%;
  width: 100%;
}

@media (max-width: 1200px) {
  .top-menu .el-menu-item span {
    display: none;
  }
  
  .top-menu .el-menu-item {
    padding: 0 8px;
  }
  
  .logo-image {
    height: 28px;
    max-height: 28px;
    max-width: 140px;
  }
}

@media (max-width: 768px) {
  .header-left {
    gap: 8px;
  }

  .logo-image {
    height: 26px;
    max-height: 26px;
    max-width: 100px;
  }

  .main-content > :not(.professional-trading) {
    padding: var(--content-padding);
  }

  .top-menu {
    overflow-x: auto;
    overflow-y: hidden;
  }

  .top-menu::-webkit-scrollbar {
    height: 3px;
  }

  .top-menu::-webkit-scrollbar-thumb {
    background-color: rgba(255, 255, 255, 0.3);
    border-radius: 2px;
  }
}
</style>
