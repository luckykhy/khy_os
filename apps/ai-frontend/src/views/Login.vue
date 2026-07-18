<template>
  <div class="login-shell">
    <div class="login-orb login-orb--1" aria-hidden="true"></div>
    <div class="login-orb login-orb--2" aria-hidden="true"></div>

    <el-card class="login-card" shadow="always">
      <div class="login-brand">
        <span class="khy-brand-logo khy-brand-logo--md">K</span>
        <div class="login-brand-meta">
          <h2 class="login-title">KHY AI 统一入口</h2>
          <p class="login-subtitle">登录以进入你的 AI 网关与工作台</p>
        </div>
      </div>

      <el-form @submit.prevent="handleLogin" :model="form" class="login-form">
        <el-form-item>
          <el-input v-model="form.username" size="large" placeholder="用户名" prefix-icon="User" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="form.password" size="large" placeholder="密码" type="password" prefix-icon="Lock" show-password />
        </el-form-item>

        <div class="login-row">
          <el-button text type="primary" class="login-fill-btn" @click="fillDefaultAdmin">
            使用默认管理员账号填充
          </el-button>
        </div>

        <el-form-item v-if="error" class="login-error-item">
          <el-alert :title="error" type="error" show-icon :closable="false" />
        </el-form-item>

        <el-button type="primary" native-type="submit" size="large" :loading="loading" class="login-submit">
          校验账号并进入用户首页
        </el-button>
      </el-form>

      <p class="login-hint">
        登录后默认进入用户视图；若账号为管理员，可在顶部开关切换到管理员视图。
      </p>
    </el-card>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'

const router = useRouter()
const userStore = useUserStore()
const loading = ref(false)
const error = ref('')
const form = reactive({ username: '', password: '' })

function fillDefaultAdmin() {
  form.username = 'admin'
  form.password = 'admin123' // pragma: allowlist secret — 「填充默认管理员」便捷按钮的示范默认口令,非真实凭据
}

function mapLoginError(err) {
  const serverMsg = String(err?.response?.data?.message || err?.response?.data?.error || '').trim()
  const localMsg = String(err?.message || '').trim()
  const raw = serverMsg || localMsg
  const lower = raw.toLowerCase()

  if (!raw) return '登录失败，请稍后重试'
  if (err?.response?.status === 401 || lower.includes('invalid username or password')) {
    return '用户名或密码错误。请使用交易系统管理员账号，默认可尝试 admin / admin123。'
  }
  if (err?.response?.status === 403 || lower.includes('not active')) {
    return '账号未激活，请检查用户状态。'
  }
  if (lower.includes('jwt_secret') || lower.includes('not configured')) {
    return '后端认证配置缺失（JWT_SECRET）。请先检查 .env 后重启服务。'
  }
  if (lower.includes('network error') || lower.includes('econnrefused') || lower.includes('failed to fetch')) {
    return '无法连接 AI 管理后端（Network Error）。请确认 ai-backend 服务 healthy，且当前页面 API 代理配置正确。'
  }
  return raw
}

async function handleLogin() {
  loading.value = true
  error.value = ''
  try {
    await userStore.login(form.username, form.password)
    router.push('/home')
  } catch (err) {
    error.value = mapLoginError(err)
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-shell {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  padding: 12px;
  overflow: hidden;
}

/* Ambient brand glow behind the card */
.login-orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  opacity: 0.5;
  pointer-events: none;
  animation: login-float 14s ease-in-out infinite;
}

.login-orb--1 {
  width: 420px;
  height: 420px;
  top: -120px;
  left: -80px;
  background: radial-gradient(circle, var(--khy-primary), transparent 70%);
}

.login-orb--2 {
  width: 360px;
  height: 360px;
  bottom: -120px;
  right: -60px;
  background: radial-gradient(circle, var(--khy-primary-strong), transparent 70%);
  animation-delay: -7s;
}

@keyframes login-float {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50%      { transform: translate(20px, -24px) scale(1.08); }
}

.login-card {
  position: relative;
  z-index: 1;
  width: 430px;
  max-width: 100%;
  border-radius: var(--khy-radius-lg);
  border: 1px solid var(--khy-border);
  background: var(--khy-bg-card-grad);
  box-shadow: var(--khy-shadow-lift);
  animation: login-rise 0.4s ease-out;
}

@keyframes login-rise {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 26px;
}

.login-brand-meta {
  min-width: 0;
}

.login-title {
  margin: 0;
  color: var(--khy-text-strong);
  font-weight: 700;
  font-size: 20px;
  letter-spacing: 0.3px;
}

.login-subtitle {
  margin: 4px 0 0 0;
  color: var(--khy-text-muted);
  font-size: 13px;
}

.login-form {
  margin-top: 4px;
}

.login-row {
  display: flex;
  justify-content: flex-end;
  margin: -6px 0 12px 0;
}

.login-fill-btn {
  padding: 0;
  font-size: 13px;
}

.login-error-item {
  margin-bottom: 12px;
}

.login-submit {
  width: 100%;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.login-hint {
  margin-top: 18px;
  text-align: center;
  font-size: 12px;
  color: var(--khy-text-secondary);
  line-height: 1.45;
}
</style>
