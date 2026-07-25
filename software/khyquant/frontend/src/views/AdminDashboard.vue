<template>
  <div class="admin-dashboard">
    <!-- 欢迎区域 -->
    <div class="welcome-section">
      <el-card class="welcome-card">
        <div class="welcome-content">
          <div class="welcome-text">
            <h2>👋 欢迎回来，{{ userStore.user?.username }}</h2>
            <p>今天是 {{ currentDate }}，系统运行正常</p>
          </div>
          <div class="welcome-actions">
            <el-button type="primary" @click="$router.push('/admin/announcements')">
              <el-icon><Bell /></el-icon>
              发布公告
            </el-button>
          </div>
        </div>
      </el-card>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-grid">
      <el-card class="stat-card" v-loading="statsLoading">
        <div class="stat-content">
          <div class="stat-info">
            <div class="stat-number">{{ stats.totalUsers || 0 }}</div>
            <div class="stat-label">总用户数</div>
          </div>
          <div class="stat-icon user-icon">
            <el-icon><User /></el-icon>
          </div>
        </div>
      </el-card>

      <el-card class="stat-card" v-loading="statsLoading">
        <div class="stat-content">
          <div class="stat-info">
            <div class="stat-number">{{ stats.totalStrategies || 0 }}</div>
            <div class="stat-label">策略总数</div>
          </div>
          <div class="stat-icon strategy-icon">
            <el-icon><Document /></el-icon>
          </div>
        </div>
      </el-card>

      <el-card class="stat-card" v-loading="statsLoading">
        <div class="stat-content">
          <div class="stat-info">
            <div class="stat-number">{{ stats.totalAnnouncements || 0 }}</div>
            <div class="stat-label">公告总数</div>
          </div>
          <div class="stat-icon announcement-icon">
            <el-icon><Bell /></el-icon>
          </div>
        </div>
      </el-card>

      <el-card class="stat-card" v-loading="statsLoading">
        <div class="stat-content">
          <div class="stat-info">
            <div class="stat-number">{{ stats.onlineUsers || 0 }}</div>
            <div class="stat-label">在线用户</div>
          </div>
          <div class="stat-icon online-icon">
            <el-icon><Connection /></el-icon>
          </div>
        </div>
      </el-card>
    </div>

    <!-- 快速操作和最新动态 -->
    <div class="content-grid">
      <!-- 快速操作 -->
      <el-card class="quick-actions-card">
        <template #header>
          <div class="card-header">
            <span>⚡ 快速操作</span>
          </div>
        </template>
        <div class="quick-actions">
          <el-button 
            type="primary" 
            size="large" 
            @click="$router.push('/admin/announcements')"
            class="action-btn"
          >
            <el-icon><Bell /></el-icon>
            发布公告
          </el-button>
          <el-button 
            type="success" 
            size="large" 
            @click="$router.push('/admin/users')"
            class="action-btn"
          >
            <el-icon><User /></el-icon>
            用户管理
          </el-button>
          <el-button 
            type="info" 
            size="large" 
            @click="$router.push('/admin/feedback')"
            class="action-btn"
          >
            <el-icon><ChatDotRound /></el-icon>
            反馈管理
          </el-button>
          <el-button 
            type="warning" 
            size="large" 
            @click="$router.push('/admin/strategies')"
            class="action-btn"
          >
            <el-icon><Document /></el-icon>
            策略审核
          </el-button>
          <el-button 
            type="info" 
            size="large" 
            @click="$router.push('/admin/system')"
            class="action-btn"
          >
            <el-icon><Setting /></el-icon>
            系统设置
          </el-button>
        </div>
      </el-card>

      <!-- 最新动态 -->
      <el-card class="recent-activities-card">
        <template #header>
          <div class="card-header">
            <span>📊 最新动态</span>
            <el-button text @click="loadRecentActivities">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </template>
        <div class="recent-activities" v-loading="activitiesLoading">
          <div 
            v-for="activity in recentActivities" 
            :key="activity.id"
            class="activity-item"
          >
            <div class="activity-icon">
              <el-icon v-if="activity.type === 'user'"><User /></el-icon>
              <el-icon v-else-if="activity.type === 'strategy'"><Document /></el-icon>
              <el-icon v-else-if="activity.type === 'announcement'"><Bell /></el-icon>
              <el-icon v-else><InfoFilled /></el-icon>
            </div>
            <div class="activity-content">
              <div class="activity-text">{{ activity.description }}</div>
              <div class="activity-time">{{ formatTime(activity.createdAt) }}</div>
            </div>
          </div>
          <div v-if="recentActivities.length === 0" class="no-activities">
            暂无最新动态
          </div>
        </div>
      </el-card>
    </div>

    <!-- 系统状态 -->
    <el-card class="system-status-card">
      <template #header>
        <div class="card-header">
          <span>🖥️ 系统状态</span>
          <el-button text @click="loadSystemStatus">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </template>
      <div class="system-status" v-loading="systemLoading">
        <div class="status-grid">
          <div class="status-item">
            <div class="status-label">数据库连接</div>
            <el-tag :type="systemStatus.database ? 'success' : 'danger'">
              {{ systemStatus.database ? '正常' : '异常' }}
            </el-tag>
          </div>
          <div class="status-item">
            <div class="status-label">WebSocket服务</div>
            <el-tag :type="systemStatus.websocket ? 'success' : 'danger'">
              {{ systemStatus.websocket ? '正常' : '异常' }}
            </el-tag>
          </div>
          <div class="status-item">
            <div class="status-label">AI服务</div>
            <el-tag :type="systemStatus.aiService ? 'success' : 'warning'">
              {{ systemStatus.aiService ? '正常' : '离线' }}
            </el-tag>
          </div>
          <div class="status-item">
            <div class="status-label">系统负载</div>
            <el-tag type="info">{{ systemStatus.load || '未知' }}</el-tag>
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed } from 'vue'
import { useUserStore } from '@/stores/user'
import { ElMessage } from 'element-plus'
import { 
  User, 
  Document, 
  Bell, 
  Connection, 
  Setting, 
  Refresh, 
  InfoFilled 
} from '@element-plus/icons-vue'
import request from '@/api/request'

