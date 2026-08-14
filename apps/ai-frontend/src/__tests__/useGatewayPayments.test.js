import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * useGatewayPayments 的行为测试。
 *
 * 这里只测前端接线层的三件真事:
 *  1. buildGrantPayload 的收敛规则(空额度必须回落成 null,交给后端兜底)
 *  2. 终态判定与后端 FINAL_STATES 对齐
 *  3. 轮询在落到终态时停下、且旧回合的响应不能覆盖新状态
 *
 * vitest 跑在 environment: 'node' 下,挂不了组件,所以页面逻辑不在这里覆盖。
 */

const get = vi.fn();
const post = vi.fn();

vi.mock('@/api/request', () => ({
  default: {
    get: (...args) => get(...args),
    post: (...args) => post(...args),
  },
}));

const { useGatewayPayments, buildGrantPayload, isFinalPaymentStatus, FINAL_PAYMENT_STATES } =
  await import('@/composables/useGatewayPayments');

/** 后端 paymentGatewayService.js 的响应封装形状。 */
const envelope = (data) => ({ data: { success: true, data } });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildGrantPayload', () => {
  it('三项全空时返回 null，让后端按金额兜底', () => {
    expect(buildGrantPayload({})).toBeNull();
    expect(
      buildGrantPayload({ monthlyRequests: 0, monthlyTokens: 0, monthlyBudgetCny: 0 })
    ).toBeNull();
  });

  it('丢弃负数与非数值，只保留有效项', () => {
    expect(
      buildGrantPayload({ monthlyRequests: -5, monthlyTokens: 'abc', monthlyBudgetCny: 20 })
    ).toEqual({ monthlyRequests: 0, monthlyTokens: 0, monthlyBudgetCny: 20 });
  });

  it('请求数与 Token 取整，金额保留两位小数', () => {
    expect(
      buildGrantPayload({ monthlyRequests: 10.9, monthlyTokens: 5.5, monthlyBudgetCny: 12.345 })
    ).toEqual({ monthlyRequests: 10, monthlyTokens: 5, monthlyBudgetCny: 12.35 });
  });
});

describe('isFinalPaymentStatus', () => {
  it('覆盖后端 FINAL_STATES 的全部取值', () => {
    expect(FINAL_PAYMENT_STATES).toEqual(['fulfilled', 'failed', 'cancelled', 'expired']);
    for (const status of FINAL_PAYMENT_STATES) {
      expect(isFinalPaymentStatus(status)).toBe(true);
    }
  });

  it('pending 与未知值一律视为未终结', () => {
    expect(isFinalPaymentStatus('pending')).toBe(false);
    expect(isFinalPaymentStatus('')).toBe(false);
    expect(isFinalPaymentStatus(undefined)).toBe(false);
    expect(isFinalPaymentStatus('whatever')).toBe(false);
  });

  it('大小写与空白不敏感', () => {
    expect(isFinalPaymentStatus(' FULFILLED ')).toBe(true);
  });
});

describe('fetchPayments', () => {
  it('把分页与筛选透传给后端，并回填分页状态', async () => {
    get.mockResolvedValue(envelope({ list: [{ id: 'pay_1' }], total: 42, page: 2, pageSize: 50 }));
    const svc = useGatewayPayments();

    await svc.fetchPayments({ page: 2, pageSize: 50, status: 'pending' });

    expect(get).toHaveBeenCalledWith('/api/ai-gateway/payments', {
      params: { page: 2, pageSize: 50, status: 'pending' },
    });
    expect(svc.payments.value).toEqual([{ id: 'pay_1' }]);
    expect(svc.total.value).toBe(42);
    expect(svc.page.value).toBe(2);
    expect(svc.pageSize.value).toBe(50);
    expect(svc.loadingList.value).toBe(false);
  });

  it('后端返回非数组 list 时收敛成空数组', async () => {
    get.mockResolvedValue(envelope({ list: null, total: 0 }));
    const svc = useGatewayPayments();
    await svc.fetchPayments();
    expect(svc.payments.value).toEqual([]);
  });
});

describe('createPayment', () => {
  it('只提交填过的可选字段，并把订单设为 current', async () => {
    post.mockResolvedValue(envelope({ id: 'pay_2', status: 'pending' }));
    const svc = useGatewayPayments();

    const order = await svc.createPayment({
      customerId: '  cust_1  ',
      amountCny: '100',
      subject: '',
      grant: { monthlyRequests: 1, monthlyTokens: 0, monthlyBudgetCny: 0 },
    });

    expect(post).toHaveBeenCalledWith('/api/ai-gateway/payments', {
      customerId: 'cust_1',
      amountCny: 100,
      grant: { monthlyRequests: 1, monthlyTokens: 0, monthlyBudgetCny: 0 },
    });
    expect(order.id).toBe('pay_2');
    expect(svc.current.value).toEqual(order);
    expect(svc.submitting.value).toBe(false);
  });
});

describe('cancelPayment', () => {
  it('未给理由时落到默认理由，并对订单号做 URL 编码', async () => {
    post.mockResolvedValue(envelope({ id: 'pay/3', status: 'cancelled' }));
    const svc = useGatewayPayments();

    await svc.cancelPayment('pay/3');

    expect(post).toHaveBeenCalledWith('/api/ai-gateway/payments/pay%2F3/cancel', {
      reason: 'cancelled_by_operator',
    });
    expect(svc.current.value.status).toBe('cancelled');
  });
});

describe('startPolling', () => {
  it('轮询到终态后停下并只回调一次 onSettled', async () => {
    get
      .mockResolvedValueOnce(envelope({ id: 'pay_4', status: 'pending' }))
      .mockResolvedValueOnce(envelope({ id: 'pay_4', status: 'fulfilled' }));
    const onSettled = vi.fn();
    const svc = useGatewayPayments();

    svc.startPolling('pay_4', { intervalMs: 1000, onSettled });
    expect(svc.polling.value).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onSettled).not.toHaveBeenCalled();
    expect(svc.polling.value).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ status: 'fulfilled' }));
    expect(svc.polling.value).toBe(false);

    // 终态之后不应再发请求。
    await vi.advanceTimersByTimeAsync(5000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('单次请求失败不终止轮询，错误透给 onError', async () => {
    get
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(envelope({ id: 'pay_5', status: 'expired' }));
    const onError = vi.fn();
    const onSettled = vi.fn();
    const svc = useGatewayPayments();

    svc.startPolling('pay_5', { intervalMs: 1000, onSettled, onError });

    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(svc.polling.value).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
  });

  it('stopPolling 后即使旧响应回来也不再触发回调或续拍', async () => {
    let release;
    get.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const onSettled = vi.fn();
    const svc = useGatewayPayments();

    svc.startPolling('pay_6', { intervalMs: 1000, onSettled });
    await vi.advanceTimersByTimeAsync(1000);

    svc.stopPolling();
    expect(svc.polling.value).toBe(false);

    // 让那个 in-flight 请求带着终态回来 —— 它属于已作废的回合。
    release(envelope({ id: 'pay_6', status: 'fulfilled' }));
    await vi.advanceTimersByTimeAsync(2000);

    expect(onSettled).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('空订单号直接不启动轮询', async () => {
    const svc = useGatewayPayments();
    svc.startPolling('   ');
    await vi.advanceTimersByTimeAsync(5000);
    expect(svc.polling.value).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
});
