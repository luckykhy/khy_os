<template>
  <div class="forgot-password-container">
    <el-card class="forgot-password-card">
      <template #header>
        <div class="card-header">
          <h2>找回密码</h2>
          <p>通过密保问题重置您的密码</p>
        </div>
      </template>
      
      <!-- 步骤1：输入用户名 -->
      <div v-if="step === 1">
        <el-form
          ref="usernameFormRef"
          :model="usernameForm"
          :rules="usernameRules"
          label-width="0"
        >
          <el-form-item prop="username">
            <el-input
              v-model="usernameForm.username"
              placeholder="请输入用户名或邮箱"
              size="large"
              prefix-icon="User"
            />
          </el-form-item>
          
          <el-form-item>
            <el-button
              type="primary"
              size="large"
              :loading="loading"
              @click="handleGetQuestion"
              style="width: 100%"
            >
              下一步
            </el-button>
          </el-form-item>
        </el-form>
      </div>
      
      <!-- 步骤2：回答密保问题 -->
      <div v-if="step === 2">
        <el-alert
          :title="`用户名：${currentUsername}`"
          type="info"
          :closable="false"
          style="margin-bottom: 20px"
        />
        
        <el-form
          ref="resetFormRef"
          :model="resetForm"
          :rules="resetRules"
          label-width="0"
        >
          <el-form-item>
            <div class="security-question">
              <el-icon><QuestionFilled /></el-icon>
              <span>{{ securityQuestion }}</span>
            </div>
          </el-form-item>
          
          <el-form-item prop="securityAnswer">
            <el-input
              v-model="resetForm.securityAnswer"
              placeholder="请输入密保答案"
              size="large"
              prefix-icon="Key"
            />
          </el-form-item>
          
          <el-form-item prop="newPassword">
            <el-input
              v-model="resetForm.newPassword"
              type="password"
              placeholder="请输入新密码（至少6个字符）"
              size="large"
              prefix-icon="Lock"
            />
          </el-form-item>
          
          <el-form-item prop="confirmPassword">
            <el-input
              v-model="resetForm.confirmPassword"
              type="password"
              placeholder="确认新密码"
              size="large"
              prefix-icon="Lock"
            />
          </el-form-item>
          
          <el-form-item>
            <el-button
              type="primary"
              size="large"
              :loading="loading"
              @click="handleResetPassword"
              style="width: 100%"
            >
              重置密码
            </el-button>
          </el-form-item>
          
          <el-form-item>
            <el-button
              size="large"
              @click="step = 1"
              style="width: 100%"
            >
              返回上一步
            </el-button>
          </el-form-item>
        </el-form>
      </div>
      
      <!-- 返回登录链接 -->
      <div class="login-link">
        记起密码了？
        <router-link to="/login">返回登录</router-link>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { QuestionFilled } from '@element-plus/icons-vue'
import request from '@/api/request'

const router = useRouter()

const step = ref(1) // 1: 输入用户名, 2: 回答密保问题
const loading = ref(false)
const currentUsername = ref('')
const securityQuestion = ref('')

const usernameFormRef = ref(null)
const resetFormRef = ref(null)

const usernameForm = reactive({
  username: ''
})

const resetForm = reactive({
  securityAnswer: '',
  newPassword: '',
  confirmPassword: ''
})

const validateConfirmPassword = (rule, value, callback) => {
  if (value !== resetForm.newPassword) {
    callback(new Error('两次输入的密码不一致'))
  } else {
    callback()
  }
}

const usernameRules = {
  username: [
    { required: true, message: '请输入用户名或邮箱', trigger: 'blur' }
  ]
}

const resetRules = {
  securityAnswer: [
    { required: true, message: '请输入密保答案', trigger: 'blur' }
  ],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少6个字符', trigger: 'blur' }
  ],
  confirmPassword: [
    { required: true, message: '请确认新密码', trigger: 'blur' },
    { validator: validateConfirmPassword, trigger: 'blur' }
  ]
}

// 获取密保问题
const handleGetQuestion = async () => {
  if (!usernameFormRef.value) return
  
  await usernameFormRef.value.validate(async (valid) => {
    if (valid) {
      loading.value = true
      try {
        const isEmail = usernameForm.username.includes('@')
        const payload = isEmail 
          ? { email: usernameForm.username }
          : { username: usernameForm.username }
        
        const response = await request.post('/password-reset/get-question', payload)
        
        if (response.data.success) {
          currentUsername.value = response.data.data.username
          securityQuestion.value = response.data.data.securityQuestion
          step.value = 2
        }
      } catch (error) {
        ElMessage.error(error.response?.data?.message || '获取密保问题失败')
      } finally {
        loading.value = false
      }
    }
  })
}

// 重置密码
const handleResetPassword = async () => {
  if (!resetFormRef.value) return
  
  await resetFormRef.value.validate(async (valid) => {
    if (valid) {
      loading.value = true
      try {
        const response = await request.post('/password-reset/reset', {
          username: currentUsername.value,
          securityAnswer: resetForm.securityAnswer,
          newPassword: resetForm.newPassword
        })
        
        if (response.data.success) {
          ElMessage.success('密码重置成功，请使用新密码登录')
          router.push('/login')
        }
      } catch (error) {
        ElMessage.error(error.response?.data?.message || '密码重置失败')
      } finally {
        loading.value = false
      }
    }
  })
}
</script>

<style scoped>
.forgot-password-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background-image: url('/assets/login-background.jpg');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  position: relative;
  background-color: #667eea;
}

.forgot-password-container::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.2);
  z-index: 0;
}

.forgot-password-card {
  width: 460px;
  position: relative;
  z-index: 1;
  backdrop-filter: blur(10px);
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.card-header {
  text-align: center;
  padding: 10px 0;
}

.card-header h2 {
  margin: 0 0 10px 0;
  color: #303133;
  font-size: 28px;
  font-weight: 600;
}

.card-header p {
  margin: 0;
  color: #606266;
  font-size: 14px;
}

.security-question {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  background: #f5f7fa;
  border-radius: 8px;
  color: #606266;
  font-size: 15px;
}

.security-question .el-icon {
  font-size: 20px;
  color: #409eff;
}

.login-link {
  text-align: center;
  color: #909399;
  font-size: 14px;
  margin-top: 20px;
}

.login-link a {
  color: #409eff;
  text-decoration: none;
  font-weight: 500;
}

.login-link a:hover {
  text-decoration: underline;
  color: #66b1ff;
}

:deep(.el-form-item) {
  margin-bottom: 24px;
}

:deep(.el-input__wrapper) {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  border-radius: 8px;
}

:deep(.el-button--primary) {
  border-radius: 8px;
  font-size: 16px;
  font-weight: 500;
  height: 44px;
  background: linear-gradient(135deg, #409eff 0%, #1890ff 100%);
  border: none;
  transition: transform 0.3s ease, box-shadow 0.3s ease;
}

:deep(.el-button--primary:hover) {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(24, 144, 255, 0.4);
}

:deep(.el-button--primary:active) {
  transform: translateY(0);
}

:deep(.el-button--default) {
  border-radius: 8px;
  font-size: 16px;
  height: 44px;
}
</style>
