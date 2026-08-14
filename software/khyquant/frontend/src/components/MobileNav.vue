<template>
  <div class="mobile-nav">
    <!-- 移动端菜单按钮 -->
    <button 
      class="mobile-menu-btn" 
      @click="toggleMenu"
      v-if="isMobile"
    >
      <el-icon :size="24">
        <Menu v-if="!menuOpen" />
        <Close v-else />
      </el-icon>
    </button>

    <!-- 遮罩层 -->
    <div 
      class="mobile-overlay" 
      :class="{ active: menuOpen }"
      @click="closeMenu"
      v-if="isMobile"
    ></div>

    <!-- 侧边栏 -->
    <el-aside 
      :class="{ 'mobile-open': menuOpen }"
      :width="isMobile ? '280px' : '200px'"
    >
      <div class="sidebar-header">
        <h2>KHY-Quant</h2>
        <p v-if="!isMobile">量化交易系统</p>
      </div>

      <el-menu
        :default-active="activeMenu"
        :router="true"
        @select="handleMenuSelect"
      >
        <el-menu-item index="/dashboard">
          <el-icon><Odometer /></el-icon>
          <span>主页</span>
        </el-menu-item>

        <el-menu-item index="/strategies">
          <el-icon><Document /></el-icon>
          <span>策略管理</span>
        </el-menu-item>

        <el-menu-item index="/trading">
          <el-icon><TrendCharts /></el-icon>
          <span>交易管理</span>
        </el-menu-item>

        <el-menu-item index="/data-sources">
          <el-icon><Connection /></el-icon>
          <span>数据源</span>
        </el-menu-item>

        <el-menu-item index="/announcements" v-if="isAdmin">
          <el-icon><Bell /></el-icon>
          <span>公告管理</span>
        </el-menu-item>

        <el-menu-item index="/feedback" v-if="isAdmin">
          <el-icon><ChatDotRound /></el-icon>
          <span>反馈管理</span>
        </el-menu-item>

        <el-menu-item index="/profile">
          <img src="/school-badge.svg" alt="个人中心" class="menu-badge-icon" />
          <span>个人中心</span>
        </el-menu-item>

        <el-menu-item @click="handleLogout">
          <el-icon><SwitchButton /></el-icon>
          <span>退出登录</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { ElMessage, ElMessageBox } from 'element-plus'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

const menuOpen = ref(false)
const isMobile = ref(false)

// 当前激活的菜单
const activeMenu = computed(() => route.path)

// 是否是管理员
const isAdmin = computed(() => userStore.user?.role === 'admin')

// 检测是否是移动端
const checkMobile = () => {
  isMobile.value = window.innerWidth <= 768
  if (!isMobile.value) {
    menuOpen.value = false
  }
}

// 切换菜单
const toggleMenu = () => {
  menuOpen.value = !menuOpen.value
}

// 关闭菜单
const closeMenu = () => {
  menuOpen.value = false
}

// 菜单选择处理
const handleMenuSelect = () => {
  if (isMobile.value) {
    closeMenu()
  }
}

// 退出登录
const handleLogout = async () => {
  try {
    await ElMessageBox.confirm('确定要退出登录吗？', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    
    userStore.logout()
    ElMessage.success('已退出登录')
    router.push('/login')
  } catch {
    // 用户取消
  }
}

onMounted(() => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
})

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile)
})
</script>

<style scoped>
.mobile-nav {
  position: relative;
}

.sidebar-header {
  padding: 24px 20px;
  text-align: center;
  border-bottom: 1px solid var(--border-light);
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.sidebar-header h2 {
  margin: 0 0 4px 0;
  font-size: 20px;
  font-weight: 600;
}

.sidebar-header p {
  margin: 0;
  font-size: 12px;
  opacity: 0.9;
}

.el-menu {
  border-right: none;
  background: white;
}

.el-menu-item,
.el-sub-menu__title {
  height: 56px;
  line-height: 56px;
  font-size: 15px;
}

.el-menu-item .el-icon,
.el-sub-menu__title .el-icon {
  margin-right: 8px;
  font-size: 18px;
}

.menu-badge-icon {
  width: 18px;
  height: 18px;
  margin-right: 8px;
  object-fit: contain;
}

/* 移动端样式 */
@media (max-width: 768px) {
  .mobile-menu-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    position: fixed;
    top: 16px;
    left: 16px;
    z-index: 1001;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: white;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
    border: none;
    cursor: pointer;
    transition: all 0.3s ease;
  }

  .mobile-menu-btn:active {
    transform: scale(0.95);
  }

  .mobile-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 999;
    opacity: 0;
    visibility: hidden;
    transition: all 0.3s ease;
  }

  .mobile-overlay.active {
    opacity: 1;
    visibility: visible;
  }

  .el-aside {
    position: fixed;
    top: 0;
    left: -100%;
    height: 100vh;
    z-index: 1000;
    transition: left 0.3s ease;
    background: white;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.15);
    overflow-y: auto;
  }

  .el-aside.mobile-open {
    left: 0;
  }

  .sidebar-header {
    padding: 20px 16px;
  }

  .sidebar-header h2 {
    font-size: 18px;
  }
}

/* 桌面端样式 */
@media (min-width: 769px) {
  .mobile-menu-btn {
    display: none;
  }

  .mobile-overlay {
    display: none;
  }

  .el-aside {
    position: relative;
    height: 100vh;
    overflow-y: auto;
  }
}
</style>
