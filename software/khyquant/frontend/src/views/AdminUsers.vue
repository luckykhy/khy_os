<template>
  <div class="admin-users">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>👥 用户管理</span>
          <div class="header-actions">
            <el-button type="primary" size="small" @click="showCreateDialog = true">
              <el-icon><Plus /></el-icon>
              添加用户
            </el-button>
            <el-button size="small" @click="refreshUsers">
              <el-icon><Refresh /></el-icon>
              刷新
            </el-button>
          </div>
        </div>
      </template>

      <!-- 搜索和筛选 -->
      <div class="search-section">
        <el-row :gutter="20">
          <el-col :span="8">
            <el-input
              v-model="searchKeyword"
              placeholder="搜索用户名或邮箱"
              clearable
              @input="handleSearch"
            >
              <template #prefix>
                <el-icon><Search /></el-icon>
              </template>
            </el-input>
          </el-col>
          <el-col :span="4">
            <el-select v-model="filterRole" placeholder="角色筛选" clearable @change="handleFilter">
              <el-option label="全部角色" value="" />
              <el-option label="管理员" value="admin" />
              <el-option label="普通用户" value="user" />
            </el-select>
          </el-col>
          <el-col :span="4">
            <el-select v-model="filterStatus" placeholder="状态筛选" clearable @change="handleFilter">
              <el-option label="全部状态" value="" />
              <el-option label="活跃" value="active" />
              <el-option label="非活跃" value="inactive" />
              <el-option label="已封禁" value="banned" />
            </el-select>
          </el-col>
        </el-row>
      </div>

      <!-- 用户列表 -->
      <el-table
        v-if="!isMobile"
        v-loading="loading"
        :data="filteredUsers"
        style="width: 100%"
        @sort-change="handleSortChange"
      >
        <el-table-column prop="id" label="ID" width="80" sortable />
        <el-table-column prop="username" label="用户名" min-width="120" sortable />
        <el-table-column prop="email" label="邮箱" min-width="180" sortable />
        <el-table-column prop="role" label="角色" width="100" sortable>
          <template #default="{ row }">
            <el-tag :type="row.role === 'admin' ? 'danger' : 'primary'" size="small">
              {{ row.role === 'admin' ? '管理员' : '用户' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100" sortable>
          <template #default="{ row }">
            <el-tag
              :type="getStatusType(row.status)"
              size="small"
            >
              {{ getStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="lastLoginAt" label="最后登录" width="160" sortable>
          <template #default="{ row }">
            {{ row.lastLoginAt ? formatDate(row.lastLoginAt) : '从未登录' }}
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="注册时间" width="160" sortable>
          <template #default="{ row }">
            {{ formatDate(row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="editUser(row)">编辑</el-button>
            <el-button size="small" type="warning" @click="resetPassword(row)">重置密码</el-button>
            <el-button
              size="small"
              type="danger"
              @click="deleteUser(row)"
              :disabled="row.id === currentUser?.id"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 移动端：卡片布局 -->
      <div v-else class="mobile-user-cards" v-loading="loading">
        <!-- 空状态提示 -->
        <div v-if="!loading && filteredUsers.length === 0" class="empty-state">
          <el-icon :size="48" color="#999"><User /></el-icon>
          <p class="empty-text">暂无用户数据</p>
          <p class="empty-hint">请检查网络连接或刷新页面</p>
          <el-button type="primary" @click="refreshUsers" style="margin-top: 16px;">
            <el-icon><Refresh /></el-icon>
            刷新
          </el-button>
        </div>
        
        <!-- 用户卡片列表 -->
        <div 
          v-for="user in filteredUsers" 
          :key="user.id"
          class="user-card"
        >
          <div class="card-header">
            <div class="user-info">
              <div class="username">{{ user.username }}</div>
              <div class="email">{{ user.email }}</div>
            </div>
            <el-tag :type="user.role === 'admin' ? 'danger' : 'primary'" size="small">
              {{ user.role === 'admin' ? '管理员' : '用户' }}
            </el-tag>
          </div>
          
          <div class="card-body">
            <div class="info-row">
              <span class="label">ID</span>
              <span class="value">{{ user.id }}</span>
            </div>
            <div class="info-row">
              <span class="label">状态</span>
              <el-tag :type="getStatusType(user.status)" size="small">
                {{ getStatusText(user.status) }}
              </el-tag>
            </div>
            <div class="info-row">
              <span class="label">最后登录</span>
              <span class="value">{{ user.lastLoginAt ? formatDate(user.lastLoginAt) : '从未登录' }}</span>
            </div>
            <div class="info-row">
              <span class="label">注册时间</span>
              <span class="value">{{ formatDate(user.createdAt) }}</span>
            </div>
          </div>
          
          <div class="card-actions">
            <el-button size="small" @click="editUser(user)">编辑</el-button>
            <el-button size="small" type="warning" @click="resetPassword(user)">重置密码</el-button>
            <el-button
              size="small"
              type="danger"
              @click="deleteUser(user)"
              :disabled="user.id === currentUser?.id"
            >
              删除
            </el-button>
          </div>
        </div>
      </div>

      <!-- 统计信息 -->
      <div class="stats-section">
        <el-row :gutter="20">
          <el-col :span="6">
            <el-statistic title="总用户数" :value="users.length" />
          </el-col>
          <el-col :span="6">
            <el-statistic title="管理员" :value="adminCount" />
          </el-col>
          <el-col :span="6">
            <el-statistic title="活跃用户" :value="activeCount" />
          </el-col>
          <el-col :span="6">
            <el-statistic title="今日注册" :value="todayRegistered" />
          </el-col>
        </el-row>
      </div>
    </el-card>

    <!-- 创建用户对话框 -->
    <el-dialog
      v-model="showCreateDialog"
      title="创建新用户"
      width="500px"
      @close="resetCreateForm"
    >
      <el-form
        ref="createFormRef"
        :model="createForm"
        :rules="createRules"
        label-width="80px"
      >
        <el-form-item label="用户名" prop="username">
          <el-input v-model="createForm.username" placeholder="请输入用户名" />
        </el-form-item>
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="createForm.email" placeholder="请输入邮箱" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input
            v-model="createForm.password"
            type="password"
            placeholder="请输入密码"
            show-password
          />
        </el-form-item>
        <el-form-item label="角色" prop="role">
          <el-select v-model="createForm.role" placeholder="请选择角色">
            <el-option label="普通用户" value="user" />
            <el-option label="管理员" value="admin" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态" prop="status">
          <el-select v-model="createForm.status" placeholder="请选择状态">
            <el-option label="活跃" value="active" />
            <el-option label="非活跃" value="inactive" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreateDialog = false">取消</el-button>
        <el-button type="primary" @click="handleCreateUser" :loading="createLoading">
          创建
        </el-button>
      </template>
    </el-dialog>

    <!-- 编辑用户对话框 -->
    <el-dialog
      v-model="showEditDialog"
      title="编辑用户"
      width="500px"
      @close="resetEditForm"
    >
      <el-form
        ref="editFormRef"
        :model="editForm"
        :rules="editRules"
        label-width="80px"
      >
        <el-form-item label="用户名" prop="username">
          <el-input v-model="editForm.username" placeholder="请输入用户名" />
        </el-form-item>
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="editForm.email" placeholder="请输入邮箱" />
        </el-form-item>
        <el-form-item label="角色" prop="role">
          <el-select v-model="editForm.role" placeholder="请选择角色">
            <el-option label="普通用户" value="user" />
            <el-option label="管理员" value="admin" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态" prop="status">
          <el-select v-model="editForm.status" placeholder="请选择状态">
            <el-option label="活跃" value="active" />
            <el-option label="非活跃" value="inactive" />
            <el-option label="已封禁" value="banned" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditDialog = false">取消</el-button>
        <el-button type="primary" @click="handleEditUser" :loading="editLoading">
          保存
        </el-button>
      </template>
    </el-dialog>

    <!-- 重置密码对话框 -->
    <el-dialog
      v-model="showPasswordDialog"
      title="重置密码"
      width="400px"
    >
      <el-form
        ref="passwordFormRef"
        :model="passwordForm"
        :rules="passwordRules"
        label-width="80px"
      >
        <el-form-item label="用户">
          <el-input :value="selectedUser?.username" disabled />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input
            v-model="passwordForm.newPassword"
            type="password"
            placeholder="请输入新密码"
            show-password
          />
        </el-form-item>
        <el-form-item label="确认密码" prop="confirmPassword">
          <el-input
            v-model="passwordForm.confirmPassword"
            type="password"
            placeholder="请再次输入新密码"
            show-password
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showPasswordDialog = false">取消</el-button>
        <el-button type="primary" @click="handleResetPassword" :loading="passwordLoading">
          重置
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import { adminAPI } from '@/api/admin'
import { useUserStore } from '@/stores/user'
import { useResponsive } from '@/composables/useResponsive'

const userStore = useUserStore()
const currentUser = computed(() => userStore.user)

// 响应式布局
const { isMobile, isTablet } = useResponsive()

// 在组件加载时输出调试信息
console.log('👥 AdminUsers组件加载')
console.log('📱 isMobile:', isMobile.value)
console.log('📱 isTablet:', isTablet.value)
console.log('📱 屏幕宽度:', window.innerWidth)
console.log('👤 当前用户:', currentUser.value)

// 数据状态
const loading = ref(false)
const users = ref([])
const searchKeyword = ref('')
const filterRole = ref('')
const filterStatus = ref('')

// 对话框状态
const showCreateDialog = ref(false)
const showEditDialog = ref(false)
const showPasswordDialog = ref(false)
const createLoading = ref(false)
const editLoading = ref(false)
const passwordLoading = ref(false)

// 选中的用户
const selectedUser = ref(null)

// 创建用户表单
const createForm = reactive({
  username: '',
  email: '',
  password: '',
  role: 'user',
  status: 'active'
})

const createFormRef = ref()
const createRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, max: 50, message: '用户名长度在 3 到 50 个字符', trigger: 'blur' }
  ],
  email: [
    { required: true, message: '请输入邮箱', trigger: 'blur' },
    { type: 'email', message: '请输入正确的邮箱格式', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少6位', trigger: 'blur' }
  ],
  role: [
    { required: true, message: '请选择角色', trigger: 'change' }
  ],
  status: [
    { required: true, message: '请选择状态', trigger: 'change' }
  ]
}

// 编辑用户表单
const editForm = reactive({
  id: null,
  username: '',
  email: '',
  role: '',
  status: ''
})

const editFormRef = ref()
const editRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, max: 50, message: '用户名长度在 3 到 50 个字符', trigger: 'blur' }
  ],
  email: [
    { required: true, message: '请输入邮箱', trigger: 'blur' },
    { type: 'email', message: '请输入正确的邮箱格式', trigger: 'blur' }
  ],
  role: [
    { required: true, message: '请选择角色', trigger: 'change' }
  ],
  status: [
    { required: true, message: '请选择状态', trigger: 'change' }
  ]
}

// 重置密码表单
const passwordForm = reactive({
  newPassword: '',
  confirmPassword: ''
})

const passwordFormRef = ref()
const passwordRules = {
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少6位', trigger: 'blur' }
  ],
  confirmPassword: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    {
      validator: (rule, value, callback) => {
        if (value !== passwordForm.newPassword) {
          callback(new Error('两次输入的密码不一致'))
        } else {
          callback()
        }
      },
      trigger: 'blur'
    }
  ]
}