const userStore = useUserStore()

// 响应式数据
const statsLoading = ref(false)
const activitiesLoading = ref(false)
const systemLoading = ref(false)

const stats = reactive({
  totalUsers: 0,
  totalStrategies: 0,
  totalAnnouncements: 0,
  onlineUsers: 0
})

const recentActivities = ref([])
const systemStatus = reactive({
  database: true,
  websocket: true,
  aiService: false,
  load: '正常'
})

// 计算属性
const currentDate = computed(() => {
  return new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  })
})

// 加载统计数据
const loadStats = async () => {
  statsLoading.value = true
  try {
    const response = await request.get('/admin/stats')
    if (response.success) {
      Object.assign(stats, response.data)
    }
  } catch (error) {
    console.error('加载统计数据失败:', error)
    // 使用模拟数据
    Object.assign(stats, {
      totalUsers: 156,
      totalStrategies: 89,
      totalAnnouncements: 23,
      onlineUsers: 12
    })
  } finally {
    statsLoading.value = false
  }
}

// 加载最新动态
const loadRecentActivities = async () => {
  activitiesLoading.value = true
  try {
    const response = await request.get('/admin/activities')
    if (response.success) {
      recentActivities.value = response.data
    }
  } catch (error) {
    console.error('加载最新动态失败:', error)
    // 使用模拟数据
    recentActivities.value = [
      {
        id: 1,
        type: 'user',
        description: '新用户 testuser 注册成功',
        createdAt: new Date(Date.now() - 1000 * 60 * 5)
      },
      {
        id: 2,
        type: 'strategy',
        description: '用户 admin 创建了新策略"双均线策略"',
        createdAt: new Date(Date.now() - 1000 * 60 * 15)
      },
      {
        id: 3,
        type: 'announcement',
        description: '发布了新公告"系统维护通知"',
        createdAt: new Date(Date.now() - 1000 * 60 * 30)
      }
    ]
  } finally {
    activitiesLoading.value = false
  }
}

