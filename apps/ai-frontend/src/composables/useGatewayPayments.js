import { ref } from 'vue';
import request from '@/api/request';
import { unwrap } from '@/api/unwrap';

/**
 * 支付网关订单的前端接线层。
 *
 * 后端真源是 services/backend/src/services/gateway/paymentGatewayService.js,
 * 两条服务路径(monolith 的 Express 路由 / daemon 的原生分发)对外暴露同一组
 * /api/ai-gateway/payments 端点,所以这里只按端点写,不关心命中哪条路径。
 *
 * 轮询是这个页面的关键:建单后订单处于 pending,要么被 webhook/模拟确认推到
 * fulfilled,要么到 expiresAt 被后端读取时置为 expired。前端无法自己推断终态
 * (过期是后端 loadStore 时惰性标记的),所以必须轮询状态端点。
 */

/** 终态集合 —— 与后端 paymentGatewayService.js 的 FINAL_STATES 逐项对齐。 */
export const FINAL_PAYMENT_STATES = Object.freeze(['fulfilled', 'failed', 'cancelled', 'expired']);

/** 终态判定:大小写与空白不敏感,非法值一律视为未终结(继续轮询更安全)。 */
export function isFinalPaymentStatus(status) {
  return FINAL_PAYMENT_STATES.includes(
    String(status || '')
      .trim()
      .toLowerCase()
  );
}

/**
 * 把表单里的额度字段收敛成后端 normalizeGrant 认得的形状。
 * 三项都为空时返回 null —— 让后端按 amountCny 兜底成等额预算,
 * 而不是前端擅自替它决定发放什么额度。
 */
export function buildGrantPayload(form = {}) {
  const toInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const toMoney = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
  };
  const grant = {
    monthlyRequests: toInt(form.monthlyRequests),
    monthlyTokens: toInt(form.monthlyTokens),
    monthlyBudgetCny: toMoney(form.monthlyBudgetCny),
  };
  const empty = !grant.monthlyRequests && !grant.monthlyTokens && !grant.monthlyBudgetCny;
  return empty ? null : grant;
}

export function useGatewayPayments() {
  const payments = ref([]);
  const total = ref(0);
  const page = ref(1);
  const pageSize = ref(20);
  /** 当前聚焦的订单视图(含 checkout 二维码与 events 事件流)。 */
  const current = ref(null);
  const loadingList = ref(false);
  const submitting = ref(false);
  const polling = ref(false);

  let pollTimer = null;
  // 单调递增的轮询代号:stopPolling 或新一轮 startPolling 会让旧回合的
  // in-flight 响应作废,避免过期响应把 current 覆盖回旧状态。
  let pollGeneration = 0;

  async function fetchPayments(filters = {}) {
    try {
      loadingList.value = true;
      const params = {
        page: filters.page || page.value,
        pageSize: filters.pageSize || pageSize.value,
      };
      if (filters.status) params.status = filters.status;
      if (filters.customerId) params.customerId = filters.customerId;
      if (filters.provider) params.provider = filters.provider;
      const data = unwrap(await request.get('/api/ai-gateway/payments', { params })) || {};
      payments.value = Array.isArray(data.list) ? data.list : [];
      total.value = Number(data.total || 0);
      page.value = Number(data.page || params.page);
      pageSize.value = Number(data.pageSize || params.pageSize);
      return payments.value;
    } finally {
      loadingList.value = false;
    }
  }

  async function createPayment(input = {}) {
    try {
      submitting.value = true;
      const body = {
        customerId: String(input.customerId || '').trim(),
        amountCny: Number(input.amountCny),
      };
      if (input.subject) body.subject = String(input.subject).trim();
      if (input.description) body.description = String(input.description).trim();
      if (input.idempotencyKey) body.idempotencyKey = String(input.idempotencyKey).trim();
      if (input.expiresInMinutes) body.expiresInMinutes = Number(input.expiresInMinutes);
      if (input.grant) body.grant = input.grant;
      const order = unwrap(await request.post('/api/ai-gateway/payments', body));
      current.value = order;
      return order;
    } finally {
      submitting.value = false;
    }
  }

  async function fetchPayment(paymentId) {
    const id = String(paymentId || '').trim();
    if (!id) throw new Error('paymentId is required');
    const order = unwrap(await request.get(`/api/ai-gateway/payments/${encodeURIComponent(id)}`));
    current.value = order;
    return order;
  }

  async function cancelPayment(paymentId, reason = '') {
    const id = String(paymentId || '').trim();
    const order = unwrap(
      await request.post(`/api/ai-gateway/payments/${encodeURIComponent(id)}/cancel`, {
        reason: String(reason || '').trim() || 'cancelled_by_operator',
      })
    );
    current.value = order;
    return order;
  }

  /**
   * 触发 mock 渠道的「已支付」回调。仅 mock 渠道可用:后端 confirmMockPayment
   * 会跳过签名校验直接走 processWebhook,所以这是本地联调打通全链路的入口。
   */
  async function confirmMockPayment(paymentId, input = {}) {
    const id = String(paymentId || '').trim();
    const body = {};
    if (input.gatewayTradeNo) body.gatewayTradeNo = String(input.gatewayTradeNo).trim();
    if (input.eventId) body.eventId = String(input.eventId).trim();
    if (input.amountCny != null) body.amountCny = Number(input.amountCny);
    const order = unwrap(
      await request.post(`/api/ai-gateway/payments/${encodeURIComponent(id)}/mock/confirm`, body)
    );
    current.value = order;
    return order;
  }

  function stopPolling() {
    pollGeneration += 1;
    polling.value = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  /**
   * 轮询到终态为止。用递归 setTimeout 而非 setInterval,确保上一次请求未回来
   * 时不会叠加下一次请求。onSettled 只在真正落到终态时回调一次。
   */
  function startPolling(paymentId, { intervalMs = 3000, onSettled, onError } = {}) {
    stopPolling();
    const id = String(paymentId || '').trim();
    if (!id) return;
    const generation = ++pollGeneration;
    polling.value = true;

    const tick = async () => {
      if (generation !== pollGeneration) return;
      try {
        const order = await fetchPayment(id);
        if (generation !== pollGeneration) return;
        if (isFinalPaymentStatus(order?.status)) {
          polling.value = false;
          pollTimer = null;
          if (typeof onSettled === 'function') onSettled(order);
          return;
        }
      } catch (error) {
        if (generation !== pollGeneration) return;
        // 单次失败不终止轮询(网络抖动很常见),但把错误透出去让页面决定是否提示。
        if (typeof onError === 'function') onError(error);
      }
      if (generation !== pollGeneration) return;
      pollTimer = setTimeout(tick, intervalMs);
    };

    pollTimer = setTimeout(tick, intervalMs);
  }

  return {
    payments,
    total,
    page,
    pageSize,
    current,
    loadingList,
    submitting,
    polling,
    fetchPayments,
    createPayment,
    fetchPayment,
    cancelPayment,
    confirmMockPayment,
    startPolling,
    stopPolling,
  };
}