// 计算属性
const filteredUsers = computed(() => {
  let result = users.value

  // 搜索过滤
  if (searchKeyword.value) {
    const keyword = searchKeyword.value.toLowerCase()
    result = result.filter(user =>
      user.username.toLowerCase().includes(keyword) ||
      user.email.toLowerCase().includes(keyword)
    )
  }

  // 角色过滤
  if (filterRole.value) {
    result = result.filter(user => user.role === filterRole.value)
  }

  // 状态过滤
  if (filterStatus.value) {
    result = result.filter(user => user.status === filterStatus.value)
  }

  return result
})

const adminCount = computed(() => users.value.filter(user => user.role === 'admin').length)
const activeCount = computed(() => users.value.filter(user => user.status === 'active').length)
const todayRegistered = computed(() => {
  const today = new Date().toDateString()
  return users.value.filter(user => new Date(user.createdAt).toDateString() === today).length
})

// 方法
const fetchUsers = async () => {
  try {
    loading.value = true
    console.log('📋 开始加载用户列表...')
    console.log('📱 isMobile:', isMobile.value)
    console.log('📱 isTablet:', isTablet.value)
    console.log('📱 屏幕宽度:', window.innerWidth)
    
    const response = await adminAPI.getUsers()
    console.log('✅ API响应:', response)
    
    if (response.success) {
      users.value = response.data
      console.log(`✅ 成功加载 ${users.value.length} 个用户`)
      console.log('📊 用户数据:', users.value.slice(0, 2)) // 显示前2个用户
    } else {
      console.error('❌ API返回失败:', response)
      ElMessage.error('获取用户列表失败: ' + (response.message || '未知错误'))
    }
  } catch (error) {
    console.error('❌ 获取用户列表失败:', error)
    console.error('❌ 错误详情:', error.response?.data)
    console.error('❌ 错误状态码:', error.response?.status)
    
    // 更详细的错误提示
    let errorMsg = '获取用户列表失败'
    if (error.response?.status === 401) {
      errorMsg = '未授权,请重新登录'
    } else if (error.response?.status === 403) {
      errorMsg = '权限不足,需要管理员权限'
    } else if (error.response?.data?.message) {
      errorMsg = error.response.data.message
    } else if (error.message) {
      errorMsg = error.message
    }
    
    ElMessage.error(errorMsg)
  } finally {
    loading.value = false
  }
}

