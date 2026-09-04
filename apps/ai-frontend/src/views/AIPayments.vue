<template>
  <div class="payments-page khy-page">
    <KhyPageHeader
      title="支付网关"
      subtitle="为网关客户创建额度充值订单，扫码支付后自动发放额度。"
    />

    <el-card class="section-card" shadow="hover">
      <el-row :gutter="16">
        <el-col :span="6">
          <div class="asset-stat asset-stat--amber">
            <div class="asset-stat-label">待支付</div>
            <div class="asset-stat-value">{{ summary.pending }}</div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="asset-stat asset-stat--green">
            <div class="asset-stat-label">已完成</div>
            <div class="asset-stat-value">{{ summary.fulfilled }}</div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="asset-stat asset-stat--rose">
            <div class="asset-stat-label">未成交（失败/取消/过期）</div>
            <div class="asset-stat-value">{{ summary.dead }}</div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="asset-stat asset-stat--blue">
            <div class="asset-stat-label">已成交金额（本页）</div>
            <div class="asset-stat-value">¥{{ summary.paidAmount.toFixed(2) }}</div>
          </div>
        </el-col>
      </el-row>
    </el-card>

    <el-card class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>创建充值订单</span>
          <span class="form-hint">当前仅 mock 渠道可用，真实渠道需先配置商户凭据</span>
        </div>
      </template>

      <el-form :model="form" label-width="110px" size="small">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="目标客户" required>
              <el-select
                v-model="form.customerId"
                filterable
                clearable
                placeholder="选择要充值的网关客户"
                :loading="customerSvc.loadingCustomers.value"
                style="width: 100%"
              >
                <el-option
                  v-for="c in customerOptions"
                  :key="c.id"
                  :label="`${c.name}（${c.id}）`"
                  :value="c.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="支付金额" required>
              <el-input-number v-model="form.amountCny" :min="0.01" :step="10" :precision="2" />
              <span class="form-hint">元（CNY）</span>
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="8">
            <el-form-item label="月请求数">
              <el-input-number
                v-model="form.monthlyRequests"
                :min="0"
                :step="1000"
                controls-position="right"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="月 Token 数">
              <el-input-number
                v-model="form.monthlyTokens"
                :min="0"
                :step="100000"
                controls-position="right"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="月预算">
              <el-input-number
                v-model="form.monthlyBudgetCny"
                :min="0"
                :step="10"
                :precision="2"
                controls-position="right"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item>
          <span class="form-hint"> 三项额度留空时，后端按支付金额兜底发放等额月预算。 </span>
        </el-form-item>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="订单标题">
              <el-input v-model="form.subject" placeholder="留空则自动生成" maxlength="120" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="有效期">
              <el-input-number v-model="form.expiresInMinutes" :min="1" :max="1440" :step="5" />
              <span class="form-hint">分钟，最长 24 小时</span>
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item>
          <el-button
            type="primary"
            :loading="svc.submitting.value"
            :disabled="!canSubmit"
            @click="onCreate"
          >
            创建订单并生成二维码
          </el-button>
          <el-button @click="resetForm">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>订单列表</span>
          <div class="header-actions">
            <el-select
              v-model="filters.status"
              size="small"
              clearable
              placeholder="全部状态"
              style="width: 140px"
            >
              <el-option v-for="s in STATUS_OPTIONS" :key="s" :label="statusLabel(s)" :value="s" />
            </el-select>
            <el-button size="small" :loading="svc.loadingList.value" @click="reload"
              >刷新</el-button
            >
          </div>
        </div>
      </template>

      <el-table :data="svc.payments.value" size="small" stripe v-loading="svc.loadingList.value">
        <el-table-column prop="id" label="订单号" width="150" />
        <el-table-column prop="customerName" label="客户" min-width="140" />
        <el-table-column label="金额" width="110">
          <template #default="{ row }">¥{{ Number(row.amountCny || 0).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">{{
              statusLabel(row.status)
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="回调次数" width="100">
          <template #default="{ row }">{{ row.webhookCount || 0 }}</template>
        </el-table-column>
        <el-table-column label="操作" width="190">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openOrder(row.id)">详情</el-button>
            <el-button
              v-if="!isFinalPaymentStatus(row.status)"
              size="small"
              text
              type="danger"
              @click="onCancel(row.id)"
            >
              取消
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="svc.total.value > svc.pageSize.value" class="table-pager">
        <el-pagination
          :current-page="svc.page.value"
          :page-size="svc.pageSize.value"
          :total="svc.total.value"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          size="small"
          background
          @current-change="onPageChange"
          @size-change="onPageSizeChange"
        />
      </div>
    </el-card>

    <el-dialog
      v-model="checkoutVisible"
      title="扫码支付"
      width="720px"
      :close-on-click-modal="false"
      @closed="onCheckoutClosed"
    >
      <div v-if="order" class="checkout-body">
        <div class="checkout-qr">
          <img
            v-if="order.checkout?.qrCodeDataUrl"
            :src="order.checkout.qrCodeDataUrl"
            alt="支付二维码"
          />
          <div v-else class="checkout-qr-missing">二维码未返回</div>
          <el-tag :type="statusTagType(order.status)" class="checkout-status">
            {{ statusLabel(order.status) }}
            <template v-if="svc.polling.value && !isFinalPaymentStatus(order.status)">
              · 轮询中</template
            >
          </el-tag>
          <div v-if="!isFinalPaymentStatus(order.status)" class="checkout-countdown">
            剩余 {{ countdownText }}
          </div>
        </div>

        <div class="checkout-meta">
          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item label="订单号">{{ order.id }}</el-descriptions-item>
            <el-descriptions-item label="客户"
              >{{ order.customerName }}（{{ order.customerId }}）</el-descriptions-item
            >
            <el-descriptions-item label="金额"
              >¥{{ Number(order.amountCny || 0).toFixed(2) }}
              {{ order.currency }}</el-descriptions-item
            >
            <el-descriptions-item label="标题">{{ order.subject }}</el-descriptions-item>
            <el-descriptions-item label="将发放额度">
              <div>月请求数：{{ order.grant?.monthlyRequests || 0 }}</div>
              <div>月 Token：{{ order.grant?.monthlyTokens || 0 }}</div>
              <div>月预算：¥{{ Number(order.grant?.monthlyBudgetCny || 0).toFixed(2) }}</div>
            </el-descriptions-item>
            <el-descriptions-item label="过期时间">{{
              formatTime(order.expiresAt)
            }}</el-descriptions-item>
            <el-descriptions-item v-if="order.gatewayTradeNo" label="渠道流水号">{{
              order.gatewayTradeNo
            }}</el-descriptions-item>
            <el-descriptions-item v-if="order.failureReason" label="失败原因">{{
              order.failureReason
            }}</el-descriptions-item>
            <el-descriptions-item v-if="order.cancellationReason" label="取消原因">{{
              order.cancellationReason
            }}</el-descriptions-item>
          </el-descriptions>

          <div v-if="order.status === 'fulfilled'" class="checkout-result">
            <el-alert type="success" :closable="false" title="额度已发放">
              <div>月请求数：{{ order.result?.quotaAfter?.monthlyRequests ?? '—' }}</div>
              <div>月 Token：{{ order.result?.quotaAfter?.monthlyTokens ?? '—' }}</div>
              <div>月预算：{{ order.result?.quotaAfter?.monthlyBudgetCny ?? '—' }}</div>
            </el-alert>
          </div>
        </div>
      </div>

      <div v-if="order?.events?.length" class="checkout-events">
        <div class="checkout-events-title">事件时间线</div>
        <el-timeline>
          <el-timeline-item
            v-for="evt in order.events"
            :key="evt.id"
            :timestamp="formatTime(evt.createdAt)"
            size="small"
          >
            {{ evt.type }}
            <span class="form-hint">{{ evt.source }}</span>
          </el-timeline-item>
        </el-timeline>
      </div>

      <template #footer>
        <el-button @click="checkoutVisible = false">关闭</el-button>
        <el-button
          v-if="order && !isFinalPaymentStatus(order.status)"
          type="danger"
          plain
          @click="onCancel(order.id)"
        >
          取消订单
        </el-button>
        <el-button
          v-if="order && !isFinalPaymentStatus(order.status)"
          type="primary"
          :loading="confirming"
          @click="onMockConfirm"
        >
          模拟已支付
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import KhyPageHeader from '@/components/KhyPageHeader.vue';
import { useAssetCustomer } from '@/composables/useAssetCustomer';
import {
  useGatewayPayments,
  isFinalPaymentStatus,
  buildGrantPayload,
} from '@/composables/useGatewayPayments';

