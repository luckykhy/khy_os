<template>
  <div class="user-home-page">
    <KhyPageHeader
      subtitle="账户概览、API Key、账单与代理订阅"
      title="我的工作台"
    />

    <!-- 首访轻量引导：仅第一次进入时出现，可关闭且记忆到 localStorage。
         指向「功能索引」，解决"有功能却不知去哪用"。DESIGN-ARCH-080 §5.3 明确保留它。 -->
    <el-alert
      v-if="showOnboarding"
      class="home-onboarding"
      :closable="true"
      show-icon
      title="第一次来？这里有一份能力地图"
      type="primary"
      @close="dismissOnboarding"
    >
      <template #default>
        <span>小K 能写代码、读图、查资料、跑多智能体协作……想快速了解全部功能，去看看</span>
        <el-button class="home-onboarding-link" link type="primary" @click="goFeatures"
          >功能索引</el-button
        >
        <span>。</span>
      </template>
    </el-alert>

    <el-alert
      v-if="overviewError"
      class="home-alert"
      :closable="false"
      show-icon
      :title="overviewError"
      type="warning"
    />

    <!-- ── 概览条 ── -->
    <el-card class="home-card home-overview" :loading="overviewLoading" shadow="never">
      <div class="overview-grid">
        <div class="overview-cell">
          <div class="overview-label">当前身份</div>
          <div class="overview-value">{{ userStore.roleLabel }}</div>
        </div>
        <div class="overview-cell">
          <div class="overview-label">最近一次登录</div>
          <div class="overview-value">{{ lastLoginText }}</div>
          <div class="overview-hint">{{ lastLoginHint }}</div>
        </div>
        <div class="overview-cell">
          <div class="overview-label">API Key</div>
          <div class="overview-value">{{ keyLabel }}</div>
        </div>
        <div class="overview-cell">
          <div class="overview-label">代理订阅</div>
          <div class="overview-value">{{ groups.length }} 个</div>
        </div>
      </div>
    </el-card>

    <el-row :gutter="16">
      <el-col :lg="12" :xs="24">
        <!-- ── 我的 API Key ── -->
        <el-card class="home-card" :loading="keyLoading" shadow="hover">
          <template #header>
            <div class="card-header-row">
              <KhyIcon class="card-header-icon" kind="key" size="md" />
              <span>我的 API Key</span>
            </div>
          </template>

          <el-alert
            v-if="keyError"
            class="block-alert"
            :closable="false"
            show-icon
            :title="keyError"
            type="error"
          />

          <template v-if="freshKey">
            <el-alert
              class="block-alert"
              :closable="false"
              show-icon
              title="完整 Key 只显示这一次，关闭本页后无法再查看"
              type="warning"
            />
            <div class="fresh-key-row">
              <el-input class="fresh-key-input" :model-value="freshKey" readonly />
              <el-button :loading="copying" type="primary" @click="copyFreshKey">复制</el-button>
            </div>
          </template>

          <el-empty
            v-else-if="!keyInfo"
            description="当前账号还没有可用的 API Key"
            :image-size="60"
          >
            <el-button :loading="keyBusy" type="primary" @click="generateKey">
              <KhyIcon class="btn-icon" kind="key" size="sm" />
              新建 API Key
            </el-button>
          </el-empty>

          <template v-else>
            <el-descriptions border class="key-descriptions" :column="1" size="small">
              <el-descriptions-item label="Key 前缀">
                <code class="key-prefix">{{ keyInfo.keyPrefix || '—' }}</code>
              </el-descriptions-item>
              <el-descriptions-item label="标签">{{ keyInfo.label || 'default' }}</el-descriptions-item>
              <el-descriptions-item label="状态">
                <el-tag size="small" :type="keyInfo.isActive ? 'success' : 'danger'">
                  {{ keyInfo.isActive ? '可用' : '已停用' }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="创建时间">{{ formatTime(keyInfo.createdAt) }}</el-descriptions-item>
              <el-descriptions-item label="最近使用">
                {{ keyInfo.lastUsedAt ? formatTime(keyInfo.lastUsedAt) : '尚未使用' }}
              </el-descriptions-item>
            </el-descriptions>
            <p class="key-note">
              系统按用户只保留一个可用 Key；「轮换」会停用旧 Key 并发出新 Key。完整 Key 仅在创建或轮换时显示一次。
            </p>
            <div class="card-actions">
              <el-button :loading="keyBusy" @click="refreshKey">
                <KhyIcon class="btn-icon" kind="refresh" size="sm" />
                轮换 Key
              </el-button>
              <el-button :loading="keyBusy" plain type="danger" @click="confirmRevoke">
                撤销当前 Key
              </el-button>
            </div>
          </template>
        </el-card>
      </el-col>

      <el-col :lg="12" :xs="24">
        <!-- ── 我的账单 ── -->
        <el-card class="home-card" :loading="paymentsLoading" shadow="hover">
          <template #header>
            <div class="card-header-row">
              <KhyIcon class="card-header-icon" kind="coins" size="md" />
              <span>我的账单</span>
            </div>
          </template>

          <el-alert
            v-if="paymentsError"
            class="block-alert"
            :closable="false"
            show-icon
            :title="paymentsError"
            type="warning"
          />

          <el-empty
            v-else-if="!payments.length"
            description="还没有支付订单"
            :image-size="60"
          >
            <el-button plain type="primary" @click="goBilling">去创建充值订单</el-button>
          </el-empty>

          <el-table
            v-else
            :data="payments.slice(0, 6)"
            :show-overflow-tooltip="true"
            size="small"
          >
            <el-table-column label="订单号" min-width="150" prop="id">
              <template #default="{ row }">
                <code class="mono-id">{{ shortId(row.id) }}</code>
              </template>
            </el-table-column>
            <el-table-column align="right" label="金额" width="84">
              <template #default="{ row }">¥{{ amountText(row.amountCny) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="82">
              <template #default="{ row }">
                <el-tag size="small" :type="paymentTagType(row.status)">
                  {{ paymentStatusLabel(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="创建时间" width="130">
              <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
            </el-table-column>
          </el-table>

          <div v-if="payments.length > 6" class="card-foot">
            <el-button link type="primary" @click="goBilling">查看全部 {{ payments.length }} 笔</el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <el-col :lg="12" :xs="24">
        <!-- ── 我的渠道 ── -->
        <el-card class="home-card" :loading="groupsLoading" shadow="hover">
          <template #header>
            <div class="card-header-row">
              <KhyIcon class="card-header-icon" kind="link" size="md" />
              <span>我的代理订阅</span>
            </div>
          </template>

          <el-alert
            v-if="groupsError"
            class="block-alert"
            :closable="false"
            show-icon
            :title="groupsError"
            type="warning"
          />

          <el-empty
            v-else-if="!groups.length"
            description="还没有导入代理订阅"
            :image-size="60"
          >
            <el-button plain type="primary" @click="goProxies">去导入订阅</el-button>
          </el-empty>

          <ul v-else class="group-list">
            <li v-for="group in groups.slice(0, 6)" :key="group.id" class="group-item">
              <div class="group-main">
                <span class="group-name">{{ group.name || '未命名订阅' }}</span>
                <span class="group-meta">{{ nodeCountText(group) }}</span>
              </div>
              <el-tag size="small" :type="groupStatusTag(group)">{{ groupStatusText(group) }}</el-tag>
            </li>
          </ul>

          <div v-if="groups.length > 6" class="card-foot">
            <el-button link type="primary" @click="goProxies">查看全部 {{ groups.length }} 个</el-button>
          </div>
        </el-card>
      </el-col>

      <el-col :lg="12" :xs="24">
        <!-- ── 快捷入口 ── -->
        <el-card class="home-card" shadow="hover">
          <template #header>
            <div class="card-header-row">
              <KhyIcon class="card-header-icon" kind="compass" size="md" />
              <span>快捷入口</span>
            </div>
          </template>
          <div class="quick-actions">
            <el-button size="large" type="primary" @click="goChat">
              <KhyIcon class="btn-icon" kind="chat" size="sm" />
              进入 AI 对话
            </el-button>
            <el-button size="large" @click="goTerminal">
              <KhyIcon class="btn-icon" kind="tools" size="sm" />
              打开终端
            </el-button>
            <el-button size="large" @click="goFeatures">
              <KhyIcon class="btn-icon" kind="guide" size="sm" />
              功能索引
            </el-button>
            <el-button size="large" @click="goSecurity">
              <KhyIcon class="btn-icon" kind="lock" size="sm" />
              账户安全
            </el-button>
          </div>
        </el-card>

        <!-- ── 用量说明 ── -->
        <el-card class="home-card home-usage" shadow="never">
          <template #header>
            <div class="card-header-row">
              <KhyIcon class="card-header-icon" kind="data" size="md" />
              <span>用量明细</span>
            </div>
          </template>
          <p class="usage-note">
            用量统计由 <code>ai-backend</code> 服务产出，本机后端只把
            <code>/api/ai-gateway/*</code> 代理过去，自身没有用量读取端点。
            「我的账单」可看充值额度，「我的 API Key」可看调用通道是否可用；
            运行 <code>khy doctor</code> 能确认 <code>ai-backend</code> 是否可达。
          </p>
          <div class="card-actions">
            <el-button plain type="primary" @click="goUsage">
              <KhyIcon class="btn-icon" kind="data" size="sm" />
              打开用量日志
            </el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { useUserStore } from '@/stores/user';
import { safeSet } from '@/utils/safeStorage';
import KhyIcon from '@/components/KhyIcon.vue';
import KhyPageHeader from '@/components/KhyPageHeader.vue';
import request from '@/api/request';
import { describeFailure } from '@/utils/describeFailure';

defineOptions({ name: 'UserHome' });

const router = useRouter();
const userStore = useUserStore();

// ── 首访引导 ────────────────────────────────────────────────────────────
// 只在从未关闭过时显示。localStorage 读失败（隐私模式等）时默认不打扰。
const ONBOARDED_KEY = 'khy_ai_home_onboarded';
const showOnboarding = ref(false);
try {
  showOnboarding.value = localStorage.getItem(ONBOARDED_KEY) !== '1';
} catch {
  showOnboarding.value = false;
}
function dismissOnboarding() {
  showOnboarding.value = false;
  safeSet(ONBOARDED_KEY, '1');
}

// ── 概览 ────────────────────────────────────────────────────────────────
const overviewLoading = ref(true);
const overviewError = ref('');
const sessions = ref([]);
const legacySession = ref(false);

const keyLoading = ref(true);
const keyBusy = ref(false);
const keyError = ref('');
const keyInfo = ref(null);
// Full key, shown exactly once, never persisted. Cleared on unmount by the
// component itself going away; there is deliberately no localStorage here.
const freshKey = ref('');
const copying = ref(false);

const paymentsLoading = ref(true);
const paymentsError = ref('');
const payments = ref([]);

const groupsLoading = ref(true);
const groupsError = ref('');
const groups = ref([]);

async function loadSessions() {
  const { data } = await request.get('/api/auth/sessions', { silent: true });
  const body = data?.data || {};
  sessions.value = Array.isArray(body.sessions) ? body.sessions : [];
  legacySession.value = !!body.legacySession;
}

async function loadKey() {
  const { data } = await request.get('/api/api-keys/current', { silent: true });
  keyInfo.value = data?.data || null;
}

async function loadPayments() {
  const { data } = await request.get('/api/ai-gateway/payments', {
    params: { page: 1, pageSize: 6 },
    silent: true,
  });
  const body = data?.data || {};
  payments.value = Array.isArray(body.list) ? body.list : Array.isArray(body) ? body : [];
}

async function loadGroups() {
  const { data } = await request.get('/api/proxy-subscriptions', { silent: true });
  const body = data?.data || data;
  groups.value = Array.isArray(body?.subscriptions)
    ? body.subscriptions
    : Array.isArray(body)
      ? body
      : [];
}

async function loadOverview() {
  overviewLoading.value = true;
  overviewError.value = '';
  keyLoading.value = true;
  paymentsLoading.value = true;
  groupsLoading.value = true;

  const jobs = [
    loadSessions().catch((err) => {
      overviewError.value = describeFailure(err, '确认后端已启动后刷新本页');
    }),
    loadKey().catch((err) => {
      keyError.value = describeFailure(err, '可先尝试新建一个 Key');
    }),
    loadPayments().catch((err) => {
      paymentsError.value = describeFailure(err, '不影响其它区块，可稍后重试');
    }),
    loadGroups().catch((err) => {
      groupsError.value = describeFailure(err, '不影响其它区块，可稍后重试');
    }),
  ];

  await Promise.allSettled(jobs);
  overviewLoading.value = false;
  keyLoading.value = false;
  paymentsLoading.value = false;
  groupsLoading.value = false;
}

// ── 派生展示 ────────────────────────────────────────────────────────────
const lastLoginText = computed(() => {
  if (!sessions.value.length) {
    return legacySession.value ? '未记录' : '—';
  }
  const latest = sessions.value.reduce((max, s) =>
    Date.parse(s.loginAt || 0) > Date.parse(max.loginAt || 0) ? s : max
  );
  return formatTime(latest.loginAt);
});

const lastLoginHint = computed(() => {
  if (legacySession.value && !sessions.value.length) {
    return '当前是旧版令牌，登录时间未入库';
  }
  return sessions.value.length ? `共 ${sessions.value.length} 个活跃会话` : '';
});

const keyLabel = computed(() => {
  if (freshKey.value) return '已新建，待复制';
  return keyInfo.value?.keyPrefix ? `${keyInfo.value.keyPrefix}…` : '未绑定';
});

// ── API Key 操作 ────────────────────────────────────────────────────────
async function postKey(path, fallback) {
  keyBusy.value = true;
  freshKey.value = '';
  keyError.value = '';
  try {
    const { data } = await request.post(`/api/api-keys${path}`, { label: 'default' });
    freshKey.value = String(data?.data?.key || '').trim();
    await loadKey();
    return true;
  } catch (err) {
    keyError.value = describeFailure(err, fallback);
    return false;
  } finally {
    keyBusy.value = false;
  }
}

async function generateKey() {
  await postKey('/generate', '后端未返回 Key，请确认 ai-backend 可用');
}

async function refreshKey() {
  await postKey('/refresh', '没有可轮换的 Key，请先新建');
}

async function revokeKey() {
  keyBusy.value = true;
  keyError.value = '';
  try {
    await request.post('/api/api-keys/revoke', {});
    freshKey.value = '';
    await loadKey();
  } catch (err) {
    keyError.value = describeFailure(err, '确认该 Key 未被其它进程占用');
  } finally {
    keyBusy.value = false;
  }
}

function confirmRevoke() {
  ElMessageBox.confirm(
    `撤销后以 ${keyInfo.value?.keyPrefix || '当前 Key'} 开头的密钥立即失效，使用它的进程会认证失败。`,
    '撤销 API Key',
    {
      confirmButtonText: '撤销',
      cancelButtonText: '取消',
      type: 'warning',
    }
  )
    .then(() => revokeKey())
    .catch(() => {});
}

async function copyFreshKey() {
  if (!freshKey.value) return;
  copying.value = true;
  try {
    await navigator.clipboard.writeText(freshKey.value);
  } catch {
    keyError.value =
      '复制失败：浏览器未授予剪贴板权限，请手动选中 Key 文本后 Ctrl+C';
  } finally {
    copying.value = false;
  }
}

// ── 格式化 ──────────────────────────────────────────────────────────────
function formatTime(value) {
  if (!value) return '—';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return String(value);
  const d = new Date(time);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shortId(value) {
  const id = String(value || '').trim();
  return id.length > 24 ? `${id.slice(0, 12)}…${id.slice(-8)}` : id || '—';
}

function amountText(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}

const PAYMENT_STATUS = {
  pending: { label: '待支付', type: 'warning' },
  fulfilled: { label: '已支付', type: 'success' },
  cancelled: { label: '已取消', type: 'info' },
  expired: { label: '已过期', type: 'info' },
  failed: { label: '支付失败', type: 'danger' },
};
function paymentStatusLabel(status) {
  return PAYMENT_STATUS[status]?.label || status || '未知';
}
function paymentTagType(status) {
  return PAYMENT_STATUS[status]?.type || 'info';
}

function nodeCountText(group) {
  const nodes = group.nodes || group.nodeList || group.endpoints;
  if (Array.isArray(nodes)) return `${nodes.length} 个节点`;
  if (Number.isFinite(Number(group.nodeCount))) return `${group.nodeCount} 个节点`;
  return '节点数未知';
}

function groupStatusTag(group) {
  return group.isActive === false ? 'info' : 'success';
}

function groupStatusText(group) {
  if (group.isActive === false) return '已停用';
  if (group.refreshError || group.lastError) return '需刷新';
  return '正常';
}

// ── 导航 ────────────────────────────────────────────────────────────────
function goChat() {
  router.push('/chat');
}
function goTerminal() {
  router.push('/khyos');
}
function goFeatures() {
  dismissOnboarding();
  router.push('/features');
}
function goSecurity() {
  router.push('/security');
}
function goBilling() {
  router.push('/payments');
}
function goUsage() {
  router.push('/usage');
}
function goProxies() {
  router.push('/proxies');
}

onMounted(loadOverview);
</script>

<style scoped>
.user-home-page {
  max-width: 1120px;
  margin: 0 auto;
}

.home-onboarding {
  margin-bottom: 12px;
  border-radius: var(--khy-radius);
}

.home-onboarding-link {
  padding: 0 2px;
  vertical-align: baseline;
}

.home-alert {
  margin-bottom: 14px;
}

.home-card {
  margin-bottom: 16px;
  border-radius: var(--khy-radius-lg);
}

.card-header-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.card-header-icon {
  color: var(--khy-primary);
  font-size: 17px;
}

.btn-icon {
  margin-right: 6px;
}

/* 概览条 */
.overview-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 18px;
}

@media (min-width: 768px) {
  .overview-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.overview-cell {
  min-width: 0;
  padding: 4px 0;
}

.overview-label {
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--khy-text-muted);
  letter-spacing: 0.2px;
}

.overview-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--khy-text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.overview-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--khy-text-secondary);
}

/* 区块内错误提示 */
.block-alert {
  margin-bottom: 12px;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}

.card-foot {
  margin-top: 8px;
  text-align: right;
}

/* API Key 区块 */
.key-prefix {
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--khy-bg-elevated, rgba(127, 127, 127, 0.1));
  font-family: var(--khy-font-mono, ui-monospace, monospace);
  font-size: 12px;
}

.fresh-key-row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.fresh-key-input {
  flex: 1;
  min-width: 0;
}

.key-note {
  margin: 12px 0 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--khy-text-secondary);
}

/* 代理订阅 */
.group-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.group-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--khy-border);
}

.group-item:last-child {
  border-bottom: none;
}

.group-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.group-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--khy-text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-meta {
  font-size: 12px;
  color: var(--khy-text-muted);
}

/* 快捷入口 */
.quick-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

/* 用量说明 */
.home-usage {
  border-style: dashed;
}

.usage-note {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--khy-text-secondary);
}

.usage-note code,
.mono-id {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--khy-bg-elevated, rgba(127, 127, 127, 0.1));
  font-family: var(--khy-font-mono, ui-monospace, monospace);
  font-size: 12px;
}
</style>
