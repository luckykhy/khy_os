<template>
  <div class="announcements">
    <!-- 页面标题 -->
    <div class="page-header">
      <h2>通知公告</h2>
      <p>查看系统最新通知和公告信息</p>
      <!-- 管理员发布按钮 -->
      <div v-if="isAdmin" class="admin-actions">
        <el-button 
          type="primary" 
          size="large" 
          @click="goToAdminPanel"
          class="admin-publish-btn"
        >
          管理员发布公告
        </el-button>
      </div>
    </div>

    <!-- 筛选栏 -->
    <el-card class="filter-card">
      <div class="filter-bar">
        <div class="filters">
          <el-select v-model="filterType" placeholder="类型筛选" @change="loadAnnouncements">
            <el-option label="全部类型" value="" />
            <el-option label="系统公告" value="system" />
            <el-option label="维护公告" value="maintenance" />
            <el-option label="功能更新" value="feature" />
            <el-option label="警告" value="warning" />
            <el-option label="信息" value="info" />
          </el-select>
          <el-checkbox v-model="showUnreadOnly" @change="loadAnnouncements">
            只显示未读
          </el-checkbox>
        </div>
        <div class="actions">
          <el-button @click="loadAnnouncements" :loading="loading" :icon="Refresh">
            刷新
          </el-button>
          <el-badge :value="unreadCount" :hidden="unreadCount === 0" class="unread-badge">
            <el-button :icon="Bell">
              未读通知
            </el-button>
          </el-badge>
          <!-- 管理员快速入口 -->
          <el-button 
            v-if="isAdmin" 
            type="warning" 
            @click="goToAdminPanel"
            class="admin-quick-btn"
          >
            🔧 管理公告
          </el-button>
        </div>
      </div>
    </el-card>

    <!-- 公告列表 -->
    <div class="announcements-list">
      <div
        v-for="announcement in announcements"
        :key="announcement.id"
        class="announcement-item"
        :class="{ 
          'unread': !announcement.isRead,
          'sticky': announcement.isSticky,
          'urgent': announcement.priority === 'urgent'
        }"
        @click="viewAnnouncement(announcement)"
      >
        <!-- 公告头部 -->
        <div class="announcement-header">
          <div class="title-section">
            <div class="tags">
              <el-tag v-if="announcement.isSticky" type="danger" size="small">置顶</el-tag>
              <el-tag :type="getTypeColor(announcement.type)" size="small">
                {{ getTypeLabel(announcement.type) }}
              </el-tag>
              <el-tag :type="getPriorityColor(announcement.priority)" size="small">
                {{ getPriorityLabel(announcement.priority) }}
              </el-tag>
            </div>
            <h3 class="title">{{ announcement.title }}</h3>
          </div>
          <div class="status-section">
            <el-badge v-if="!announcement.isRead" is-dot class="unread-dot" />
            <span class="publish-time">{{ formatTime(announcement.publishAt) }}</span>
          </div>
        </div>

        <!-- 公告预览内容 -->
        <div class="announcement-preview">
          {{ getContentPreview(announcement.content) }}
        </div>

        <!-- 公告底部 -->
        <div class="announcement-footer">
          <div class="author-info">
            <span class="author">发布者: {{ announcement.author?.username }}</span>
          </div>
          <div class="actions">
            <el-button
              size="small"
              :type="announcement.isLiked ? 'primary' : ''"
              :icon="announcement.isLiked ? StarFilled : Star"
              @click.stop="toggleLike(announcement)"
            >
              {{ announcement.isLiked ? '已赞' : '点赞' }}
            </el-button>
            <el-button size="small" @click.stop="viewAnnouncement(announcement)">
              查看详情
            </el-button>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-if="announcements.length === 0 && !loading" class="empty-state">
        <div class="empty-state-custom">
          <img src="/empty-state.jpg" alt="暂无数据" class="empty-image" />
          <p class="empty-text">暂无公告信息</p>
          <p class="empty-description">查看系统最新通知和公告信息</p>
        </div>
      </div>

      <!-- 加载状态 -->
      <div v-if="loading" class="loading-state">
        <el-skeleton :rows="3" animated />
      </div>
    </div>

    <!-- 分页 -->
    <el-pagination
      v-if="total > 0"
      @current-change="handlePageChange"
      :current-page="currentPage"
      :page-size="pageSize"
      :total="total"
      layout="prev, pager, next, total"
      class="pagination"
    />

    <!-- 公告详情对话框 -->
    <el-dialog
      title="公告详情"
      v-model="detailDialogVisible"
      width="800px"
      :destroy-on-close="true"
      :close-on-click-modal="true"
      :close-on-press-escape="true"
      append-to-body
      @close="handleDetailClose"
    >
      <div v-if="currentAnnouncement" class="announcement-detail">
        <!-- 详情头部 -->
        <div class="detail-header">
          <div class="detail-title">
            <h2>{{ currentAnnouncement.title }}</h2>
            <div class="detail-tags">
              <el-tag v-if="currentAnnouncement.isSticky" type="danger" size="small">置顶</el-tag>
              <el-tag :type="getTypeColor(currentAnnouncement.type)" size="small">
                {{ getTypeLabel(currentAnnouncement.type) }}
              </el-tag>
              <el-tag :type="getPriorityColor(currentAnnouncement.priority)" size="small">
                {{ getPriorityLabel(currentAnnouncement.priority) }}
              </el-tag>
            </div>
          </div>
          <div class="detail-meta">
            <p class="publish-info">
              <el-icon><User /></el-icon>
              发布者: {{ currentAnnouncement.author?.username }}
            </p>
            <p class="publish-info">
              <el-icon><Clock /></el-icon>
              发布时间: {{ formatTime(currentAnnouncement.publishAt) }}
            </p>
            <p v-if="currentAnnouncement.expireAt" class="publish-info">
              <el-icon><Calendar /></el-icon>
              过期时间: {{ formatTime(currentAnnouncement.expireAt) }}
            </p>
          </div>
        </div>

        <!-- 详情内容 -->
        <div class="detail-content">
          <div class="content-text">
            <pre>{{ currentAnnouncement.content }}</pre>
          </div>
        </div>

        <!-- 详情底部 -->
        <div class="detail-footer">
          <div class="read-info">
            <span v-if="currentAnnouncement.isRead" class="read-status">
              <el-icon><Check /></el-icon>
              已于 {{ formatTime(currentAnnouncement.readAt) }} 阅读
            </span>
          </div>
          <div class="detail-actions">
            <el-button
              :type="currentAnnouncement.isLiked ? 'primary' : ''"
              :icon="currentAnnouncement.isLiked ? StarFilled : Star"
              @click="toggleLike(currentAnnouncement)"
            >
              {{ currentAnnouncement.isLiked ? '已赞' : '点赞' }}
            </el-button>
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { ElMessage } from 'element-plus'
import { 
  Refresh, Bell, Star, StarFilled, User, Clock, Calendar, Check 
} from '@element-plus/icons-vue'
import request from '@/api/request'