defineOptions({ name: 'AIPayments' });

const STATUS_OPTIONS = ['pending', 'fulfilled', 'failed', 'cancelled', 'expired'];
const STATUS_LABELS = {
  pending: '待支付',
  fulfilled: '已完成',
  failed: '支付失败',
  cancelled: '已取消',
  expired: '已过期',
};

const svc = useGatewayPayments();
const customerSvc = useAssetCustomer();

const filters = reactive({ status: '' });
const checkoutVisible = ref(false);
const confirming = ref(false);
// 秒级心跳,只为驱动倒计时文案重算(倒计时是纯派生值,不额外存状态)。
const nowMs = ref(Date.now());
let clockTimer = null;

const form = reactive({
  customerId: '',
  amountCny: 100,
  monthlyRequests: 0,
  monthlyTokens: 0,
  monthlyBudgetCny: 0,
  subject: '',
  expiresInMinutes: 30,
});

const order = computed(() => svc.current.value);

const customerOptions = computed(() => {
  const rows = customerSvc.customers.value;
  return Array.isArray(rows) ? rows : [];
});

const canSubmit = computed(() => !!form.customerId && Number(form.amountCny) > 0);

const summary = computed(() => {
  const rows = Array.isArray(svc.payments.value) ? svc.payments.value : [];
  const out = { pending: 0, fulfilled: 0, dead: 0, paidAmount: 0 };
  for (const row of rows) {
    const status = String(row?.status || '').toLowerCase();
    if (status === 'pending') out.pending += 1;
    else if (status === 'fulfilled') {
      out.fulfilled += 1;
      out.paidAmount += Number(row?.amountCny || 0);
    } else out.dead += 1;
  }
  out.paidAmount = Math.round(out.paidAmount * 100) / 100;
  return out;
});

