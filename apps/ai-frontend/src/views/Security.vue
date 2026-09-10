<template>
  <div class="security-page">
    <KhyPageHeader
      subtitle="改密、密保问题、生物识别与登录会话审计"
      title="账户安全"
    />

    <el-alert
      v-if="!capsReady"
      class="security-banner"
      :closable="false"
      description="正在读取认证能力位（/api/auth/capabilities），第 1/1 步"
      title="能力发现中"
      type="info"
    />

    <el-tabs v-else v-model="activeTab" class="security-tabs">
      <!-- ── 修改密码 ── -->
      <el-tab-pane v-if="caps.changePassword" label="修改密码" name="password">
        <el-card class="section-card" shadow="never">
          <el-form
            ref="passwordFormRef"
            class="block-form"
            label-position="top"
            :model="passwordForm"
            :rules="passwordRules"
            @submit.prevent="changePassword"
          >
            <el-form-item label="当前密码" prop="currentPassword">
              <el-input
                v-model="passwordForm.currentPassword"
                clearable
                placeholder="输入当前密码以确认身份"
                show-password
                type="password"
              />
            </el-form-item>
            <el-form-item label="新密码" prop="newPassword">
              <el-input
                v-model="passwordForm.newPassword"
                placeholder="至少 6 位，不能与当前密码相同"
                show-password
                type="password"
              />
            </el-form-item>
            <el-form-item label="确认新密码" prop="confirmPassword">
              <el-input
                v-model="passwordForm.confirmPassword"
                placeholder="再次输入新密码"
                show-password
                type="password"
              />
            </el-form-item>
            <el-form-item>
              <el-button :loading="busy.password" native-type="submit" type="primary">
                确认修改
              </el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>

      <!-- ── 密保问题 ── -->
      <el-tab-pane v-if="caps.securityQuestion" label="密保问题" name="question">
        <el-card class="section-card" shadow="never">
          <p class="block-lead">
            密保问题是找回密码的唯一自助通道：忘记密码页会据此发起重置。未设置时无法自助找回，
            只能联系管理员。
          </p>
          <el-form
            ref="questionFormRef"
            class="block-form"
            label-position="top"
            :model="questionForm"
            :rules="questionRules"
            @submit.prevent="saveSecurityQuestion"
          >
            <el-form-item label="密保问题" prop="securityQuestion">
              <el-input
                v-model="questionForm.securityQuestion"
                clearable
                :maxlength="50"
                placeholder="例如：你出生的城市是哪里？"
                show-word-limit
              />
            </el-form-item>
            <el-form-item label="密保答案" prop="securityAnswer">
              <el-input
                v-model="questionForm.securityAnswer"
                clearable
                placeholder="重置密码时需要填入"
                type="text"
              />
            </el-form-item>
            <el-form-item label="当前密码" prop="currentPassword">
              <el-input
                v-model="questionForm.currentPassword"
                clearable
                placeholder="修改密保需要验证当前密码"
                show-password
                type="password"
              />
            </el-form-item>
            <el-form-item>
              <el-button :loading="busy.question" native-type="submit" type="primary">
                保存密保
              </el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>

      <!-- ── 生物识别 ── -->
      <el-tab-pane v-if="caps.webauthn" label="生物识别" name="webauthn">
        <el-card class="section-card" shadow="never">
          <p class="block-lead">
            绑定后可以用设备自带的指纹 / 面容 / Windows Hello 完成登录，无需输入密码。
          </p>

          <el-alert
            v-if="!webauthnSupported"
            class="block-alert"
            :closable="false"
            description="需要 HTTPS（或 localhost）与安全上下文，且浏览器要支持 WebAuthn。当前环境不可用，请换用支持平台认证器的浏览器。"
            title="本设备暂不支持"
            type="warning"
          />

          <el-alert
            v-else-if="webauthnBound"
            class="block-alert"
            :closable="false"
            description="已绑定平台认证器。解绑后需要密码登录。"
            title="已绑定"
            type="success"
          />

          <div v-else class="block-actions">
            <el-button
              :disabled="webauthnBusy"
              plain
              type="primary"
              @click="bindWebAuthn"
              >绑定设备认证器</el-button
            >
          </div>

          <div v-if="webauthnBound" class="block-actions">
            <el-button
              :loading="webauthnBusy"
              plain
              type="danger"
              @click="unbindWebAuthn"
              >解绑</el-button
            >
          </div>
        </el-card>
      </el-tab-pane>

      <!-- ── 登录会话 ── -->
      <el-tab-pane label="登录会话" name="sessions">
        <el-card class="section-card" shadow="never">
          <p class="block-lead">
            你在哪些设备上登录过、什么时候登录、最后一次活动。撤销后该会话立即失效。
          </p>
          <div class="block-actions block-actions--between">
            <el-button :loading="busy.sessions" plain @click="loadSessions">
              刷新会话列表
            </el-button>
            <el-button
              :disabled="otherSessionCount === 0"
              plain
              type="danger"
              @click="logoutAll"
              >退出全部设备（{{ otherSessionCount }}）</el-button
            >
          </div>

          <el-alert
            v-if="sessionsFailed"
            class="block-alert"
            :closable="false"
            :description="sessionsFailed"
            title="会话列表不可用"
            type="error"
          />

          <el-table v-else v-loading="busy.sessions" :data="sessions" stripe>
            <el-table-column label="设备" min-width="180">
              <template #default="{ row }">
                <div class="session-device">
                  <span class="session-device-name">{{ row.deviceLabel || '未知设备' }}</span>
                  <el-tag size="small" type="info">{{ authMethodLabel(row.authMethod) }}</el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="IP" min-width="130">
              <template #default="{ row }">{{ row.ipAddress || '—' }}</template>
            </el-table-column>
            <el-table-column label="登录时间" min-width="160">
              <template #default="{ row }">{{ formatTime(row.loginAt) }}</template>
            </el-table-column>
            <el-table-column label="最近活动" min-width="160">
              <template #default="{ row }">{{ formatTime(row.lastActivityAt) }}</template>
            </el-table-column>
            <el-table-column align="center" fixed="right" label="操作" width="150">
              <template #default="{ row }">
                <el-tag size="small" type="success">{{ row.current ? '当前' : '' }}</el-tag>
                <el-button
                  v-if="!row.current"
                  link
                  :loading="busy.revoke === row.id"
                  size="small"
                  type="danger"
                  @click="revokeSession(row)"
                  >撤销</el-button
                >
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <el-alert
      v-if="toast"
      class="security-banner"
      :closable="false"
      :description="toast.text"
      :title="toast.kind === 'ok' ? '已完成' : '未成功'"
      :type="toast.kind === 'ok' ? 'success' : 'error'"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import KhyPageHeader from '@/components/KhyPageHeader.vue';
