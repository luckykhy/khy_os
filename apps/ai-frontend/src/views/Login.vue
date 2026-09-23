<template>
  <PublicLayout :branded="false">
    <el-card class="login-card" shadow="always">
      <div class="login-brand">
        <span class="khy-brand-logo khy-brand-logo--md">K</span>
        <div class="login-brand-meta">
          <h2 class="login-title">KHY AI</h2>
          <p class="login-subtitle">管理你的 AI 渠道与用量</p>
        </div>
      </div>

      <el-form class="login-form" :model="form" @submit.prevent="handleLogin">
        <el-form-item>
          <el-input
            v-model="form.username"
            placeholder="用户名或邮箱"
            prefix-icon="User"
            size="large"
          />
        </el-form-item>
        <el-form-item>
          <el-input
            v-model="form.password"
            placeholder="密码"
            prefix-icon="Lock"
            show-password
            size="large"
            type="password"
          >
            <template v-if="caps.passwordReset.mode !== 'none'" #suffix>
              <router-link class="login-forget" to="/forgot-password">忘记密码?</router-link>
            </template>
          </el-input>
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
          {{ loading ? '正在校验账号' : '登录' }}
        </el-button>
      </el-form>
    </el-card>
  </PublicLayout>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PublicLayout from '@/layouts/PublicLayout.vue';
import KhyIcon from '@/components/KhyIcon.vue';
import { useUserStore } from '@/stores/user';
import { getAuthCapabilities } from '@/api/auth';
import request from '@/api/request';
import { safeRedirectPath } from '@/utils/safeRedirect';

defineOptions({ name: 'Login' });

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
      fillHint.value = '已填充默认管理员用户名，密码请查看本机凭据文件';
    } else {
      fillHint.value = '未获取到默认管理员用户名，请检查本机凭据文件';
    }
  } catch {
    fillHint.value = '无法获取默认管理员用户名，请检查后端是否已启动';
  } finally {
    filling.value = false;
  }
}

// Every answer follows the repo's error contract (规则 2.2):
// {问题一句话}：{识别码}，{用户能做的具体动作}. The old versions returned bare
// "登录失败" style strings, which forced the user to guess.
function mapLoginError(err) {
  const status = err?.response?.status;
  const serverMsg = String(err?.response?.data?.message || '').trim();
  const localMsg = String(err?.message || '').trim();

  if (status === 429) {
    return '限流 (429)：登录请求过多，请稍后重试或稍等 1 分钟';
  }
  if (status === 401 || /invalid username or password/i.test(serverMsg)) {
    return '认证失败 (401)：用户名或密码错误，请核对后重试；默认管理员初始密码见本机凭据文件';
  }
  if (status === 403) {
    return '账户不可用 (403)：账号可能已被禁用或未激活，请联系管理员';
  }
  if (status === 400) {
    return `输入不合法 (400)：${serverMsg || '请确认用户名和密码都已填写'}`;
  }
  if (/jwt_secret|not configured/i.test(serverMsg + localMsg)) {
    return '认证配置缺失 (JWT_SECRET)：请检查 .env 后重启后端服务';
  }
  if (
    /network error|econnrefused|failed to fetch|网络连接异常/i.test(serverMsg + localMsg)
  ) {
    return '网络连接失败：后端服务不可达，请确认服务已启动后刷新页面';
  }
  return serverMsg || localMsg || '登录失败：请重试，或运行 khy doctor 检查后端';
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
}

.login-forget {
  padding: 0;
  font-size: 13px;
  color: var(--khy-primary);
  text-decoration: none;
}

.login-forget:hover {
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
</style>