const countdownText = computed(() => {
  const expiresAt = Date.parse(order.value?.expiresAt || '');
  if (!Number.isFinite(expiresAt)) return '—';
  const left = Math.max(0, expiresAt - nowMs.value);
  const totalSec = Math.floor(left / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
});

function statusLabel(status) {
  const key = String(status || '').toLowerCase();
  return STATUS_LABELS[key] || key || '未知';
}

function statusTagType(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'fulfilled') return 'success';
  if (key === 'pending') return 'warning';
  if (key === 'failed') return 'danger';
  return 'info';
}

function formatTime(value) {
  const ms = Date.parse(value || '');
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function errorMessageOf(error, fallback) {
  return String(
    error?.response?.data?.error || error?.response?.data?.message || error?.message || fallback
  );
}

async function reload() {
  try {
    await svc.fetchPayments({ page: 1, status: filters.status });
  } catch (error) {
    ElMessage.error(errorMessageOf(error, '加载订单列表失败'));
  }
}

async function onPageChange(nextPage) {
  try {
    await svc.fetchPayments({ page: nextPage, status: filters.status });
  } catch (error) {
    ElMessage.error(errorMessageOf(error, '翻页失败'));
  }
}

async function onPageSizeChange(nextSize) {
  try {
    await svc.fetchPayments({ page: 1, pageSize: nextSize, status: filters.status });
  } catch (error) {
    ElMessage.error(errorMessageOf(error, '切换分页大小失败'));
  }
}

function resetForm() {
  form.customerId = '';
  form.amountCny = 100;
  form.monthlyRequests = 0;
  form.monthlyTokens = 0;
  form.monthlyBudgetCny = 0;
  form.subject = '';
  form.expiresInMinutes = 30;
}

/** 订单进入终态后统一收尾:停轮询、提示、刷新列表。 */
function settle(settled) {
  svc.stopPolling();
  if (settled?.status === 'fulfilled') {
    ElMessage.success('支付完成，额度已发放');
  } else {
    ElMessage.warning(`订单已${statusLabel(settled?.status)}`);
  }
  reload();
}

function beginWatching(created) {
  checkoutVisible.value = true;
  if (isFinalPaymentStatus(created?.status)) return;
  svc.startPolling(created.id, {
    intervalMs: 3000,
    onSettled: settle,
    onError: () => {
      /* 轮询单次失败不打扰用户,下一拍会重试 */
    },
  });
}

async function onCreate() {
  if (!canSubmit.value) {
    ElMessage.warning('请选择客户并填写大于 0 的金额');
    return;
  }
  try {
    const created = await svc.createPayment({
      customerId: form.customerId,
      amountCny: form.amountCny,
      subject: form.subject,
      expiresInMinutes: form.expiresInMinutes,
      grant: buildGrantPayload(form),
    });
    beginWatching(created);
    reload();
  } catch (error) {
    ElMessage.error(errorMessageOf(error, '创建订单失败'));
  }
}

async function openOrder(paymentId) {
  try {
    const detail = await svc.fetchPayment(paymentId);
    beginWatching(detail);
  } catch (error) {
    ElMessage.error(errorMessageOf(error, '获取订单详情失败'));
  }
}

async function onCancel(paymentId) {
  try {
    await ElMessageBox.confirm('取消后该订单不可再支付，确认取消？', '取消订单', {
      type: 'warning',
      confirmButtonText: '确认取消',
      cancelButtonText: '返回',
    });
  } catch {
    return;
  }
  try {
    svc.stopPolling();
    await svc.cancelPayment(paymentId);
    ElMessage.success('订单已取消');
    reload();
  } catch (error) {
    ElMessage.error(errorMessageOf(error, '取消订单失败'));
  }
}

async function onMockConfirm() {
  const current = order.value;
  if (!current) return;
  try {
    confirming.value = true;
    svc.stopPolling();
    const updated = await svc.confirmMockPayment(current.id);
    if (isFinalPaymentStatus(updated?.status)) {
      settle(updated);
    } else {
      beginWatching(updated);
    }
  } catch (error) {
    ElMessage.error(errorMessageOf(error, '模拟支付失败'));
  } finally {
    confirming.value = false;
  }
}

function onCheckoutClosed() {
  // 弹窗关掉就停轮询,否则后台会一直打状态端点。
  svc.stopPolling();
}

onMounted(async () => {
  clockTimer = setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
  try {
    await customerSvc.fetchCustomers();
  } catch (error) {
    ElMessage.error(errorMessageOf(error, '加载客户列表失败'));
  }
  reload();
});

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
  svc.stopPolling();
});
</script>