const router = useRouter()
const userStore = useUserStore()

// 计算属性：判断是否为管理员
const isAdmin = computed(() => {
  return userStore.user?.role === 'admin'
})

// 跳转到管理员面板
const goToAdminPanel = () => {
  router.push('/admin/announcements')
}

// 响应式数据
const loading = ref(false)
const announcements = ref([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(10)
const unreadCount = ref(0)

// 筛选条件
const filterType = ref('')
const showUnreadOnly = ref(false)

// 对话框状态
const detailDialogVisible = ref(false)
const currentAnnouncement = ref(null)

// 加载公告列表
const loadAnnouncements = async () => {
  loading.value = true
  try {
    const params = {
      page: currentPage.value,
      pageSize: pageSize.value
    }
    if (filterType.value) params.type = filterType.value
    if (showUnreadOnly.value) params.unreadOnly = true

    const response = await request.get('/announcements', { params })
    
    if (response.success) {
      announcements.value = response.data.list
      total.value = response.data.total
      unreadCount.value = response.data.unreadCount || 0
    }
  } catch (error) {
    console.error('加载公告列表失败:', error)
    ElMessage.error('加载公告列表失败')
  } finally {
    loading.value = false
  }
}

// 查看公告详情
const viewAnnouncement = async (announcement) => {
  try {
    const response = await request.get(`/announcements/${announcement.id}`)
    
    if (response.success) {
      currentAnnouncement.value = response.data
      detailDialogVisible.value = true
      
      // 如果之前是未读状态，更新列表中的状态
      if (!announcement.isRead) {
        announcement.isRead = true
        announcement.readAt = new Date().toISOString()
        unreadCount.value = Math.max(0, unreadCount.value - 1)
      }
    }
  } catch (error) {
    console.error('获取公告详情失败:', error)
    ElMessage.error('获取公告详情失败')
  }
}

// 点赞/取消点赞
const toggleLike = async (announcement) => {
  try {
    const response = await request.post(`/announcements/${announcement.id}/like`)
    
    if (response.success) {
      announcement.isLiked = response.data.isLiked
      if (currentAnnouncement.value && currentAnnouncement.value.id === announcement.id) {
        currentAnnouncement.value.isLiked = response.data.isLiked
      }
      ElMessage.success(response.message)
    }
  } catch (error) {
    console.error('点赞操作失败:', error)
    ElMessage.error('操作失败')
  }
}

// 处理详情对话框关闭
const handleDetailClose = () => {
  detailDialogVisible.value = false
  currentAnnouncement.value = null
}

// 分页处理
const handlePageChange = (page) => {
  currentPage.value = page
  loadAnnouncements()
}

// 工具函数
const getTypeColor = (type) => {
  const colors = {
    system: 'danger',
    maintenance: 'warning',
    feature: 'success',
    warning: 'warning',
    info: 'info'
  }
  return colors[type] || 'info'
}

const getTypeLabel = (type) => {
  const labels = {
    system: '系统公告',
    maintenance: '维护公告',
    feature: '功能更新',
    warning: '警告',
    info: '信息'
  }
  return labels[type] || type
}

const getPriorityColor = (priority) => {
  const colors = {
    urgent: 'danger',
    high: 'warning',
    normal: 'info',
    low: 'success'
  }
  return colors[priority] || 'info'
}

const getPriorityLabel = (priority) => {
  const labels = {
    urgent: '紧急',
    high: '高',
    normal: '普通',
    low: '低'
  }
  return labels[priority] || priority
}

const formatTime = (time) => {
  if (!time) return '-'
  return new Date(time).toLocaleString()
}

const getContentPreview = (content) => {
  if (!content) return ''
  return content.length > 150 ? content.substring(0, 150) + '...' : content
}

// 组件挂载时执行
onMounted(() => {
  loadAnnouncements()
})
</script>

<style scoped>
.announcements {
  padding: var(--content-padding);
  width: 100%;
}

.page-header {
  text-align: center;
  margin-bottom: 30px;
}

.page-header h2 {
  color: #303133;
  margin-bottom: 10px;
}

.page-header p {
  color: #909399;
  font-size: 14px;
  margin-bottom: 20px;
}

.admin-actions {
  margin-top: 20px;
}

.admin-publish-btn {
  font-size: 16px;
  padding: 12px 24px;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(245, 108, 108, 0.3);
  background: linear-gradient(135deg, #f56c6c 0%, #e6a23c 100%);
  border: none;
  transition: all 0.3s ease;
}

.admin-publish-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(245, 108, 108, 0.4);
  background: linear-gradient(135deg, #f78989 0%, #eeb160 100%);
}

.filter-card {
  margin-bottom: 20px;
}

.filter-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 15px;
}

.filters {
  display: flex;
  align-items: center;
  gap: 15px;
  flex-wrap: wrap;
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.unread-badge {
  margin-left: 10px;
}

.admin-quick-btn {
  margin-left: 10px;
  font-weight: 600;
}

.announcements-list {
  min-height: 400px;
}

.announcement-item {
  background: white;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 15px;
  cursor: pointer;
  transition: all 0.3s;
  position: relative;
}

.announcement-item:hover {
  border-color: #409eff;
  box-shadow: 0 2px 12px rgba(64, 158, 255, 0.1);
}

.announcement-item.unread {
  border-left: 4px solid #409eff;
  background: linear-gradient(90deg, rgba(64, 158, 255, 0.05) 0%, white 10%);
}

.announcement-item.sticky {
  border-color: #f56c6c;
  background: linear-gradient(135deg, rgba(245, 108, 108, 0.05) 0%, white 20%);
}

.announcement-item.urgent {
  border-color: #f56c6c;
  box-shadow: 0 0 10px rgba(245, 108, 108, 0.2);
}

.announcement-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 15px;
}

.title-section {
  flex: 1;
}

.tags {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.title {
  margin: 0;
  color: #303133;
  font-size: 18px;
  font-weight: 600;
  line-height: 1.4;
}

.status-section {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.unread-dot {
  margin-right: 5px;
}

.publish-time {
  color: #909399;
  font-size: 14px;
  white-space: nowrap;
}

.announcement-preview {
  color: #606266;
  line-height: 1.6;
  margin-bottom: 15px;
  font-size: 14px;
}

.announcement-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 15px;
  border-top: 1px solid #f0f0f0;
}

.author-info {
  color: #909399;
  font-size: 13px;
}

.announcement-footer .actions {
  gap: 8px;
}

.empty-state, .loading-state {
  text-align: center;
  padding: 60px 20px;
}

.empty-state-custom {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.empty-image {
  width: 200px;
  height: auto;
  opacity: 0.6;
  margin-bottom: 8px;
}

.empty-text {
  font-size: 16px;
  color: #909399;
  margin: 0;
}

.empty-description {
  font-size: 14px;
  color: #C0C4CC;
  margin: 0;
}

.pagination {
  margin-top: 30px;
  text-align: center;
}

/* 详情对话框样式 */
.announcement-detail {
  max-height: 70vh;
  overflow-y: auto;
}

.detail-header {
  margin-bottom: 25px;
  padding-bottom: 20px;
  border-bottom: 2px solid #f0f0f0;
}

.detail-title h2 {
  margin: 0 0 15px 0;
  color: #303133;
  font-size: 24px;
  line-height: 1.4;
}

.detail-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 15px;
}

.detail-meta {
  color: #909399;
  font-size: 14px;
}

.publish-info {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}

.detail-content {
  margin-bottom: 25px;
}

.content-text pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  background: #f8f9fa;
  padding: 20px;
  border-radius: 8px;
  border-left: 4px solid #409eff;
  line-height: 1.8;
  color: #606266;
  margin: 0;
  font-family: inherit;
  font-size: 15px;
}

.detail-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 20px;
  border-top: 1px solid #f0f0f0;
}

.read-status {
  display: flex;
  align-items: center;
  gap: 5px;
  color: #67c23a;
  font-size: 14px;
}

.detail-actions {
  display: flex;
  gap: 10px;
}

@media (max-width: 768px) {
  .announcements {
    padding: 10px;
  }
  
  .filter-bar {
    flex-direction: column;
    align-items: stretch;
  }
  
  .filters {
    justify-content: center;
  }
  
  .actions {
    justify-content: center;
  }
  
  .announcement-header {
    flex-direction: column;
    gap: 10px;
  }
  
  .announcement-footer {
    flex-direction: column;
    gap: 10px;
    align-items: stretch;
  }
  
  .announcement-footer .actions {
    justify-content: center;
  }
  
  .detail-footer {
    flex-direction: column;
    gap: 15px;
    align-items: stretch;
  }
  
  .detail-actions {
    justify-content: center;
  }
}
</style>