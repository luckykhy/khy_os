<template>
  <div class="admin-feedback">
    <!-- 页面标题 -->
    <div class="page-header">
      <h2>💬 反馈管理</h2>
      <p>管理用户反馈和建议</p>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-cards">
      <el-card class="stat-card">
        <div class="stat-content">
          <div class="stat-number">{{ stats.total || 0 }}</div>
          <div class="stat-label">总反馈数</div>
        </div>
        <el-icon class="stat-icon"><ChatDotRound /></el-icon>
      </el-card>
      <el-card class="stat-card">
        <div class="stat-content">
          <div class="stat-number">{{ stats.pending || 0 }}</div>
          <div class="stat-label">待处理</div>
        </div>
        <el-icon class="stat-icon"><Clock /></el-icon>
      </el-card>
      <el-card class="stat-card">
        <div class="stat-content">
          <div class="stat-number">{{ stats.processing || 0 }}</div>
          <div class="stat-label">处理中</div>
        </div>
        <el-icon class="stat-icon"><Loading /></el-icon>
      </el-card>
      <el-card class="stat-card">
        <div class="stat-content">
          <div class="stat-number">{{ stats.resolved || 0 }}</div>
          <div class="stat-label">已解决</div>
        </div>
        <el-icon class="stat-icon"><Check /></el-icon>
      </el-card>
    </div>

    <!-- 操作栏 -->
    <el-card class="action-card">
      <div class="action-bar">
        <div class="filters">
          <el-select v-model="filterType" placeholder="反馈类型" @change="loadFeedbacks">
            <el-option label="全部类型" value="" />
            <el-option label="错误报告" value="bug" />
            <el-option label="功能建议" value="suggestion" />
            <el-option label="功能请求" value="feature" />
            <el-option label="其他" value="other" />
          </el-select>
          <el-select v-model="filterStatus" placeholder="处理状态" @change="loadFeedbacks">
            <el-option label="全部状态" value="" />
            <el-option label="待处理" value="pending" />
            <el-option label="处理中" value="processing" />
            <el-option label="已解决" value="resolved" />
            <el-option label="已关闭" value="closed" />
          </el-select>
          <el-select v-model="filterPriority" placeholder="优先级" @change="loadFeedbacks">
            <el-option label="全部优先级" value="" />
            <el-option label="紧急" value="urgent" />
            <el-option label="高" value="high" />
            <el-option label="普通" value="normal" />
            <el-option label="低" value="low" />
          </el-select>
          <el-input
            v-model="searchKeyword"
            placeholder="搜索反馈内容"
            @keyup.enter="loadFeedbacks"
            style="width: 200px"
          >
            <template #append>
              <el-button @click="loadFeedbacks" :icon="Search" />
            </template>
          </el-input>
        </div>
        <div class="actions">
          <el-button @click="loadFeedbacks" :loading="loading" :icon="Refresh">
            刷新
          </el-button>
        </div>
      </div>
    </el-card>

    <!-- 反馈列表 -->
    <el-card class="list-card">
      <el-table :data="feedbacks" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column prop="title" label="标题" min-width="200">
          <template #default="{ row }">
            <div class="title-cell">
              <el-tag :type="getPriorityColor(row.priority)" size="small">
                {{ getPriorityLabel(row.priority) }}
              </el-tag>
              <span class="title-text">{{ row.title }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="type" label="类型" width="100">
          <template #default="{ row }">
            <el-tag :type="getTypeColor(row.type)" size="small">
              {{ getTypeLabel(row.type) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="user.username" label="用户" width="100" />
        <el-table-column prop="status" label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="getStatusColor(row.status)" size="small">
              {{ getStatusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="提交时间" width="160">
          <template #default="{ row }">
            {{ formatTime(row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="viewFeedback(row)">查看</el-button>
            <el-button 
              size="small" 
              type="primary" 
              @click="replyFeedback(row)"
              :disabled="row.status === 'closed'"
            >
              回复
            </el-button>
            <el-button size="small" type="danger" @click="deleteFeedback(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-if="total > 0"
        @current-change="handlePageChange"
        :current-page="currentPage"
        :page-size="pageSize"
        :total="total"
        layout="prev, pager, next, total"
        class="pagination"
      />
    </el-card>

    <!-- 查看反馈对话框 -->
    <el-dialog
      title="反馈详情"
      v-model="viewDialogVisible"
      width="800px"
    >
      <div v-if="currentFeedback" class="feedback-detail">
        <div class="detail-header">
          <h3>{{ currentFeedback.title }}</h3>
          <div class="detail-meta">
            <el-tag :type="getTypeColor(currentFeedback.type)" size="small">
              {{ getTypeLabel(currentFeedback.type) }}
            </el-tag>
            <el-tag :type="getPriorityColor(currentFeedback.priority)" size="small">
              {{ getPriorityLabel(currentFeedback.priority) }}
            </el-tag>
            <el-tag :type="getStatusColor(currentFeedback.status)" size="small">
              {{ getStatusLabel(currentFeedback.status) }}
            </el-tag>
          </div>
        </div>
        <div class="detail-content">
          <h4>反馈内容：</h4>
          <pre>{{ currentFeedback.content }}</pre>
        </div>
        <div class="detail-info">
          <p><strong>用户：</strong>{{ currentFeedback.user?.username }}</p>
          <p><strong>联系方式：</strong>{{ currentFeedback.contactInfo || '未提供' }}</p>
          <p><strong>提交时间：</strong>{{ formatTime(currentFeedback.createdAt) }}</p>
        </div>
        <div v-if="currentFeedback.adminReply" class="admin-reply">
          <h4>管理员回复：</h4>
          <pre>{{ currentFeedback.adminReply }}</pre>
          <p class="reply-info">
            回复人：{{ currentFeedback.admin?.username }} | 
            回复时间：{{ formatTime(currentFeedback.repliedAt) }}
          </p>
        </div>
      </div>
    </el-dialog>

    <!-- 回复反馈对话框 -->
    <el-dialog
      title="回复反馈"
      v-model="replyDialogVisible"
      width="700px"
    >
      <div v-if="currentFeedback" class="reply-form">
        <div class="feedback-summary">
          <h4>{{ currentFeedback.title }}</h4>
          <p class="feedback-content">{{ currentFeedback.content }}</p>
        </div>
        <el-form :model="replyForm" :rules="replyRules" ref="replyFormRef" label-width="100px">
          <el-form-item label="回复内容" prop="adminReply">
            <el-input
              v-model="replyForm.adminReply"
              type="textarea"
              :rows="6"
              placeholder="请输入回复内容..."
            />
          </el-form-item>
          <el-form-item label="更新状态" prop="status">
            <el-select v-model="replyForm.status" placeholder="选择状态">
              <el-option label="处理中" value="processing" />
              <el-option label="已解决" value="resolved" />
              <el-option label="已关闭" value="closed" />
            </el-select>
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="replyDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitReply" :loading="replying">
          提交回复
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { 
  ChatDotRound, 
  Clock, 
  Loading, 
  Check, 
  Refresh, 
  Search 
} from '@element-plus/icons-vue'
import request from '@/api/request'

// 响应式数据
const loading = ref(false)
const replying = ref(false)
const feedbacks = ref([])
const stats = ref({})
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(10)

// 筛选条件
const filterType = ref('')
const filterStatus = ref('')
const filterPriority = ref('')
const searchKeyword = ref('')

// 对话框状态
const viewDialogVisible = ref(false)
const replyDialogVisible = ref(false)
const currentFeedback = ref(null)

// 回复表单
const replyForm = reactive({
  adminReply: '',
  status: 'processing'
})

const replyRules = {
  adminReply: [
    { required: true, message: '请输入回复内容', trigger: 'blur' }
  ],
  status: [
    { required: true, message: '请选择状态', trigger: 'change' }
  ]
}

const replyFormRef = ref()

// 加载反馈列表
const loadFeedbacks = async () => {
  loading.value = true
  try {
    const params = {
      page: currentPage.value,
      pageSize: pageSize.value
    }
    if (filterType.value) params.type = filterType.value
    if (filterStatus.value) params.status = filterStatus.value
    if (filterPriority.value) params.priority = filterPriority.value
    if (searchKeyword.value) params.search = searchKeyword.value

    const response = await request.get('/feedback/admin/list', { params })
    
    if (response.success) {
      feedbacks.value = response.data.list
      total.value = response.data.total
    }
  } catch (error) {
    console.error('加载反馈列表失败:', error)
    ElMessage.error('加载反馈列表失败')
  } finally {
    loading.value = false
  }
}

// 加载统计信息
const loadStats = async () => {
  try {
    const response = await request.get('/feedback/admin/stats')
    if (response.success) {
      stats.value = response.data
    }
  } catch (error) {
    console.error('加载统计信息失败:', error)
  }
}

// 查看反馈
const viewFeedback = (feedback) => {
  currentFeedback.value = feedback
  viewDialogVisible.value = true
}

// 回复反馈
const replyFeedback = (feedback) => {
  currentFeedback.value = feedback
  replyForm.adminReply = feedback.adminReply || ''
  replyForm.status = feedback.status === 'pending' ? 'processing' : feedback.status
  replyDialogVisible.value = true
}

// 提交回复
const submitReply = async () => {
  if (!replyFormRef.value) return
  
  try {
    await replyFormRef.value.validate()
    replying.value = true

    const response = await request.put(
      `/feedback/admin/${currentFeedback.value.id}/reply`,
      replyForm
    )

    if (response.success) {
      ElMessage.success('回复成功')
      replyDialogVisible.value = false
      loadFeedbacks()
      loadStats()
    }
  } catch (error) {
    console.error('回复失败:', error)
    ElMessage.error('回复失败')
  } finally {
    replying.value = false
  }
}

// 删除反馈
const deleteFeedback = async (feedback) => {
  try {
    await ElMessageBox.confirm(
      `确定要删除反馈"${feedback.title}"吗？此操作不可恢复。`,
      '确认删除',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    const response = await request.delete(`/feedback/admin/${feedback.id}`)
    
    if (response.success) {
      ElMessage.success('反馈删除成功')
      loadFeedbacks()
      loadStats()
    }
  } catch (error) {
    if (error !== 'cancel') {
      console.error('删除反馈失败:', error)
      ElMessage.error('删除反馈失败')
    }
  }
}

// 分页处理
const handlePageChange = (page) => {
  currentPage.value = page
  loadFeedbacks()
}

// 工具函数
const getTypeColor = (type) => {
  const colors = {
    bug: 'danger',
    suggestion: 'success',
    feature: 'primary',
    other: 'info'
  }
  return colors[type] || 'info'
}

const getTypeLabel = (type) => {
  const labels = {
    bug: '错误报告',
    suggestion: '功能建议',
    feature: '功能请求',
    other: '其他'
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

const getStatusColor = (status) => {
  const colors = {
    pending: 'warning',
    processing: 'primary',
    resolved: 'success',
    closed: 'info'
  }
  return colors[status] || 'info'
}

const getStatusLabel = (status) => {
  const labels = {
    pending: '待处理',
    processing: '处理中',
    resolved: '已解决',
    closed: '已关闭'
  }
  return labels[status] || status
}

const formatTime = (time) => {
  if (!time) return '-'
  return new Date(time).toLocaleString()
}

// 组件挂载时执行
onMounted(() => {
  loadFeedbacks()
  loadStats()
})
</script>

<style scoped>
.admin-feedback {
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
}

.stats-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 20px;
  margin-bottom: 20px;
}

.stat-card {
  cursor: pointer;
  transition: all 0.3s;
}

.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.stat-card .el-card__body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px;
}

.stat-content {
  flex: 1;
}

.stat-number {
  font-size: 28px;
  font-weight: bold;
  color: #409eff;
  margin-bottom: 5px;
}

.stat-label {
  color: #909399;
  font-size: 14px;
}

.stat-icon {
  font-size: 32px;
  color: #409eff;
  opacity: 0.8;
}

.action-card {
  margin-bottom: 20px;
}

.action-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 15px;
}

.filters {
  display: flex;
  gap: 15px;
  flex-wrap: wrap;
}

.actions {
  display: flex;
  gap: 10px;
}

.list-card {
  margin-bottom: 20px;
}

.title-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.title-text {
  font-weight: 500;
}

.pagination {
  margin-top: 20px;
  text-align: center;
}

.feedback-detail {
  max-height: 600px;
  overflow-y: auto;
}

.detail-header {
  margin-bottom: 20px;
  padding-bottom: 15px;
  border-bottom: 1px solid #ebeef5;
}

.detail-header h3 {
  margin: 0 0 10px 0;
  color: #303133;
}

.detail-meta {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.detail-content {
  margin-bottom: 20px;
}

.detail-content h4 {
  color: #303133;
  margin-bottom: 10px;
}

.detail-content pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  background: #f8f9fa;
  padding: 15px;
  border-radius: var(--radius-sm);
  border-left: 4px solid #409eff;
  line-height: 1.6;
  color: #606266;
  margin: 0;
}

.detail-info {
  margin-bottom: 20px;
  color: #909399;
  font-size: 14px;
}

.detail-info p {
  margin: 5px 0;
}

.admin-reply {
  background: #f0f9ff;
  border: 1px solid #e1f5fe;
  border-radius: 8px;
  padding: 15px;
}

.admin-reply h4 {
  color: #1976d2;
  margin-bottom: 10px;
}

.admin-reply pre {
  background: white;
  border-left-color: #67c23a;
}

.reply-info {
  margin-top: 10px;
  color: #909399;
  font-size: 13px;
}

.reply-form {
  max-height: 500px;
  overflow-y: auto;
}

.feedback-summary {
  background: #f8f9fa;
  padding: 15px;
  border-radius: var(--radius-sm);
  margin-bottom: 20px;
}

.feedback-summary h4 {
  margin: 0 0 10px 0;
  color: #303133;
}

.feedback-content {
  color: #606266;
  line-height: 1.6;
  margin: 0;
}

@media (max-width: 768px) {
  .admin-feedback {
    padding: 10px;
  }
  
  .action-bar {
    flex-direction: column;
    align-items: stretch;
  }
  
  .filters {
    justify-content: center;
  }
  
  .actions {
    justify-content: center;
  }
}
</style>