<style scoped>
.payments-page {
  max-width: 1280px;
  margin: 0 auto;
}

.section-card {
  margin-bottom: 16px;
}

.card-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.form-hint {
  margin-left: 10px;
  font-size: 12px;
  color: var(--khy-text-muted, #909399);
}

.table-pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

.asset-stat {
  padding: 14px 16px;
  border: 1px solid #e5ebf5;
  border-radius: 10px;
  background: linear-gradient(180deg, var(--khy-white), #f8fbff);
  box-shadow: 0 4px 10px rgba(15, 23, 42, 0.04);
}

.asset-stat--blue {
  border-left: 3px solid var(--khy-primary);
}
.asset-stat--amber {
  border-left: 3px solid var(--khy-warning);
}
.asset-stat--green {
  border-left: 3px solid var(--khy-success);
}
.asset-stat--rose {
  border-left: 3px solid #f43f5e;
}

.asset-stat-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  margin-bottom: 6px;
}

.asset-stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.checkout-body {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.checkout-qr {
  flex: 0 0 220px;
  text-align: center;
}

.checkout-qr img {
  width: 200px;
  height: 200px;
  border: 1px solid #e5ebf5;
  border-radius: 8px;
  background: var(--khy-white);
}

.checkout-qr-missing {
  width: 200px;
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed #dcdfe6;
  border-radius: 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.checkout-status {
  margin-top: 10px;
}

.checkout-countdown {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.checkout-meta {
  flex: 1 1 auto;
  min-width: 0;
}

.checkout-result {
  margin-top: 12px;
}

.checkout-events {
  margin-top: 18px;
  border-top: 1px solid #ebeef5;
  padding-top: 12px;
}

.checkout-events-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
  color: var(--el-text-color-primary);
}
</style>
