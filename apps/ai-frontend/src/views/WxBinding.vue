<template>
  <div class="wx-page">
    <KhyPageHeader title="微信绑定">
      <template #actions>
        <el-button type="primary" @click="addScanSession">扫码绑定新账号</el-button>
        <el-button :loading="loading" @click="reload">刷新</el-button>
      </template>
    </KhyPageHeader>

    <el-alert type="info" :closable="false">
      <template #icon><KhyIcon kind="chat" size="small" /></template>
      <template #title
        >微信个人号扫码绑定，并将账号路由到工作空间 /
        Agent。守护进程负责长轮询接收与投递消息。</template
      >
    </el-alert>

    <el-alert
      v-if="!daemonRunning"
      type="warning"
      :closable="false"
      title="守护进程未运行：已绑定账号将暂不进行长轮询，扫码接入成功后会自动尝试启动 / 重启。"
      class="page-alert"
    >
      <template #icon><KhyIcon kind="warning" size="small" /></template>
    </el-alert>

    <!-- 扫码卡片区：每卡 = 一个待绑定设备的独立二维码会话，可独立取消 / 重试 -->
    <section v-if="sessions.length" class="scan-grid">
      <div
        v-for="item in sessions"
        :key="item.localId"
        class="scan-card"
        :class="`is-${item.status}`"
      >
        <div class="scan-card-head">
          <span class="scan-card-title">待绑定设备</span>
          <el-tag :type="cardStatus(item).type" size="small">{{ cardStatus(item).label }}</el-tag>
        </div>
        <div class="scan-card-qr">
          <img
            v-if="item.status !== 'success' && item.qr.dataUrl"
            :src="item.qr.dataUrl"
            alt="微信登录二维码"
            class="scan-qr-img"
          />
          <div v-else-if="item.status === 'success'" class="scan-qr-result scan-qr-ok">
            <KhyIcon kind="success" class="scan-result-icon" />
            <span class="scan-result-title">{{ successTitle(item) }}</span>
            <span v-if="item.rebound && boundAtText(item)" class="scan-result-sub"
              >首次绑定于 {{ boundAtText(item) }}</span
            >
          </div>
          <div
            v-else-if="item.status === 'error' || item.status === 'expired'"
            class="scan-qr-result scan-qr-bad"
          >
            <KhyIcon kind="error" class="scan-result-icon" />
            <span>{{ item.status === 'expired' ? '二维码已过期' : '扫码失败' }}</span>
          </div>
          <div v-else-if="item.qr.qrcodeUrl" class="scan-qr-fallback">
            <p>二维码图片不可用，请手动打开以下链接完成扫码：</p>
            <el-link type="primary" :href="item.qr.qrcodeUrl" target="_blank" rel="noopener">{{
              item.qr.qrcodeUrl
            }}</el-link>
          </div>
          <div v-else class="scan-qr-placeholder">
            <KhyIcon kind="refresh" class="is-loading" />
            <span>正在获取二维码…</span>
          </div>
        </div>
        <p class="scan-card-status">{{ item.statusText || '等待扫码…' }}</p>
        <p v-if="item.error" class="scan-card-error">{{ item.error }}</p>
        <div class="scan-card-actions">
          <el-button
            v-if="item.status === 'error' || item.status === 'expired'"
            size="small"
            type="primary"
            @click="onRetrySession(item)"
            >重试</el-button
          >
          <el-button size="small" @click="onCancelSession(item)">
            {{ item.status === 'success' ? '关闭' : '取消' }}
          </el-button>
        </div>
      </div>
    </section>

    <el-table :data="accounts" size="small" stripe class="wx-table" v-loading="loading">
      <el-table-column prop="accountId" label="账号ID" min-width="140" show-overflow-tooltip />
      <el-table-column prop="userId" label="用户ID" min-width="130" show-overflow-tooltip />
      <el-table-column prop="token" label="Token 掩码" min-width="150" show-overflow-tooltip />
      <el-table-column label="绑定工作空间" min-width="140">
        <template #default="{ row }">
          <span>{{ row.workspace || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="绑定 Agent" min-width="120">
        <template #default="{ row }">
          <span>{{ row.agent || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="活动" width="86">
        <template #default="{ row }">
          <el-tag :type="row.active ? 'success' : 'info'" size="small">
            {{ row.active ? '活动' : '待命' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="连接状态" min-width="130">
        <template #default="{ row }">
          <el-tag :type="connStatus(row).type" size="small">{{ connStatus(row).label }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="300" fixed="right">
        <template #default="{ row }">
          <el-button
            size="small"
            link
            type="primary"
            :disabled="row.active"
            @click="onSetActive(row)"
            >设为活动</el-button
          >
          <el-button size="small" link type="primary" @click="openEditRoute(row)"
            >编辑路由</el-button
          >
          <el-button
            size="small"
            link
            type="warning"
            :disabled="!row.workspace && !row.agent"
            @click="onUnbind(row)"
            >解绑路由</el-button
          >
          <el-button size="small" link type="danger" @click="onRemove(row)">移除账号</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty
      v-if="!loading && accounts.length === 0"
      description="暂无微信账号，点击右上角扫码绑定"
    />

    <!-- 编辑路由 dialog：workspace + agent → bind -->
    <el-dialog v-model="routeDialog.visible" title="编辑账号路由" width="480px">
      <el-form :model="routeDialog" label-width="110px">
        <el-form-item label="账号ID">
          <span>{{ routeDialog.accountId }}</span>
        </el-form-item>
        <el-form-item label="工作空间">
          <el-input v-model="routeDialog.workspace" placeholder="必填，例如：default" />
        </el-form-item>
        <el-form-item label="Agent">
          <el-input v-model="routeDialog.agent" placeholder="可选，留空表示不指定 Agent" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="routeDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="routeDialog.saving" @click="saveRoute"
          >保存绑定</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, onActivated, onBeforeUnmount, reactive } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import KhyIcon from '@/components/KhyIcon.vue';
import { useWxBinding } from '@/composables/useWxBinding';
import KhyPageHeader from '@/components/KhyPageHeader.vue';

defineOptions({ name: 'WxBinding' });

const {
  accounts,
  daemonRunning,
  loading,
  sessions,
  fetchAccounts,
  bind,
  unbindRoute,
  removeAccount,
  setActive,
  startLoginSession,
  retryLoginSession,
  cancelLoginSession,
  cancelAllSessions,
} = useWxBinding();

const routeDialog = reactive({
  visible: false,
  saving: false,
  accountId: '',
  workspace: '',
  agent: '',
});

// 连接状态：会话过期 > 长轮询中 > 待守护进程。
function connStatus(row) {
  if (row.expired) return { label: '会话过期需重扫', type: 'danger' };
  if (daemonRunning.value && row.heartbeatAgeMs != null)
    return { label: '长轮询中', type: 'success' };
  return { label: '待守护进程', type: 'info' };
}

async function reload() {
  try {
    await fetchAccounts();
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err?.message || '加载失败');
  }
}

async function onSetActive(row) {
  try {
    await setActive(row.accountId);
    ElMessage.success('已设为活动账号');
    await reload();
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err?.message || '设置失败');
  }
}

function openEditRoute(row) {
  routeDialog.visible = true;
  routeDialog.saving = false;
  routeDialog.accountId = row.accountId;
  routeDialog.workspace = row.workspace || '';
  routeDialog.agent = row.agent || '';
}

async function saveRoute() {
  const workspace = String(routeDialog.workspace || '').trim();
  if (!workspace) {
    ElMessage.warning('工作空间不能为空');
    return;
  }
  routeDialog.saving = true;
  try {
    await bind({
      accountId: routeDialog.accountId,
      workspace,
      agent: String(routeDialog.agent || '').trim(),
    });
    routeDialog.visible = false;
    ElMessage.success('路由绑定已保存');
    await reload();
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err?.message || '保存失败');
  } finally {
    routeDialog.saving = false;
  }
}

async function onUnbind(row) {
  try {
    await ElMessageBox.confirm(`确认解除账号 ${row.accountId} 的路由绑定吗？`, '解绑路由', {
      type: 'warning',
    });
  } catch {
    return; // 取消
  }
  try {
    await unbindRoute(row.accountId);
    ElMessage.success('已解绑路由');
    await reload();
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err?.message || '解绑失败');
  }
}

async function onRemove(row) {
  try {
    await ElMessageBox.confirm(
      `确认移除账号 ${row.accountId} 吗？将清除凭据并重启守护进程。`,
      '移除账号',
      { type: 'warning' }
    );
  } catch {
    return; // 取消
  }
  try {
    await removeAccount(row.accountId);
    ElMessage.success('账号已移除');
    await reload();
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err?.message || '移除失败');
  }
}

// ── 扫码会话生命周期（多卡并发）──────────────────────────────────────────
// 每张卡 status 机器态 → 标签文案/颜色（动作+目标+进度）。
function cardStatus(item) {
  switch (item.status) {
    case 'success':
      return { label: item.rebound ? '已刷新登录' : '绑定成功', type: 'success' };
    case 'error':
      return { label: '扫码失败待重试', type: 'danger' };
    case 'expired':
      return { label: '二维码已过期', type: 'warning' };
    case 'pending':
      return { label: '待扫描 / 待确认', type: 'primary' };
    default:
      return { label: '正在连接扫码服务', type: 'info' };
  }
}

// 成功态标题按后端 confirmed 帧的 isNew 分支：新增绑定 vs 已绑定刷新登录。
function successTitle(item) {
  return item.rebound ? '该微信此前已绑定，已刷新登录' : '绑定成功';
}

// firstBoundAt(ISO) → 本地化可读时间；无效则回退为空串（不展示副标题）。
function boundAtText(item) {
  if (!item.firstBoundAt) return '';
  const d = new Date(item.firstBoundAt);
  if (Number.isNaN(d.getTime())) return String(item.firstBoundAt);
  return d.toLocaleString();
}

const _sessionCb = {
  onSuccess: (item) => {
    ElMessage.success(
      item?.rebound
        ? '该微信此前已绑定，已刷新登录并刷新账号列表'
        : '微信账号绑定成功，账号列表已刷新'
    );
  },
  onError: (_item, err) => {
    ElMessage.error(err?.message || '扫码绑定失败，请重试');
  },
};

// 扫码绑定新账号：可多次点击，每次新增一张独立二维码卡。
function addScanSession() {
  startLoginSession(_sessionCb);
}

function onRetrySession(item) {
  retryLoginSession(item, _sessionCb);
}

async function onCancelSession(item) {
  await cancelLoginSession(item);
}

onMounted(async () => {
  await reload();
});

// keep-alive 未缓存本视图（含 SSE），仍防御性处理重访刷新。
let _activatedOnce = false;
onActivated(() => {
  if (!_activatedOnce) {
    _activatedOnce = true;
    return;
  }
  reload();
});

onBeforeUnmount(() => {
  cancelAllSessions();
});
</script>

<style scoped>
.wx-page {
  max-width: 1320px;
  margin: 0 auto;
}

.page-alert {
  margin-bottom: 14px;
}

.wx-table {
  width: 100%;
}

.scan-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
  margin-bottom: 16px;
}

