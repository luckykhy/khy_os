<template>
  <div class="admin-user-logs">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>📋 用户日志管理</span>
          <div class="header-actions">
            <el-button size="small" @click="exportLogs" :loading="exportLoading">
              <el-icon><Download /></el-icon>
              导出日志
            </el-button>
            <el-button size="small" @click="showCleanupDialog = true">
              <el-icon><Delete /></el-icon>
              清理日志
            </el-button>
            <el-button size="small" @click="refreshLogs">
              <el-icon><Refresh /></el-icon>
              刷新
            </el-button>
          </div>
        </div>
      </template>

      <!-- 筛选条件 -->
      <div class="filter-section">
        <el-row :gutter="20">
          <el-col :span="6">
            <el-input
              v-model="filters.search"
              placeholder="搜索用户名或描述"
              clearable
              @input="handleSearch"
            >
              <template #prefix>
                <el-icon><Search /></el-icon>
              </template>
            </el-input>
          </el-col>
          <el-col :span="4">
            <el-select v-model="filters.action" placeholder="操作类型" clearable @change="handleFilter">
              <el-option label="全部操作" value="" />
              <el-option label="登录" value="login" />
              <el-option label="登出" value="logout" />
              <el-option label="注册" value="register" />
              <el-option label="密码修改" value="password_change" />
              <el-option label="密码重置" value="password_reset_by_admin" />
              <el-option label="账号删除" value="account_deleted_by_admin" />
              <el-option label="信息更新" value="profile_update_by_admin" />
            </el-select>
          </el-col>
          <el-col :span="4">
            <el-select v-model="filters.status" placeholder="状态筛选" clearable @change="handleFilter">
              <el-option label="全部状态" value="" />
              <el-option label="成功" value="success" />
              <el-option label="失败" value="failed" />
              <el-option label="警告" value="warning" />
            </el-select>
          </el-col>
          <el-col :span="10">
            <el-date-picker
              v-model="dateRange"
              type="datetimerange"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              format="YYYY-MM-DD HH:mm:ss"
              value-format="YYYY-MM-DD HH:mm:ss"
              @change="handleDateChange"
            />
          </el-col>
        </el-row>
      </div>

      <!-- 日志列表 -->
      <el-table
        v-loading="loading"
        :data="logs"
        style="width: 100%"
        @sort-change="handleSortChange"
      >
        <el-table-column prop="id" label="ID" width="80" sortable />
        <el-table-column prop="userId" label="用户ID" width="100" sortable />
        <el-table-column prop="username" label="用户名" min-width="120" sortable />
        <el-table-column prop="action" label="操作类型" width="150" sortable>
          <template #default="{ row }">
            <el-tag :type="getActionType(row.action)" size="small">
              {{ getActionText(row.action) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="actionDescription" label="操作描述" min-width="200" />
        <el-table-column prop="ipAddress" label="IP地址" width="140" />
        <el-table-column prop="status" label="状态" width="80" sortable>
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.status)" size="small">
              {{ getStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="timestamp" label="时间" width="160" sortable>
          <template #default="{ row }">
            {{ formatDate(row.timestamp) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="viewDetails(row)">详情</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页 -->
      <div class="pagination-section">
        <el-pagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.limit"
          :page-sizes="[10, 20, 50, 100]"
          :total="pagination.total"
          layout="total, sizes, prev, pager, next, jumper"
          @size-change="handleSizeChange"
          @current-change="handleCurrentChange"
        />
      </div>

      <!-- 统计信息 -->
      <div class="stats-section">
        <el-row :gutter="20">
          <el-col :span="6">
            <el-statistic title="总日志数" :value="pagination.total" />
          </el-col>
          <el-col :span="6">
            <el-statistic title="成功操作" :value="stats.successCount" />
          </el-col>
          <el-col :span="6">
            <el-statistic title="失败操作" :value="stats.failedCount" />
          </el-col>
          <el-col :span="6">
            <el-statistic title="今日操作" :value="stats.todayCount" />
          </el-col>
        </el-row>
      </div>
    </el-card>

    <!-- 日志详情对话框 -->
    <el-dialog
      v-model="showDetailDialog"
      title="日志详情"
      width="600px"
    >
      <div v-if="selectedLog">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="日志ID">{{ selectedLog.id }}</el-descriptions-item>
          <el-descriptions-item label="用户ID">{{ selectedLog.userId }}</el-descriptions-item>
          <el-descriptions-item label="用户名">{{ selectedLog.username }}</el-descriptions-item>
          <el-descriptions-item label="操作类型">
            <el-tag :type="getActionType(selectedLog.action)" size="small">
              {{ getActionText(selectedLog.action) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="操作描述">{{ selectedLog.actionDescription }}</el-descriptions-item>
          <el-descriptions-item label="IP地址">{{ selectedLog.ipAddress || '-' }}</el-descriptions-item>
          <el-descriptions-item label="用户代理">{{ selectedLog.userAgent || '-' }}</el-descriptions-item>
          <el-descriptions-item label="会话ID">{{ selectedLog.sessionId || '-' }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="getStatusType(selectedLog.status)" size="small">
              {{ getStatusText(selectedLog.status) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="时间">{{ formatDate(selectedLog.timestamp) }}</el-descriptions-item>
          <el-descriptions-item label="详细信息" v-if="selectedLog.details">
            <pre>{{ JSON.stringify(selectedLog.details, null, 2) }}</pre>
          </el-descriptions-item>
        </el-descriptions>
      </div>
    </el-dialog>

    <!-- 清理日志对话框 -->
    <el-dialog
      v-model="showCleanupDialog"
      title="清理旧日志"
      width="400px"
    >
      <el-form
        ref="cleanupFormRef"
        :model="cleanupForm"
        :rules="cleanupRules"
        label-width="120px"
      >
        <el-form-item label="保留天数" prop="daysToKeep">
          <el-input-number
            v-model="cleanupForm.daysToKeep"
            :min="1"
            :max="365"
            placeholder="请输入保留天数"
          />
          <div style="font-size: 12px; color: #909399; margin-top: 4px;">
            将删除 {{ cleanupForm.daysToKeep }} 天前的所有日志记录
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCleanupDialog = false">取消</el-button>
        <el-button type="danger" @click="handleCleanup" :loading="cleanupLoading">
          确认清理
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Delete, Refresh, Search } from '@element-plus/icons-vue'
import { adminAPI } from '@/api/admin'

// 数据状态
const loading = ref(false)
const exportLoading = ref(false)
const cleanupLoading = ref(false)
const logs = ref([])
const dateRange = ref([])

// 对话框状态
const showDetailDialog = ref(false)
const showCleanupDialog = ref(false)
const selectedLog = ref(null)

// 筛选条件
const filters = reactive({
  search: '',
  action: '',
  status: '',
  startDate: '',
  endDate: ''
})

// 分页
const pagination = reactive({
  page: 1,
  limit: 20,
  total: 0
})

// 清理表单
const cleanupForm = reactive({
  daysToKeep: 90
})

const cleanupFormRef = ref()
const cleanupRules = {
  daysToKeep: [
    { required: true, message: '请输入保留天数', trigger: 'blur' },
    { type: 'number', min: 1, max: 365, message: '保留天数必须在1-365之间', trigger: 'blur' }
  ]
}

// 统计信息
const stats = computed(() => {
  const successCount = logs.value.filter(log => log.status === 'success').length
  const failedCount = logs.value.filter(log => log.status === 'failed').length
  const today = new Date().toDateString()
  const todayCount = logs.value.filter(log => 
    new Date(log.timestamp).toDateString() === today
  ).length

  return {
    successCount,
    failedCount,
    todayCount
  }
})

// 方法
const fetchLogs = async () => {
  try {
    loading.value = true
    const params = {
      page: pagination.page,
      limit: pagination.limit,
      search: filters.search || undefined,
      action: filters.action || undefined,
      status: filters.status || undefined,
      startDate: filters.startDate || undefined,
      endDate: filters.endDate || undefined
    }

    const response = await adminAPI.getUserLogs(params)
    if (response.success) {
      logs.value = response.data.logs
      pagination.total = response.data.total
    }
  } catch (error) {
    ElMessage.error('获取日志列表失败')
    console.error('获取日志列表失败:', error)
  } finally {
    loading.value = false
  }
}

const refreshLogs = () => {
  fetchLogs()
}

const handleSearch = () => {
  pagination.page = 1
  fetchLogs()
}

const handleFilter = () => {
  pagination.page = 1
  fetchLogs()
}

const handleDateChange = (dates) => {
  if (dates && dates.length === 2) {
    filters.startDate = dates[0]
    filters.endDate = dates[1]
  } else {
    filters.startDate = ''
    filters.endDate = ''
  }
  pagination.page = 1
  fetchLogs()
}

const handleSortChange = ({ prop, order }) => {
  // 这里可以实现服务端排序
  fetchLogs()
}

const handleSizeChange = (size) => {
  pagination.limit = size
  pagination.page = 1
  fetchLogs()
}

const handleCurrentChange = (page) => {
  pagination.page = page
  fetchLogs()
}

const viewDetails = (log) => {
  selectedLog.value = log
  showDetailDialog.value = true
}

const exportLogs = async () => {
  try {
    exportLoading.value = true
    const params = {
      search: filters.search || undefined,
      action: filters.action || undefined,
      status: filters.status || undefined,
      startDate: filters.startDate || undefined,
      endDate: filters.endDate || undefined
    }

    await adminAPI.exportUserLogs(params)
    ElMessage.success('日志导出成功')
  } catch (error) {
    ElMessage.error('导出日志失败')
    console.error('导出日志失败:', error)
  } finally {
    exportLoading.value = false
  }
}

const handleCleanup = async () => {
  try {
    await cleanupFormRef.value.validate()
    
    await ElMessageBox.confirm(
      `确定要删除 ${cleanupForm.daysToKeep} 天前的所有日志记录吗？此操作不可恢复。`,
      '确认清理',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    cleanupLoading.value = true
    const response = await adminAPI.cleanOldLogs(cleanupForm.daysToKeep)
    
    if (response.success) {
      ElMessage.success(`成功清理 ${response.data.deletedCount} 条日志记录`)
      showCleanupDialog.value = false
      await fetchLogs()
    }
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('清理日志失败')
      console.error('清理日志失败:', error)
    }
  } finally {
    cleanupLoading.value = false
  }
}

const getActionType = (action) => {
  const actionTypes = {
    login: 'success',
    logout: 'info',
    register: 'primary',
    password_change: 'warning',
    password_reset_by_admin: 'danger',
    account_deleted_by_admin: 'danger',
    profile_update_by_admin: 'warning'
  }
  return actionTypes[action] || 'info'
}

const getActionText = (action) => {
  const actionTexts = {
    login: '登录',
    logout: '登出',
    register: '注册',
    password_change: '密码修改',
    password_reset_by_admin: '管理员重置密码',
    account_deleted_by_admin: '管理员删除账号',
    profile_update_by_admin: '管理员更新信息',
    account_created_by_admin: '管理员创建账号'
  }
  return actionTexts[action] || action
}

const getStatusType = (status) => {
  const statusTypes = {
    success: 'success',
    failed: 'danger',
    warning: 'warning'
  }
  return statusTypes[status] || 'info'
}

const getStatusText = (status) => {
  const statusTexts = {
    success: '成功',
    failed: '失败',
    warning: '警告'
  }
  return statusTexts[status] || status
}

const formatDate = (dateString) => {
  return new Date(dateString).toLocaleString('zh-CN')
}

// 生命周期
onMounted(() => {
  fetchLogs()
})
</script>

<style scoped>
.admin-user-logs {
  width: 100%;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.header-actions {
  display: flex;
  gap: 10px;
}

.filter-section {
  margin-bottom: 20px;
}

.pagination-section {
  margin-top: 20px;
  display: flex;
  justify-content: center;
}

.stats-section {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid #ebeef5;
}

:deep(.el-table) {
  margin-bottom: 0;
}

:deep(.el-statistic__content) {
  font-size: 24px;
  font-weight: 600;
}

:deep(.el-statistic__title) {
  font-size: 14px;
  color: #909399;
  margin-bottom: 8px;
}

pre {
  background-color: #f5f7fa;
  padding: 12px;
  border-radius: 4px;
  font-size: 12px;
  max-height: 200px;
  overflow-y: auto;
  margin: 0;
}
</style>