import { getAuthCapabilities } from '@/api/auth';
import request from '@/api/request';
import { describeFailure } from '@/utils/describeFailure';
import {
  formatCredentialResponse,
  getWebAuthnStatus,
  isWebAuthnAvailable,
  requestRegistrationOptions,
  unbindWebAuthn as unbindWebAuthnApi,
  verifyRegistrationResponse,
} from '@/api/webauthn';

defineOptions({ name: 'Security' });

// 与后端 services/backend/src/services/authPolicy.js 的 PASSWORD_MIN_LENGTH 对齐。
// 前端引不到后端模块，这里只作输入校验的镜像值；不一致时后端仍是最终裁决。
const PASSWORD_MIN_LENGTH = 6;

// 结果提示的自清时长。5s 内属于短 UI 重置计时器，配 clearTimeout 兜底。
const TOAST_HINT_MS = 5000;

const FALLBACK_CAPS = {
  changePassword: false,
  securityQuestion: false,
  webauthn: false,
};

const caps = reactive({ ...FALLBACK_CAPS });
const capsReady = ref(false);
const activeTab = ref('password');
const toast = ref(null);
const busy = reactive({ password: false, question: false, sessions: false, revoke: null });

const passwordFormRef = ref(null);
const questionFormRef = ref(null);
const passwordForm = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' });
const questionForm = reactive({
  securityQuestion: '',
  securityAnswer: '',
  currentPassword: '',
});

