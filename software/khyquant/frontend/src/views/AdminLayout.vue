<template>
  <el-container class="admin-layout-container" direction="vertical">
    <el-header class="admin-header">
      <div class="admin-header-content">
        <div class="admin-logo">
          <span>KHY-Quant 管理控制台</span>
        </div>
        <div class="admin-header-actions">
          <el-button type="primary" size="small" plain @click="goToUserSite">
            返回用户端
          </el-button>
          <span class="admin-user-info">
            {{ userStore.user?.username }}
            <el-tag type="danger" size="small">管理员</el-tag>
          </span>
          <el-button size="small" @click="handleLogout">退出</el-button>
        </div>
      </div>
    </el-header>
    <el-main class="admin-main-content">
      <router-view />
    </el-main>
  </el-container>
</template>

<script setup>
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { ElMessage } from 'element-plus'

const router = useRouter()
const userStore = useUserStore()

const goToUserSite = () => {
  router.push('/dashboard')
}

const handleLogout = () => {
  userStore.logout()
  ElMessage.success('已退出登录')
  router.push('/admin-login')
}
</script>

<style scoped>
.admin-layout-container {
  height: 100vh;
}

.admin-header {
  background-color: #fff;
  border-bottom: 1px solid #e4e7ed;
  padding: 0;
  box-shadow: 0 1px 4px rgba(0, 21, 41, 0.08);
  height: 56px;
}

.admin-header-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 100%;
  padding: 0 24px;
}

.admin-logo {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.admin-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.admin-user-info {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #606266;
  font-size: 14px;
}

.admin-main-content {
  background-color: #f0f2f5;
  padding: 20px;
  overflow-y: auto;
}
</style>