const refreshUsers = () => {
  fetchUsers()
}

const handleSearch = () => {
  // 搜索逻辑已在计算属性中处理
}

const handleFilter = () => {
  // 筛选逻辑已在计算属性中处理
}

const handleSortChange = ({ prop, order }) => {
  // 排序逻辑
  if (!order) return
  
  users.value.sort((a, b) => {
    let aVal = a[prop]
    let bVal = b[prop]
    
    if (prop === 'createdAt' || prop === 'lastLoginAt') {
      aVal = new Date(aVal).getTime()
      bVal = new Date(bVal).getTime()
    }
    
    if (order === 'ascending') {
      return aVal > bVal ? 1 : -1
    } else {
      return aVal < bVal ? 1 : -1
    }
  })
}

const editUser = (user) => {
  selectedUser.value = user
  editForm.id = user.id
  editForm.username = user.username
  editForm.email = user.email
  editForm.role = user.role
  editForm.status = user.status
  showEditDialog.value = true
}

const resetPassword = (user) => {
  selectedUser.value = user
  passwordForm.newPassword = ''
  passwordForm.confirmPassword = ''
  showPasswordDialog.value = true
}

const deleteUser = async (user) => {
  if (user.id === currentUser.value?.id) {
    ElMessage.warning('不能删除自己的账号')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确定要删除用户 "${user.username}" 吗？此操作不可恢复。`,
      '确认删除',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    const response = await adminAPI.deleteUser(user.id)
    if (response.success) {
      ElMessage.success('用户删除成功')
      await fetchUsers()
    }
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('删除用户失败')
      console.error('删除用户失败:', error)
    }
  }
}

const handleCreateUser = async () => {
  try {
    await createFormRef.value.validate()
    createLoading.value = true

    const response = await adminAPI.createUser(createForm)
    if (response.success) {
      ElMessage.success('用户创建成功')
      showCreateDialog.value = false
      await fetchUsers()
    }
  } catch (error) {
    if (error.response?.data?.message) {
      ElMessage.error(error.response.data.message)
    } else {
      ElMessage.error('创建用户失败')
    }
    console.error('创建用户失败:', error)
  } finally {
    createLoading.value = false
  }
}

const handleEditUser = async () => {
  try {
    await editFormRef.value.validate()
    editLoading.value = true

    const response = await adminAPI.updateUser(editForm.id, {
      username: editForm.username,
      email: editForm.email,
      role: editForm.role,
      status: editForm.status
    })

    if (response.success) {
      ElMessage.success('用户信息更新成功')
      showEditDialog.value = false
      await fetchUsers()
    }
  } catch (error) {
    if (error.response?.data?.message) {
      ElMessage.error(error.response.data.message)
    } else {
      ElMessage.error('更新用户失败')
    }
    console.error('更新用户失败:', error)
  } finally {
    editLoading.value = false
  }
}

const handleResetPassword = async () => {
  try {
    await passwordFormRef.value.validate()
    passwordLoading.value = true

    const response = await adminAPI.resetUserPassword(
      selectedUser.value.id,
      passwordForm.newPassword
    )

    if (response.success) {
      ElMessage.success('密码重置成功')
      showPasswordDialog.value = false
    }
  } catch (error) {
    if (error.response?.data?.message) {
      ElMessage.error(error.response.data.message)
    } else {
      ElMessage.error('重置密码失败')
    }
    console.error('重置密码失败:', error)
  } finally {
    passwordLoading.value = false
  }
}

const resetCreateForm = () => {
  createForm.username = ''
  createForm.email = ''
  createForm.password = ''
  createForm.role = 'user'
  createForm.status = 'active'
  createFormRef.value?.resetFields()
}

const resetEditForm = () => {
  editFormRef.value?.resetFields()
}

const getStatusType = (status) => {
  const statusMap = {
    active: 'success',
    inactive: 'warning',
    banned: 'danger'
  }
  return statusMap[status] || 'info'
}

const getStatusText = (status) => {
  const statusMap = {
    active: '活跃',
    inactive: '非活跃',
    banned: '已封禁'
  }
  return statusMap[status] || status
}

const formatDate = (dateString) => {
  return new Date(dateString).toLocaleString('zh-CN')
}

// 生命周期
onMounted(() => {
  console.log('👥 AdminUsers onMounted')
  console.log('📱 isMobile:', isMobile.value)
  console.log('📱 屏幕宽度:', window.innerWidth)
  console.log('👤 当前用户:', currentUser.value)
  console.log('👤 用户角色:', currentUser.value?.role)
  
  // 检查权限
  if (!currentUser.value) {
    console.error('❌ 未登录')
    ElMessage.error('请先登录')
    return
  }
  
  if (currentUser.value.role !== 'admin') {
    console.error('❌ 权限不足,当前角色:', currentUser.value.role)
    ElMessage.error('权限不足,需要管理员权限')
    return
  }
  
  console.log('✅ 权限检查通过,开始加载用户列表')
  fetchUsers()
})
</script>

<style scoped>
.admin-users {
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

.search-section {
  margin-bottom: 20px;
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

/* 移动端样式 */
@media (max-width: 768px) {
  .admin-users {
    padding: 12px;
  }

  /* 搜索区域垂直堆叠 */
  .search-section :deep(.el-row) {
    flex-direction: column;
  }

  .search-section :deep(.el-col) {
    width: 100% !important;
    max-width: 100% !important;
    margin-bottom: 12px;
  }

  /* 头部操作按钮 */
  .header-actions {
    flex-direction: column;
    gap: 8px;
    width: 100%;
  }

  .header-actions .el-button {
    width: 100%;
    min-height: 44px;
  }

  /* 用户卡片 */
  .mobile-user-cards {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .user-card {
    background: white;
    border-radius: var(--radius-md);
    padding: 16px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    transition: all 0.3s ease;
    min-height: 44px;
  }

  .user-card:active {
    transform: scale(0.98);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  }

  .user-card .card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid #f0f0f0;
  }

  .user-card .user-info {
    flex: 1;
  }

  .user-card .username {
    font-size: 16px;
    font-weight: 600;
    color: #1f2937;
    margin-bottom: 4px;
  }

  .user-card .email {
    font-size: 13px;
    color: #6b7280;
  }

  .user-card .card-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
  }

  .user-card .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
  }

  .user-card .info-row .label {
    color: #6b7280;
    font-weight: 500;
  }

  .user-card .info-row .value {
    color: #1f2937;
  }

  .user-card .card-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .user-card .card-actions .el-button {
    flex: 1;
    min-width: 80px;
    min-height: 44px;
  }

  /* 对话框移动端优化 */
  :deep(.el-dialog) {
    width: 95% !important;
    max-width: 500px;
    margin: 20px auto;
  }

  :deep(.el-dialog__body) {
    max-height: 60vh;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  /* 表单字段垂直堆叠 */
  :deep(.el-form-item) {
    margin-bottom: 16px;
  }

  :deep(.el-form-item__label) {
    width: 100% !important;
    text-align: left;
    margin-bottom: 8px;
  }

  :deep(.el-form-item__content) {
    margin-left: 0 !important;
  }

  /* 输入框全宽 */
  :deep(.el-input),
  :deep(.el-select) {
    width: 100%;
  }

  /* 对话框按钮全宽 */
  :deep(.el-dialog__footer) {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  :deep(.el-dialog__footer .el-button) {
    width: 100%;
    margin: 0;
    min-height: 44px;
  }

  /* 统计信息区域 */
  .stats-section :deep(.el-row) {
    flex-direction: column;
  }

  .stats-section :deep(.el-col) {
    width: 100% !important;
    max-width: 100% !important;
    margin-bottom: 16px;
  }
  
  /* 空状态样式 */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 60px 20px;
    text-align: center;
    background: white;
    border-radius: var(--radius-md);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  }
  
  .empty-state .empty-text {
    margin: 16px 0 8px;
    font-size: 16px;
    font-weight: 600;
    color: #1f2937;
  }
  
  .empty-state .empty-hint {
    margin: 0;
    font-size: 13px;
    color: #6b7280;
  }
}
</style>