const passwordRules = {
  currentPassword: [{ required: true, message: '请输入当前密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    {
      validator: (_rule, value, callback) => {
        if (String(value || '').length < PASSWORD_MIN_LENGTH) {
          callback(new Error(`新密码长度至少 ${PASSWORD_MIN_LENGTH} 位`));
          return;
        }
        callback();
      },
      trigger: 'blur',
    },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_rule, value, callback) => {
        if (value !== passwordForm.newPassword) callback(new Error('两次输入的新密码不一致'));
        else callback();
      },
      trigger: 'blur',
    },
  ],
};

const questionRules = {
  securityQuestion: [{ required: true, message: '请输入密保问题', trigger: 'blur' }],
  securityAnswer: [{ required: true, message: '请输入密保答案', trigger: 'blur' }],
  currentPassword: [
    { required: true, message: '请输入当前密码以确认身份', trigger: 'blur' },
  ],
};

const webauthnSupported = ref(false);
const webauthnBound = ref(false);
const webauthnBusy = ref(false);

const sessions = ref([]);
const sessionsFailed = ref('');
const otherSessionCount = computed(() =>
  sessions.value.filter((row) => !row.current).length
);

let toastHintTimer = null;

function clearToastHintTimer() {
  if (toastHintTimer !== null) {
    clearTimeout(toastHintTimer);
    toastHintTimer = null;
  }
}

function showResult(kind, text) {
  toast.value = { kind, text };
  clearToastHintTimer();
  toastHintTimer = setTimeout(() => {
    toast.value = null;
    toastHintTimer = null;
  }, TOAST_HINT_MS);
}

function showOk(text) {
  showResult('ok', text);
}

function showFail(text) {
  showResult('fail', text);
}

