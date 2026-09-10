<template>
  <div class="login-shell">
    <div aria-hidden="true" class="login-orb login-orb--1"></div>
    <div aria-hidden="true" class="login-orb login-orb--2"></div>

    <el-card class="login-card" shadow="always">
      <div class="login-brand">
        <span class="khy-brand-logo khy-brand-logo--md">K</span>
        <div class="login-brand-meta">
          <h2 class="login-title">KHY AI 统一入口</h2>
          <p class="login-subtitle">登录以进入你的 AI 网关与工作台</p>
        </div>
      </div>

      <el-form class="login-form" :model="form" @submit.prevent="handleLogin">
        <el-form-item>
          <el-input v-model="form.username" placeholder="用户名" prefix-icon="User" size="large" />
        </el-form-item>
        <el-form-item>
          <el-input
            v-model="form.password"
            placeholder="密码"
            prefix-icon="Lock"
            show-password
            size="large"
            type="password"
          />
        </el-form-item>

        <div v-if="caps.defaultAdminAvailable" class="login-row">
          <el-button
            class="login-fill-btn"
            :loading="filling"
            text
            type="primary"
            @click="fillDefaultAdmin"
          >
            填充默认管理员用户名
          </el-button>
        </div>

        <div v-if="caps.passwordReset.mode !== 'none'" class="login-row">
          <router-link class="login-fill-btn" to="/forgot-password">忘记密码?</router-link>
        </div>

        <el-form-item v-if="fillHint" class="login-error-item">
          <el-alert :closable="false" :title="fillHint" type="info">
            <template #icon><KhyIcon kind="user" size="sm" /></template>
          </el-alert>
        </el-form-item>

        <el-form-item v-if="error" class="login-error-item">
          <el-alert :closable="false" :title="error" type="error" />
        </el-form-item>

        <el-button
          class="login-submit"
          :loading="loading"
          native-type="submit"
          size="large"
          type="primary"
        >
          校验账号并进入用户首页
        </el-button>
      </el-form>

      <p class="login-hint">
        登录后可直接进入工作台；管理员账号会自动进入管理概览。
      </p>
    </el-card>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';
import { getAuthCapabilities } from '@/api/auth';
import request from '@/api/request';
import { safeRedirectPath } from '@/utils/safeRedirect';

const router = useRouter();
const route = useRoute();
const userStore = useUserStore();
const loading = ref(false);
const error = ref('');
const fillHint = ref('');
const filling = ref(false);
const form = reactive({ username: '', password: '' });

// Optional login surfaces come from the server, not from this file. The
// default-admin helper and the password-reset link were previously hardcoded
// and always 404'd in a monolith install. The initial value is the conservative
// shape, so nothing optional renders for the first frame — the server cannot
// enable a surface we have not seen it advertise.
const caps = reactive({
  defaultAdminAvailable: false,
  passwordReset: { mode: 'none' },
});

onMounted(async () => {
  const discovered = await getAuthCapabilities();
  caps.defaultAdminAvailable = !!discovered.defaultAdminAvailable;
  caps.passwordReset = discovered.passwordReset || { mode: 'none' };
});

// Fill ONLY the username from the backend (the initial password is generated
// per machine and never exposed via API — it lives in the credentials file).
async function fillDefaultAdmin() {
  filling.value = true;
  try {
    const { data } = await request.get('/api/auth/default-admin');
    const payload = data && typeof data.data === 'object' && data.data ? data.data : data;
    const username = String(payload?.username || '').trim();
    if (username) {
      form.username = username;
      fillHint.value = '已填充默认管理员用户名；密码见数据目录 .khy/credentials/default-admin.json';
    } else {
      fillHint.value = '未获取到默认管理员；密码见数据目录 .khy/credentials/default-admin.json';
    }
  } catch {
    fillHint.value = '无法获取默认管理员用户名；凭据见数据目录 .khy/credentials/default-admin.json';
  } finally {
    filling.value = false;
  }
}

function mapLoginError(err) {
  const serverMsg = String(err?.response?.data?.message || err?.response?.data?.error || '').trim();
  const localMsg = String(err?.message || '').trim();
  const raw = serverMsg || localMsg;
  const lower = raw.toLowerCase();

  if (!raw) return '登录失败，请稍后重试';
  if (err?.response?.status === 401 || lower.includes('invalid username or password')) {
    return '用户名或密码错误。默认管理员初始密码保存在数据目录 .khy/credentials/default-admin.json。';
  }
  if (err?.response?.status === 403 || lower.includes('not active')) {
    return '账号未激活，请检查用户状态。';
  }
  if (lower.includes('jwt_secret') || lower.includes('not configured')) {
    return '后端认证配置缺失（JWT_SECRET）。请先检查 .env 后重启服务。';
  }
  if (
    lower.includes('network error') ||
    lower.includes('econnrefused') ||
    lower.includes('failed to fetch')
  ) {
    return '无法连接 AI 管理后端（Network Error）。请确认 ai-backend 服务 healthy，且当前页面 API 代理配置正确。';
  }
  return raw;
}

async function handleLogin() {
  loading.value = true;
  error.value = '';
  try {
    await userStore.login(form.username, form.password);
    router.push(loginDestination());
  } catch (err) {
    error.value = mapLoginError(err);
  } finally {
    loading.value = false;
  }
}

// The guard sends unauthenticated visitors to /401 with the requested path in
// ?redirect, which forwards it here. Only a same-origin relative path is
// honoured — anything else falls back to the role's home, so a crafted URL
// cannot bounce a fresh session off-site.
function loginDestination() {
  return safeRedirectPath(route.query.redirect, userStore.preferredHome);
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
  0%,
  100% {
    transform: translate(0, 0) scale(1);
  }
  50% {
    transform: translate(20px, -24px) scale(1.08);
  }
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
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
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
  align-items: center;
  margin: -6px 0 12px 0;
}

.login-fill-btn {
  padding: 0;
  font-size: 13px;
  color: var(--khy-primary);
  text-decoration: none;
}

.login-fill-btn:hover {
  color: var(--khy-primary-strong);
  text-decoration: underline;
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