.scan-card {
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  background: var(--el-bg-color);
}

.scan-card.is-success {
  border-color: var(--el-color-success);
}

.scan-card.is-error,
.scan-card.is-expired {
  border-color: var(--el-color-danger);
}

.scan-card-head {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.scan-card-title {
  font-weight: 600;
  font-size: 13px;
}

.scan-card-qr {
  min-height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.scan-qr-img {
  width: 200px;
  height: 200px;
  object-fit: contain;
}

.scan-qr-result {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}

.scan-result-icon {
  --khy-icon-size: 48px;
  width: var(--khy-icon-size, 48px);
  height: var(--khy-icon-size, 48px);
}

.scan-result-title {
  font-size: 14px;
  font-weight: 600;
  text-align: center;
}

.scan-result-sub {
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
  text-align: center;
}

.scan-qr-ok {
  color: var(--el-color-success);
}

.scan-qr-bad {
  color: var(--el-color-danger);
}

.scan-qr-fallback {
  text-align: center;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}

.scan-qr-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--el-text-color-secondary);
}

.scan-card-status {
  margin: 0;
  font-weight: 600;
  font-size: 13px;
  text-align: center;
}

.scan-card-error {
  margin: 0;
  font-size: 12px;
  color: var(--el-color-danger);
  text-align: center;
  word-break: break-all;
}

.scan-card-actions {
  display: flex;
  gap: 8px;
}
</style>
