<template>
  <div class="admin-announcements">
    <!-- 页面标题 -->
    <div class="page-header">
      <h2>通知公告管理</h2>
      <p>发布和管理系统通知公告</p>
      <!-- 快速发布按钮 -->
      <div class="quick-publish">
        <el-button 
          type="primary" 
          size="large" 
          @click="showCreateDialog" 
          :icon="Plus"
          class="publish-btn"
        >
          立即发布公告
        </el-button>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-cards">
      <el-card class="stat-card">
        <div class="stat-content">
          <div class="stat-number">{{ stats.total || 0 }}</div>
          <div class="stat-label">总公告数</div>
        </div>
        <el-icon class="stat-icon"><Document /></el-icon>
      </el-card>
      <el-card class="stat-card">
        <div class="stat-content">
          <div class="stat-number">{{ stats.published || 0 }}</div>
          <div class="stat-label">已发布</div>
        </div>
        <el-icon class="stat-icon"><Check /></el-icon>
      </el-card>
      <el-card class="stat-card">
        <div class="stat-content">
          <div class="stat-number">{{ stats.draft || 0 }}</div>
          <div class="stat-label">草稿</div>
        </div>
        <el-icon class="stat-icon"><Edit /></el-icon>
      </el-card>
      <el-card class="stat-card">
        <div class="stat-content">
          <div class="stat-number">{{ stats.sticky || 0 }}</div>
          <div class="stat-label">置顶</div>
        </div>
        <el-icon class="stat-icon"><Top /></el-icon>
      </el-card>
    </div>

    <!-- 操作栏 -->
    <el-card class="action-card">
      <div class="action-bar">
        <div class="filters">
          <el-select v-model="filterStatus" placeholder="状态筛选" @change="loadAnnouncements">
            <el-option label="全部" value="" />
            <el-option label="已发布" value="published" />
            <el-option label="草稿" value="draft" />
            <el-option label="已归档" value="archived" />
          </el-select>
          <el-select v-model="filterType" placeholder="类型筛选" @change="loadAnnouncements">
            <el-option label="全部类型" value="" />
            <el-option label="系统公告" value="system" />
            <el-option label="维护公告" value="maintenance" />
            <el-option label="功能更新" value="feature" />
            <el-option label="警告" value="warning" />
            <el-option label="信息" value="info" />
          </el-select>
          <el-select v-model="filterPriority" placeholder="优先级筛选" @change="loadAnnouncements">
            <el-option label="全部优先级" value="" />
            <el-option label="紧急" value="urgent" />
            <el-option label="高" value="high" />
            <el-option label="普通" value="normal" />
            <el-option label="低" value="low" />
          </el-select>
        </div>
        <div class="actions">
          <el-button type="primary" @click="showCreateDialog" :icon="Plus" size="large">
            发布公告
          </el-button>
          <el-button @click="loadAnnouncements" :loading="loading" :icon="Refresh">
            刷新
          </el-button>
        </div>
      </div>
    </el-card>

    <!-- 公告列表 -->
    <el-card class="list-card">
      <el-table :data="announcements" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column prop="title" label="标题" min-width="200">
          <template #default="{ row }">
            <div class="title-cell">
              <el-tag v-if="row.isSticky" type="danger" size="small">置顶</el-tag>
              <el-tag v-if="row.isPopup" type="warning" size="small">弹窗</el-tag>
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
        <el-table-column prop="priority" label="优先级" width="80">
          <template #default="{ row }">
            <el-tag :type="getPriorityColor(row.priority)" size="small">
              {{ getPriorityLabel(row.priority) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="getStatusColor(row.status)" size="small">
              {{ getStatusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="actualReadCount" label="阅读数" width="80" />
        <el-table-column prop="publishAt" label="发布时间" width="160">
          <template #default="{ row }">
            {{ formatTime(row.publishAt) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="viewAnnouncement(row)">查看</el-button>
            <el-button size="small" type="primary" @click="editAnnouncement(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="deleteAnnouncement(row)">删除</el-button>
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

    <!-- 创建/编辑公告对话框 -->
    <el-dialog
      :title="dialogMode === 'create' ? '发布新通知公告' : '编辑公告'"
      v-model="dialogVisible"
      width="800px"
      :before-close="handleDialogClose"
      class="announcement-dialog"
    >
      <el-form :model="announcementForm" :rules="formRules" ref="formRef" label-width="100px">
        <el-form-item label="公告标题" prop="title">
          <el-input v-model="announcementForm.title" placeholder="请输入公告标题" />
        </el-form-item>
        
        <el-form-item label="公告内容" prop="content">
          <el-input
            v-model="announcementForm.content"
            type="textarea"
            :rows="8"
            placeholder="请输入公告内容，支持Markdown格式"
          />
        </el-form-item>

        <el-row :gutter="20">
          <el-col :span="8">
            <el-form-item label="公告类型" prop="type">
              <el-select v-model="announcementForm.type" placeholder="选择类型">
                <el-option label="系统公告" value="system" />
                <el-option label="维护公告" value="maintenance" />
                <el-option label="功能更新" value="feature" />
                <el-option label="警告" value="warning" />
                <el-option label="信息" value="info" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="优先级" prop="priority">
              <el-select v-model="announcementForm.priority" placeholder="选择优先级">
                <el-option label="紧急" value="urgent" />
                <el-option label="高" value="high" />
                <el-option label="普通" value="normal" />
                <el-option label="低" value="low" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="发布时间">
              <el-date-picker
                v-model="announcementForm.publishAt"
                type="datetime"
                placeholder="选择发布时间"
                format="YYYY-MM-DD HH:mm:ss"
                value-format="YYYY-MM-DD HH:mm:ss"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="过期时间">
              <el-date-picker
                v-model="announcementForm.expireAt"
                type="datetime"
                placeholder="选择过期时间（可选）"
                format="YYYY-MM-DD HH:mm:ss"
                value-format="YYYY-MM-DD HH:mm:ss"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="显示选项">
              <el-checkbox v-model="announcementForm.isSticky">置顶显示</el-checkbox>
              <el-checkbox v-model="announcementForm.isPopup">弹窗提醒</el-checkbox>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveAnnouncement" :loading="saving" size="large">
          {{ dialogMode === 'create' ? '🚀 立即发布公告' : '💾 保存修改' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 查看公告对话框 -->
    <el-dialog title="公告详情" v-model="viewDialogVisible" width="700px">
      <div v-if="currentAnnouncement" class="announcement-detail">
        <div class="detail-header">
          <h3>{{ currentAnnouncement.title }}</h3>
          <div class="detail-meta">
            <el-tag :type="getTypeColor(currentAnnouncement.type)" size="small">
              {{ getTypeLabel(currentAnnouncement.type) }}
            </el-tag>
            <el-tag :type="getPriorityColor(currentAnnouncement.priority)" size="small">
              {{ getPriorityLabel(currentAnnouncement.priority) }}
            </el-tag>
            <span class="publish-time">{{ formatTime(currentAnnouncement.publishAt) }}</span>
          </div>
        </div>
        <div class="detail-content">
          <pre>{{ currentAnnouncement.content }}</pre>
        </div>
        <div class="detail-stats">
          <p>阅读次数: {{ currentAnnouncement.actualReadCount || 0 }}</p>
          <p>发布者: {{ currentAnnouncement.author?.username }}</p>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Document, Check, Edit, Top } from '@element-plus/icons-vue'
import request from '@/api/request'

// 响应式数据
const loading = ref(false)
const saving = ref(false)
const announcements = ref([])
const stats = ref({})
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(10)

// 筛选条件
const filterStatus = ref('')
const filterType = ref('')
const filterPriority = ref('')

// 对话框状态
const dialogVisible = ref(false)
const viewDialogVisible = ref(false)
const dialogMode = ref('create') // 'create' | 'edit'
const currentAnnouncement = ref(null)

// 表单数据
const announcementForm = reactive({
  title: '',
  content: '',
  type: 'info',
  priority: 'normal',
  publishAt: '',
  expireAt: '',
  isSticky: false,
  isPopup: false
})

// 表单验证规则
const formRules = {
  title: [
    { required: true, message: '请输入公告标题', trigger: 'blur' },
    { min: 1, max: 200, message: '标题长度在 1 到 200 个字符', trigger: 'blur' }
  ],
  content: [
    { required: true, message: '请输入公告内容', trigger: 'blur' }
  ],
  type: [
    { required: true, message: '请选择公告类型', trigger: 'change' }
  ],
  priority: [
    { required: true, message: '请选择优先级', trigger: 'change' }
  ]
}

const formRef = ref()

// 加载公告列表
const loadAnnouncements = async () => {
  loading.value = true
  try {
    const params = {
      page: currentPage.value,
      pageSize: pageSize.value
    }
    if (filterStatus.value) params.status = filterStatus.value
    if (filterType.value) params.type = filterType.value
    if (filterPriority.value) params.priority = filterPriority.value

    const response = await request.get('/announcements/admin', { params })
    
    if (response.success) {
      announcements.value = response.data.list
      total.value = response.data.total
    }
  } catch (error) {
    console.error('加载公告列表失败:', error)
    ElMessage.error('加载公告列表失败')
  } finally {
    loading.value = false
  }
}

// 加载统计信息
const loadStats = async () => {
  try {
    const response = await request.get('/announcements/admin/stats')
    if (response.success) {
      stats.value = response.data
    }
  } catch (error) {
    console.error('加载统计信息失败:', error)
  }
}

// 显示创建对话框
const showCreateDialog = () => {
  dialogMode.value = 'create'
  resetForm()
  dialogVisible.value = true
}

// 编辑公告
const editAnnouncement = (announcement) => {
  dialogMode.value = 'edit'
  currentAnnouncement.value = announcement
  
  // 填充表单
  Object.assign(announcementForm, {
    title: announcement.title,
    content: announcement.content,
    type: announcement.type,
    priority: announcement.priority,
    publishAt: announcement.publishAt,
    expireAt: announcement.expireAt,
    isSticky: announcement.isSticky,
    isPopup: announcement.isPopup
  })
  
  dialogVisible.value = true
}

// 查看公告
const viewAnnouncement = (announcement) => {
  currentAnnouncement.value = announcement
  viewDialogVisible.value = true
}

// 保存公告
const saveAnnouncement = async () => {
  if (!formRef.value) return
  
  try {
    await formRef.value.validate()
    saving.value = true

    const data = { ...announcementForm }
    
    let response
    if (dialogMode.value === 'create') {
      response = await request.post('/announcements', data)
    } else {
      response = await request.put(`/announcements/${currentAnnouncement.value.id}`, data)
    }

    if (response.success) {
      ElMessage.success(dialogMode.value === 'create' ? '公告发布成功' : '公告更新成功')
      dialogVisible.value = false
      loadAnnouncements()
      loadStats()
    }
  } catch (error) {
    console.error('保存公告失败:', error)
    ElMessage.error('保存公告失败')
  } finally {
    saving.value = false
  }
}

// 删除公告
const deleteAnnouncement = async (announcement) => {
  try {
    await ElMessageBox.confirm(
      `确定要删除公告"${announcement.title}"吗？此操作不可恢复。`,
      '确认删除',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    const response = await request.delete(`/announcements/${announcement.id}`)
    
    if (response.success) {
      ElMessage.success('公告删除成功')
      loadAnnouncements()
      loadStats()
    }
  } catch (error) {
    if (error !== 'cancel') {
      console.error('删除公告失败:', error)
      ElMessage.error('删除公告失败')
    }
  }
}

// 重置表单
const resetForm = () => {
  Object.assign(announcementForm, {
    title: '',
    content: '',
    type: 'info',
    priority: 'normal',
    publishAt: '',
    expireAt: '',
    isSticky: false,
    isPopup: false
  })
  currentAnnouncement.value = null
}

// 处理对话框关闭
const handleDialogClose = (done) => {
  resetForm()
  done()
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
    system: '系统',
    maintenance: '维护',
    feature: '功能',
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

const getStatusColor = (status) => {
  const colors = {
    published: 'success',
    draft: 'warning',
    archived: 'info'
  }
  return colors[status] || 'info'
}

const getStatusLabel = (status) => {
  const labels = {
    published: '已发布',
    draft: '草稿',
    archived: '已归档'
  }
  return labels[status] || status
}

const formatTime = (time) => {
  if (!time) return '-'
  return new Date(time).toLocaleString()
}

// 组件挂载时执行
onMounted(() => {
  loadAnnouncements()
  loadStats()
})
</script>

<style scoped>
.admin-announcements {
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

.quick-publish {
  margin-top: 20px;
}

.publish-btn {
  font-size: 16px;
  padding: 12px 24px;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(64, 158, 255, 0.3);
  transition: all 0.3s ease;
}

.publish-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(64, 158, 255, 0.4);
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

.announcement-detail {
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
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.publish-time {
  color: #909399;
  font-size: 14px;
}

.detail-content {
  margin-bottom: 20px;
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

.detail-stats {
  padding-top: 15px;
  border-top: 1px solid #ebeef5;
  color: #909399;
  font-size: 14px;
}

.detail-stats p {
  margin: 5px 0;
}

@media (max-width: 768px) {
  .admin-announcements {
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