function authMethodLabel(method) {
  const labels = { password: '密码', webauthn: '生物识别', api_key: 'API 密钥' };
  return labels[String(method || 'password')] || '密码';
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

async function loadCapabilities() {
  const resolved = await getAuthCapabilities();
  caps.changePassword = !!resolved.changePassword;
  caps.securityQuestion = !!resolved.securityQuestion;
  caps.webauthn = !!resolved.webauthn;
  if (!caps[activeTab.value]) {
    activeTab.value = Object.keys(caps).find((key) => caps[key]) || 'sessions';
  }
  capsReady.value = true;
}

async function changePassword() {
  await passwordFormRef.value.validate(async (valid) => {
    if (!valid) return;
    if (passwordForm.newPassword === passwordForm.currentPassword) {
      showFail('新密码不能与当前密码相同 (400)：请换一个不同的密码');
      return;
    }
    busy.password = true;
    try {
      const { data } = await request.post('/api/auth/change-password', {
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
        confirmPassword: passwordForm.confirmPassword,
      });
      const payload = data && typeof data.data === 'object' && data.data ? data.data : data;
      const revoked = Number(payload?.revokedOtherSessions || 0);
      passwordForm.currentPassword = '';
      passwordForm.newPassword = '';
      passwordForm.confirmPassword = '';
      showOk(`密码已更新：同时撤销了 ${revoked} 个其他设备会话（当前会话保留）`);
      loadSessions();
    } catch (err) {
      showFail(describeFailure(err, '请核对当前密码后重试'));
    } finally {
      busy.password = false;
    }
  });
}

async function saveSecurityQuestion() {
  await questionFormRef.value.validate(async (valid) => {
    if (!valid) return;
    busy.question = true;
    try {
      await request.post('/api/password-reset/set-security', {
        securityQuestion: questionForm.securityQuestion.trim(),
        securityAnswer: questionForm.securityAnswer.trim(),
        currentPassword: questionForm.currentPassword,
      });
      const question = questionForm.securityQuestion.trim();
      questionForm.currentPassword = '';
      showOk(`密保已更新：忘记密码页现在可以用「${question}」发起重置`);
    } catch (err) {
      showFail(describeFailure(err, '请核对当前密码后重试'));
    } finally {
      busy.question = false;
    }
  });
}

async function refreshWebAuthnStatus() {
  if (!isWebAuthnAvailable()) {
    webauthnSupported.value = false;
    return;
  }
  webauthnSupported.value = true;
  try {
    webauthnBound.value = await getWebAuthnStatus();
  } catch {
    // 状态查询失败不能当成「未绑定」——静默降级会诱导用户重复绑定。
    webauthnBound.value = false;
  }
}

async function bindWebAuthn() {
  if (!webauthnSupported.value) return;
  webauthnBusy.value = true;
  try {
    const options = await requestRegistrationOptions();
    if (!options || !options.challenge) {
      showFail('注册选项缺失 (400)：后端未返回 challenge，请刷新页面后重试');
      return;
    }
    const credential = await navigator.credentials.create({ publicKey: options });
    if (!credential) {
      showFail('未创建认证器：你已取消设备上的指纹/面容提示，可随时重试');
      return;
    }
    await verifyRegistrationResponse(formatCredentialResponse(credential));
    webauthnBound.value = true;
    showOk('生物识别已绑定：下次登录可直接用设备认证器');
  } catch (err) {
    if (/cancel/i.test(String(err?.name || err?.message || ''))) {
      showFail('已取消：未在设备上完成指纹/面容确认，可随时重试');
      return;
    }
    showFail(describeFailure(err, '请确认设备支持平台认证器后重试'));
  } finally {
    webauthnBusy.value = false;
  }
}

async function unbindWebAuthn() {
  webauthnBusy.value = true;
  try {
    await unbindWebAuthnApi();
    webauthnBound.value = false;
    showOk('已解绑：请改用密码登录');
  } catch (err) {
    showFail(describeFailure(err, '请稍后重试'));
  } finally {
    webauthnBusy.value = false;
  }
}

async function loadSessions() {
  busy.sessions = true;
  sessionsFailed.value = '';
  try {
    const { data } = await request.get('/api/auth/sessions', { silent: true });
    const payload = data && typeof data.data === 'object' && data.data ? data.data : data;
    sessions.value = Array.isArray(payload?.sessions) ? payload.sessions : [];
  } catch (err) {
    sessions.value = [];
    sessionsFailed.value = describeFailure(err, '请确认后端已启动');
  } finally {
    busy.sessions = false;
  }
}

async function revokeSession(row) {
  if (!row || row.id == null) return;
  busy.revoke = row.id;
  try {
    await request.delete(`/api/auth/sessions/${encodeURIComponent(row.id)}`, { silent: true });
    sessions.value = sessions.value.filter((item) => item.id !== row.id);
    showOk(`已撤销「${row.deviceLabel || '未知设备'}」的会话`);
  } catch (err) {
    showFail(describeFailure(err, '该会话可能已失效，请刷新列表'));
  } finally {
    busy.revoke = null;
  }
}

async function logoutAll() {
  if (otherSessionCount.value === 0) return;
  try {
    await request.post('/api/auth/logout-all', { silent: true });
    sessions.value = sessions.value.filter((row) => row.current);
    showOk('已退出全部设备：仅保留当前会话');
  } catch (err) {
    showFail(describeFailure(err, '请刷新列表后逐个撤销'));
  }
}

onMounted(async () => {
  await loadCapabilities();
  refreshWebAuthnStatus();
  loadSessions();
});

onUnmounted(clearToastHintTimer);
</script>

<style scoped>
.security-page {
  width: 100%;
}

.security-banner {
  margin-top: 16px;
}

.security-tabs {
  margin-top: 4px;
}

.security-tabs :deep(.el-tabs__header) {
  margin-bottom: 16px;
}

.section-card {
  border: 1px solid var(--khy-border);
  border-radius: var(--khy-radius-lg);
}

.block-lead {
  margin: 0 0 18px 0;
  color: var(--khy-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.block-form {
  max-width: 460px;
}

.block-form :deep(.el-input) {
  width: 100%;
}

.block-alert {
  margin-bottom: 16px;
}

.block-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.block-actions--between {
  justify-content: space-between;
  flex-wrap: wrap;
}

.session-device {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.session-device-name {
  font-weight: 500;
}

@media (max-width: 640px) {
  .block-form {
    max-width: 100%;
  }
}
</style>
