<template>
  <div class="register-container">
    <el-card class="register-card">
      <template #header>
        <div class="card-header">
          <h2>用户注册</h2>
          <p>创建您的量化交易账户</p>
        </div>
      </template>
      
      <el-form
        ref="registerFormRef"
        :model="registerForm"
        :rules="rules"
        label-width="0"
      >
        <el-form-item prop="username">
          <el-input
            v-model="registerForm.username"
            placeholder="用户名（3-50个字符）"
            size="large"
            prefix-icon="User"
          />
        </el-form-item>
        
        <el-form-item prop="email">
          <el-input
            v-model="registerForm.email"
            placeholder="邮箱地址"
            size="large"
            prefix-icon="Message"
          />
        </el-form-item>
        
        <el-form-item prop="password">
          <el-input
            v-model="registerForm.password"
            type="password"
            placeholder="密码（至少6个字符）"
            size="large"
            prefix-icon="Lock"
          />
        </el-form-item>
        
        <el-form-item prop="confirmPassword">
          <el-input
            v-model="registerForm.confirmPassword"
            type="password"
            placeholder="确认密码"
            size="large"
            prefix-icon="Lock"
          />
        </el-form-item>
        
        <el-divider content-position="left">
          <span style="color: #909399; font-size: 14px;">密保问题（可选，用于找回密码）</span>
        </el-divider>
        
        <el-form-item prop="securityQuestion">
          <el-select
            v-model="registerForm.securityQuestion"
            placeholder="选择密保问题"
            size="large"
            style="width: 100%"
          >
            <el-option label="您的出生地是？" value="您的出生地是？" />
            <el-option label="您母亲的姓名是？" value="您母亲的姓名是？" />
            <el-option label="您的小学名称是？" value="您的小学名称是？" />
            <el-option label="您最喜欢的颜色是？" value="您最喜欢的颜色是？" />
            <el-option label="您的第一个宠物名字是？" value="您的第一个宠物名字是？" />
            <el-option label="您最喜欢的电影是？" value="您最喜欢的电影是？" />
          </el-select>
        </el-form-item>
        
        <el-form-item prop="securityAnswer" v-if="registerForm.securityQuestion">
          <el-input
            v-model="registerForm.securityAnswer"
            placeholder="输入密保答案"
            size="large"
            prefix-icon="QuestionFilled"
          />
        </el-form-item>
        
        <el-form-item>
          <el-button
            type="primary"
            size="large"
            :loading="loading"
            @click="handleRegister"
            style="width: 100%"
          >
            注册
          </el-button>
        </el-form-item>
        
        <el-form-item>
          <div class="login-link">
            已有账号？
            <router-link to="/login">立即登录</router-link>
          </div>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { ElMessage } from 'element-plus'

const router = useRouter()
const userStore = useUserStore()

const registerFormRef = ref(null)
const loading = ref(false)

const registerForm = reactive({
  username: '',
  email: '',
  password: '',
  confirmPassword: '',
  securityQuestion: '',
  securityAnswer: ''
})

const validateConfirmPassword = (rule, value, callback) => {
  if (value !== registerForm.password) {
    callback(new Error('两次输入的密码不一致'))
  } else {
    callback()
  }
}

const rules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, max: 50, message: '用户名长度必须在3-50个字符之间', trigger: 'blur' }
  ],
  email: [
    { required: true, message: '请输入邮箱地址', trigger: 'blur' },
    { type: 'email', message: '请输入有效的邮箱地址', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少6个字符', trigger: 'blur' }
  ],
  confirmPassword: [
    { required: true, message: '请确认密码', trigger: 'blur' },
    { validator: validateConfirmPassword, trigger: 'blur' }
  ],
  securityQuestion: [
    { required: false, message: '请选择密保问题', trigger: 'change' }
  ],
  securityAnswer: [
    { required: false, message: '请输入密保答案', trigger: 'blur' },
    { min: 2, message: '密保答案至少2个字符', trigger: 'blur' }
  ]
}

const handleRegister = async () => {
  if (!registerFormRef.value) return
  
  await registerFormRef.value.validate(async (valid) => {
    if (valid) {
      loading.value = true
      try {
        const userData = {
          username: registerForm.username,
          email: registerForm.email,
          password: registerForm.password
        }
        
        // 如果设置了密保问题，添加到注册数据中
        if (registerForm.securityQuestion && registerForm.securityAnswer) {
          userData.securityQuestion = registerForm.securityQuestion
          userData.securityAnswer = registerForm.securityAnswer
        }
        
        await userStore.registerUser(userData)
        ElMessage.success('注册成功')
        router.push('/dashboard')
      } catch (error) {
        ElMessage.error(error.response?.data?.message || '注册失败')
      } finally {
        loading.value = false
      }
    }
  })
}
</script>

<style scoped>
.register-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  /* 使用与登录页相同的背景图片 */
  background-image: url('/assets/login-background.jpg');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  position: relative;
  background-color: #667eea;
}

.register-container::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.2);
  z-index: 0;
}

.register-card {
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

.login-link {
  text-align: center;
  color: #909399;
  font-size: 14px;
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

/* 优化表单样式 */
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
</style>
