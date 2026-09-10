<template>
  <PublicLayout :branded="false">
    <el-card class="login-card" shadow="always">
      <div class="login-brand">
        <span class="khy-brand-logo khy-brand-logo--md">K</span>
        <div class="login-brand-meta">
          <h2 class="login-title">找回密码</h2>
          <p class="login-subtitle">通过密保问题重置你的登录密码</p>
        </div>
      </div>

      <el-form class="login-form" :model="form" @submit.prevent="handleLookup">
        <el-form-item>
          <el-input
            v-model="form.account"
            clearable
            placeholder="用户名或邮箱"
            prefix-icon="User"
            size="large"
          />
        </el-form-item>

        <template v-if="question">
          <el-form-item>
            <el-input v-model="form.answer" placeholder="密保答案" prefix-icon="QuestionFilled" size="large" />
          </el-form-item>

          <el-form-item>
            <el-input
              v-model="form.newPassword"
              placeholder="新密码（至少 6 位）"
              prefix-icon="Lock"
              show-password
              size="large"
              type="password"
            />
          </el-form-item>

          <el-form-item>
            <el-input
              v-model="form.confirmPassword"
              placeholder="再次输入新密码"
              prefix-icon="Lock"
              show-password
              size="large"
              type="password"
            />
          </el-form-item>
        </template>

        <el-form-item v-if="question" class="login-detail-item">
          <div class="reset-question">
            <span class="reset-question-label">密保问题</span>
            <span class="reset-question-text">{{ question }}</span>
          </div>
        </el-form-item>

        <el-form-item v-if="error" class="login-error-item">
          <el-alert :closable="false" :title="error" type="error" />
        </el-form-item>

        <el-form-item v-if="success" class="login-error-item">
          <el-alert :closable="false" :title="success" type="success" />
        </el-form-item>

        <el-button
          class="login-submit"
          :loading="busy"
          native-type="submit"
          size="large"
          type="primary"
        >
          {{ question ? '重置密码' : '获取密保问题' }}
        </el-button>
      </el-form>

      <p class="login-hint">
        <router-link class="login-back" to="/login">返回登录</router-link>
        <span v-if="!question" class="login-hint-text">未设置密保问题？登录后可在「安全」页设置。</span>
      </p>
    </el-card>
  </PublicLayout>
</template>

<script setup>
import { reactive, ref } from 'vue';
import PublicLayout from '@/layouts/PublicLayout.vue';
import { splitAccount } from '@/api/auth';
import request from '@/api/request';

defineOptions({ name: 'ForgotPassword' });

const busy = ref(false);
const error = ref('');
const success = ref('');
const question = ref('');
const form = reactive({
  account: '',
  answer: '',
  newPassword: '',
  confirmPassword: '',
});

function mapResetError(err, phase) {
  const status = err?.response?.status;
  const serverMsg = String(
    err?.response?.data?.message || err?.response?.data?.error || ''
  ).trim();
  const localMsg = String(err?.message || '').trim();

  if (status === 429) {
    return '重置请求过于频繁：同一 IP 15 分钟内最多 10 次，请稍后再试。';
  }
  if (status === 403) {
    return '账户当前不可重置密码：账号可能已被禁用，请联系管理员。';
  }
  if (phase === 'lookup' && status === 400) {
    return '未找到对应账号或该账号未设置密保问题：请核对用户名/邮箱，或在登录后于「安全」页设置。';
  }
  if (phase === 'reset' && status === 400) {
    return '用户名或密保答案不正确：答案错误不会提示具体原因，请重试或联系管理员。';
  }
  if (err?.message && /网络连接异常/.test(err.message)) return err.message;
  return serverMsg || localMsg || `重置失败：请确认后端服务可用后重试。`;
}

async function handleLookup() {
  error.value = '';
  success.value = '';

  if (!question.value) {
    if (!form.account.trim()) {
      error.value = '请填写用户名或邮箱';
      return;
    }
    busy.value = true;
    try {
      const { data } = await request.post('/api/password-reset/get-question', splitAccount(form.account), {
        silent: true,
      });
      question.value = String(data?.data?.securityQuestion || '').trim();
      if (!question.value) error.value = '该账号没有可用的密保问题';
    } catch (err) {
      error.value = mapResetError(err, 'lookup');
    } finally {
      busy.value = false;
    }
    return;
  }

  if (!form.answer.trim() || !form.newPassword) {
    error.value = '请填写密保答案和新密码';
    return;
  }
  if (form.newPassword.length < 6) {
    error.value = '新密码长度至少 6 个字符';
    return;
  }
  if (form.newPassword !== form.confirmPassword) {
    error.value = '两次输入的新密码不一致';
    return;
  }

  busy.value = true;
  try {
    await request.post(
      '/api/password-reset/reset',
      {
        ...splitAccount(form.account),
        securityAnswer: form.answer,
        newPassword: form.newPassword,
      },
      { silent: true }
    );
    success.value = '密码重置成功，请使用新密码登录';
  } catch (err) {
    error.value = mapResetError(err, 'reset');
  } finally {
    busy.value = false;
  }
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
  margin-bottom: 22px;
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

.login-detail-item {
  margin-bottom: 12px;
}

.reset-question {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--khy-bg-elevated, rgba(127, 127, 127, 0.08));
  border: 1px solid var(--khy-border);
}

.reset-question-label {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--khy-text-muted);
}

.reset-question-text {
  font-size: 14px;
  color: var(--khy-text-strong);
  font-weight: 600;
  word-break: break-word;
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

.login-hint-text {
  display: block;
  margin-top: 4px;
}

.login-back {
  color: var(--khy-primary);
  text-decoration: none;
}

.login-back:hover {
  text-decoration: underline;
}
</style>
