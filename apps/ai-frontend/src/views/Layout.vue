<template>
  <el-container class="layout-container">
    <el-aside width="200px">
      <div class="logo">
        <h3>KHY AI</h3>
      </div>
      <el-menu
        :default-active="activeMenu"
        router
        background-color="#304156"
        text-color="#bfcbd9"
        active-text-color="#409eff"
      >
        <el-menu-item index="/dashboard">
          <el-icon><HomeFilled /></el-icon>
          <span>工作台</span>
        </el-menu-item>
        <el-menu-item index="/ai-gateway">
          <el-icon><Connection /></el-icon>
          <span>AI 网关</span>
        </el-menu-item>
        <el-menu-item index="/ai-chat">
          <el-icon><ChatDotRound /></el-icon>
          <span>AI 对话</span>
        </el-menu-item>
        <el-menu-item index="/agent-dashboard">
          <el-icon><Cpu /></el-icon>
          <span>智能体控制台</span>
        </el-menu-item>
        <el-menu-item index="/ai-monitor">
          <el-icon><Monitor /></el-icon>
          <span>AI 监控</span>
        </el-menu-item>
        <el-menu-item index="/account-pool">
          <el-icon><User /></el-icon>
          <span>账号池管理</span>
        </el-menu-item>
        <el-menu-item index="/ai-assets">
          <el-icon><Files /></el-icon>
          <span>AI 资产管理</span>
        </el-menu-item>
        <el-menu-item index="/ai-payments">
          <el-icon><CreditCard /></el-icon>
          <span>支付管理</span>
        </el-menu-item>
        <el-menu-item index="/settings">
          <el-icon><Setting /></el-icon>
          <span>系统设置</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header>
        <div class="header-content">
          <div class="header-title">{{ currentTitle }}</div>
          <div class="header-actions">
            <el-dropdown @command="handleCommand">
              <span class="user-dropdown">
                <el-icon><UserFilled /></el-icon>
                <span>{{ authStore.user?.username || '用户' }}</span>
              </span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="logout">
                    <el-icon><SwitchButton /></el-icon>
                    退出登录
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
      </el-header>

      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { ElMessage, ElMessageBox } from 'element-plus';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const activeMenu = computed(() => route.path);
const currentTitle = computed(() => route.meta.title || 'KHY AI 管理平台');

async function handleCommand(command) {
  if (command === 'logout') {
    try {
      await ElMessageBox.confirm('确定要退出登录吗？', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      });

      await authStore.logout();
      ElMessage.success('已退出登录');
      router.push('/login');
    } catch (error) {
      // User cancelled
    }
  }
}
</script>

<style scoped>
.layout-container {
  height: 100vh;
}

.el-aside {
  background-color: #304156;
  color: #fff;
}

.logo {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #263445;
  border-bottom: 1px solid #1f2d3d;
}

.logo h3 {
  margin: 0;
  color: #fff;
  font-size: 20px;
  font-weight: 600;
}

.el-menu {
  border-right: none;
}

.el-header {
  background-color: #fff;
  box-shadow: 0 1px 4px rgba(0, 21, 41, 0.08);
  padding: 0 20px;
  display: flex;
  align-items: center;
}

.header-content {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-title {
  font-size: 18px;
  font-weight: 600;
  color: #333;
}

.user-dropdown {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  padding: 8px 12px;
  border-radius: 4px;
  transition: background-color 0.3s;
}

.user-dropdown:hover {
  background-color: #f5f7fa;
}

.el-main {
  background-color: #f0f2f5;
  padding: 20px;
}
</style>
