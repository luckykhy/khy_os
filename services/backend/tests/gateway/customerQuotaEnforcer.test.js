/**
 * customerQuotaEnforcer unit tests
 *
 * Covers: unlimited quota passthrough, disabled customer, monthly request /
 * token / budget limits, month rollover, usage metering accumulation,
 * token→customer resolution fallbacks, cross-plane usage merge (peer file
 * from ai-backend + own gateway file), fen-precision budget compare, and
 * the negative-quota warning.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('customerQuotaEnforcer', () => {
  let tmpDir;
  let enforcer;

  const CUSTOMER_TOKEN = 'khy-test-customer-token';
  const UNBOUND_TOKEN = 'khy-test-unbound-token';

  function writeStores({ customers, managedTokens, usage, gatewayUsage } = {}) {
    fs.writeFileSync(
      path.join(tmpDir, 'ai_gateway_customers.json'),
      JSON.stringify({ version: 1, customers: customers || [] }, null, 2)
    );
    fs.writeFileSync(
      path.join(tmpDir, 'proxy_server_auth.json'),
      JSON.stringify({ authToken: 'khy-primary', managedTokens: managedTokens || [] }, null, 2)
    );
    if (usage) {
      // Peer file — written by ai-backend, read-only merge source here.
      fs.writeFileSync(
        path.join(tmpDir, 'usage.json'),
        JSON.stringify({ version: 1, customers: usage }, null, 2)
      );
    }
    if (gatewayUsage) {
      // Own gateway file — the only file this module writes.
      fs.writeFileSync(
        path.join(tmpDir, 'usage.gateway.json'),
        JSON.stringify({ version: 1, customers: gatewayUsage }, null, 2)
      );
    }
    enforcer._resetForTest();
  }

  function baseCustomer(quota = {}) {
    return {
      id: 'cus_test1',
      name: '测试客户',
      enabled: true,
      quota,
      tokenIds: ['tok_1'],
    };
  }

  const managed = [
    { id: 'tok_1', token: CUSTOMER_TOKEN, enabled: true },
    { id: 'tok_orphan', token: UNBOUND_TOKEN, enabled: true },
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-quota-test-'));
    process.env.KHY_DATA_HOME = tmpDir;
    process.env.AI_GATEWAY_CUSTOMER_USAGE_FILE = path.join(tmpDir, 'usage.json');
    process.env.AI_GATEWAY_CUSTOMER_USAGE_GATEWAY_FILE = path.join(tmpDir, 'usage.gateway.json');
    jest.resetModules();
    require('../../src/utils/dataHome')._resetStorageCaches();
    enforcer = require('../../src/services/gateway/customerQuotaEnforcer');
    enforcer._resetForTest();
  });

  afterEach(() => {
    delete process.env.KHY_DATA_HOME;
    delete process.env.AI_GATEWAY_CUSTOMER_USAGE_FILE;
    delete process.env.AI_GATEWAY_CUSTOMER_USAGE_GATEWAY_FILE;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('customer without quota (all zeros) is unlimited', () => {
    writeStores({ customers: [baseCustomer({})], managedTokens: managed });
    const out = enforcer.enforce(CUSTOMER_TOKEN);
    expect(out.allowed).toBe(true);
    expect(out.customer).toMatchObject({ id: 'cus_test1' });
  });

  test('primary/unbound tokens resolve to no customer and pass through', () => {
    writeStores({ customers: [baseCustomer({})], managedTokens: managed });
    expect(enforcer.enforce('khy-primary')).toEqual({ allowed: true, customer: null });
    expect(enforcer.enforce(UNBOUND_TOKEN)).toEqual({ allowed: true, customer: null });
  });

  test('disabled customer is rejected with 403 and Chinese message', () => {
    const customer = baseCustomer({});
    customer.enabled = false;
    writeStores({ customers: [customer], managedTokens: managed });
    const out = enforcer.enforce(CUSTOMER_TOKEN);
    expect(out.allowed).toBe(false);
    expect(out.status).toBe(403);
    expect(out.code).toBe('customer_disabled');
    expect(out.message).toContain('cus_test1');
    expect(out.message).toContain('已被停用');
  });

  test('monthly request quota exceeded → 429 with used/limit numbers', () => {
    const month = enforcer.monthKey();
    writeStores({
      customers: [baseCustomer({ monthlyRequests: 10 })],
      managedTokens: managed,
      usage: { cus_test1: { [month]: { requests: 10, inputTokens: 0, outputTokens: 0, totalTokens: 0, costCny: 0, billedCny: 0 } } },
    });
    const out = enforcer.enforce(CUSTOMER_TOKEN);
    expect(out.allowed).toBe(false);
    expect(out.status).toBe(429);
    expect(out.code).toBe('monthly_requests_exceeded');
    expect(out.used).toBe(10);
    expect(out.limit).toBe(10);
    expect(out.message).toContain('10/10');
    expect(out.message).toContain(month);
  });

  test('monthly token quota exceeded → 429', () => {
    const month = enforcer.monthKey();
    writeStores({
      customers: [baseCustomer({ monthlyTokens: 1000 })],
      managedTokens: managed,
      usage: { cus_test1: { [month]: { requests: 1, inputTokens: 600, outputTokens: 500, totalTokens: 1100, costCny: 0, billedCny: 0 } } },
    });
    const out = enforcer.enforce(CUSTOMER_TOKEN);
    expect(out.allowed).toBe(false);
    expect(out.status).toBe(429);
    expect(out.code).toBe('monthly_tokens_exceeded');
    expect(out.used).toBe(1100);
    expect(out.limit).toBe(1000);
    expect(out.message).toContain('1100/1000');
  });

  test('monthly budget (CNY) exceeded → 429', () => {
    const month = enforcer.monthKey();
    writeStores({
      customers: [baseCustomer({ monthlyBudgetCny: 50 })],
      managedTokens: managed,
      usage: { cus_test1: { [month]: { requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, costCny: 55.5, billedCny: 0 } } },
    });
    const out = enforcer.enforce(CUSTOMER_TOKEN);
    expect(out.allowed).toBe(false);
    expect(out.status).toBe(429);
    expect(out.code).toBe('monthly_budget_exceeded');
    expect(out.message).toContain('¥55.50');
    expect(out.message).toContain('¥50.00');
  });

  test('month rollover: last month exhausted, new month starts from zero', () => {
    const lastMonth = enforcer.monthKey(new Date(Date.now() - 40 * 24 * 3600 * 1000));
    writeStores({
      customers: [baseCustomer({ monthlyRequests: 5, monthlyTokens: 100, monthlyBudgetCny: 1 })],
      managedTokens: managed,
      usage: { cus_test1: { [lastMonth]: { requests: 999, inputTokens: 0, outputTokens: 0, totalTokens: 99999, costCny: 999, billedCny: 999 } } },
    });
    const out = enforcer.enforce(CUSTOMER_TOKEN);
    expect(out.allowed).toBe(true);
    const usage = enforcer.getMonthUsage('cus_test1');
    expect(usage.requests).toBe(0);
    expect(usage.totalTokens).toBe(0);
  });

  test('recordUsage accumulates requests/tokens into the current-month bucket', () => {
    writeStores({ customers: [baseCustomer({ monthlyRequests: 2 })], managedTokens: managed });

    enforcer.recordUsage('cus_test1', {
      result: { tokenUsage: { inputTokens: 100, outputTokens: 50 }, provider: 'default' },
      adapterKey: 'test',
    });
    enforcer.recordUsage('cus_test1', {
      result: { tokenUsage: { prompt_tokens: 30, completion_tokens: 20 } },
      adapterKey: 'test',
    });

    const usage = enforcer.getMonthUsage('cus_test1');
    expect(usage.requests).toBe(2);
    expect(usage.inputTokens).toBe(130);
    expect(usage.outputTokens).toBe(70);
    expect(usage.totalTokens).toBe(200);

    // Quota gate now trips on the 3rd request (2 used >= limit 2).
    const out = enforcer.enforce(CUSTOMER_TOKEN);
    expect(out.allowed).toBe(false);
    expect(out.code).toBe('monthly_requests_exceeded');

    // Persistence survives an in-memory cache reset (write-through) and
    // lands in the gateway-owned file, never the ai-backend peer file.
    enforcer._resetForTest();
    const reloaded = enforcer.getMonthUsage('cus_test1');
    expect(reloaded.requests).toBe(2);
    expect(reloaded.totalTokens).toBe(200);
    expect(fs.existsSync(path.join(tmpDir, 'usage.gateway.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'usage.json'))).toBe(false);
  });

  test('usage merges across planes: peer (ai-backend) + own gateway metering', () => {
    const month = enforcer.monthKey();
    writeStores({
      customers: [baseCustomer({ monthlyRequests: 10 })],
      managedTokens: managed,
      // 6 requests already metered by the ai-backend data plane...
      usage: { cus_test1: { [month]: { requests: 6, inputTokens: 0, outputTokens: 0, totalTokens: 0, costCny: 0, billedCny: 0 } } },
      // ...plus 4 metered by this gateway → merged 10 >= limit 10.
      gatewayUsage: { cus_test1: { [month]: { requests: 4, inputTokens: 0, outputTokens: 0, totalTokens: 0, costCny: 0, billedCny: 0 } } },
    });
    const usage = enforcer.getMonthUsage('cus_test1');
    expect(usage.requests).toBe(10);
    const out = enforcer.enforce(CUSTOMER_TOKEN);
    expect(out.allowed).toBe(false);
    expect(out.code).toBe('monthly_requests_exceeded');
    expect(out.used).toBe(10);
  });

  test('budget compare is float-safe (integer fen), not raw float >=', () => {
    const month = enforcer.monthKey();
    writeStores({
      customers: [baseCustomer({ monthlyBudgetCny: 0.3 })],
      managedTokens: managed,
      // 0.1 + 0.2 = 0.30000000000000004 in float; after fen rounding it must
      // equal the 30-fen limit and trip the gate.
      gatewayUsage: { cus_test1: { [month]: { requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, costCny: 0.1 + 0.2, billedCny: 0 } } },
    });
    const out = enforcer.enforce(CUSTOMER_TOKEN);
    expect(out.allowed).toBe(false);
    expect(out.code).toBe('monthly_budget_exceeded');
  });

  test('negative quota values warn and are treated as unlimited', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      writeStores({
        customers: [baseCustomer({ monthlyRequests: -5, monthlyTokens: -1 })],
        managedTokens: managed,
      });
      const out = enforcer.enforce(CUSTOMER_TOKEN);
      expect(out.allowed).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('monthlyRequests'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('非法'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('enforce fails open when stores are unreadable', () => {
    // No store files at all — resolution finds nothing, request passes.
    enforcer._resetForTest();
    const out = enforcer.enforce('khy-anything');
    expect(out.allowed).toBe(true);
  });
});