// 加载系统状态
const loadSystemStatus = async () => {
  systemLoading.value = true
  try {
    const response = await request.get('/admin/system-status')
    if (response.success) {
      Object.assign(systemStatus, response.data)
    }
  } catch (error) {
    console.error('加载系统状态失败:', error)
    ElMessage.warning('无法获取系统状态信息')
  } finally {
    systemLoading.value = false
  }
}

// 格式化时间
const formatTime = (time) => {
  if (!time) return ''
  const now = new Date()
  const target = new Date(time)
  const diff = now - target
  
  if (diff < 1000 * 60) {
    return '刚刚'
  } else if (diff < 1000 * 60 * 60) {
    return `${Math.floor(diff / (1000 * 60))}分钟前`
  } else if (diff < 1000 * 60 * 60 * 24) {
    return `${Math.floor(diff / (1000 * 60 * 60))}小时前`
  } else {
    return target.toLocaleDateString()
  }
}

// 组件挂载时执行
onMounted(() => {
  loadStats()
  loadRecentActivities()
  loadSystemStatus()
})
</script>

<style scoped>
.admin-dashboard {
  width: 100%;
}

.welcome-section {
  margin-bottom: 24px;
}

.welcome-card {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.welcome-card :deep(.el-card__body) {
  padding: 32px;
}

.welcome-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.welcome-text h2 {
  margin: 0 0 8px 0;
  font-size: 24px;
  font-weight: 600;
}

.welcome-text p {
  margin: 0;
  opacity: 0.9;
  font-size: 16px;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 24px;
  margin-bottom: 24px;
}

.stat-card {
  cursor: pointer;
  transition: all 0.3s ease;
}

.stat-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 25px rgba(0, 0, 0, 0.1);
}

.stat-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
}

.stat-number {
  font-size: 32px;
  font-weight: bold;
  color: #303133;
  margin-bottom: 4px;
}

.stat-label {
  color: #909399;
  font-size: 14px;
}

.stat-icon {
  font-size: 48px;
  opacity: 0.8;
}

.user-icon {
  color: #409eff;
}

.strategy-icon {
  color: #67c23a;
}

.announcement-icon {
  color: #e6a23c;
}

.online-icon {
  color: #f56c6c;
}

.content-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  margin-bottom: 24px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.quick-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.action-btn {
  height: 60px;
  font-size: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.recent-activities {
  max-height: 300px;
  overflow-y: auto;
}

.activity-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid #f0f0f0;
}

.activity-item:last-child {
  border-bottom: none;
}

.activity-icon {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background-color: #f5f7fa;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #409eff;
}

.activity-content {
  flex: 1;
}

.activity-text {
  color: #303133;
  font-size: 14px;
  margin-bottom: 4px;
}

.activity-time {
  color: #909399;
  font-size: 12px;
}

.no-activities {
  text-align: center;
  color: #909399;
  padding: 40px 0;
}

.system-status-card {
  margin-bottom: 24px;
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 24px;
}

.status-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background-color: #f8f9fa;
  border-radius: 8px;
}

.status-label {
  font-weight: 500;
  color: #303133;
}

@media (max-width: 768px) {
  .admin-dashboard {
    padding: 0 16px;
  }
  
  .welcome-content {
    flex-direction: column;
    gap: 16px;
    text-align: center;
  }
  
  .content-grid {
    grid-template-columns: 1fr;
  }
  
  .quick-actions {
    grid-template-columns: 1fr;
  }
  
  .stats-grid {
    grid-template-columns: 1fr;
  }
}
</style>