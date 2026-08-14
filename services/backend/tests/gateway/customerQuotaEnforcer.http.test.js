'use strict';

/**
 * HTTP-level regression tests for real-time customer quota enforcement.
 *
 * Boots the real proxy server in-process (gateway mocked) and asserts that:
 *   - a managed-token customer over the monthly request quota gets 429 with
 *     a complete error.code/message/quota payload (Chinese, with numbers),
 *     and the gateway is never invoked;
 *   - a disabled customer gets 403;
 *   - a within-quota customer request passes through and is metered into
 *     the gateway-owned usage file (single-writer contract).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const CUSTOMER_TOKEN = 'khy-http-test-customer-token';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : null;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

function postJson({ port, token, pathname, body }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += String(chunk); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* ignore */ }
        resolve({ statusCode: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

describe('proxyServer customer quota enforcement (HTTP)', () => {
  const originalEnv = { ...process.env };
  let tempHome = null;
  let proxy = null;
  let gatewayMock = null;

  function monthKey(date = new Date()) {
    return date.toISOString().slice(0, 7);
  }

  function writeStores({ customer, usage } = {}) {
    fs.writeFileSync(
      path.join(tempHome, 'proxy_server_auth.json'),
      JSON.stringify({
        authToken: 'khy-http-test-primary',
        managedTokens: [{ id: 'tok_http_1', token: CUSTOMER_TOKEN, enabled: true }],
      }, null, 2)
    );
    fs.writeFileSync(
      path.join(tempHome, 'ai_gateway_customers.json'),
      JSON.stringify({ version: 1, customers: customer ? [customer] : [] }, null, 2)
    );
    if (usage) {
      fs.writeFileSync(
        path.join(tempHome, 'usage.json'),
        JSON.stringify({ version: 1, customers: usage }, null, 2)
      );
    }
  }

  function baseCustomer(quota = {}, extra = {}) {
    return {
      id: 'cus_http1',
      name: 'HTTP 测试客户',
      enabled: true,
      quota,
      tokenIds: ['tok_http_1'],
      ...extra,
    };
  }

  beforeEach(() => {
    jest.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proxy-quota-http-'));
    process.env.HOME = tempHome;
    process.env.KHY_DATA_HOME = tempHome;
    process.env.AI_GATEWAY_CUSTOMER_USAGE_FILE = path.join(tempHome, 'usage.json');
    process.env.AI_GATEWAY_CUSTOMER_USAGE_GATEWAY_FILE = path.join(tempHome, 'usage.gateway.json');

    gatewayMock = {
      _initialized: true,
      isInitialized() { return this._initialized; },
      getAdapters() { return this._adapters; },
      init: jest.fn(async () => {}),
      generate: jest.fn(async (prompt, options) => ({
        success: true,
        content: 'ok',
        provider: options.preferredAdapter || 'mock',
        adapter: options.preferredAdapter || 'mock',
        model: options.model || null,
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
      })),
      listModels: jest.fn(async () => []),
    };

    jest.doMock('../../src/services/gateway/aiGateway', () => gatewayMock);
    jest.doMock('../../src/services/modelTrainingService', () => ({
      recordConversation: jest.fn(() => ({ accepted: true })),
    }));
    jest.doMock('../../src/services/usageHabitService', () => ({
      recordModelUsage: jest.fn(),
      recordInteraction: jest.fn(),
    }));

    require('../../src/utils/dataHome')._resetStorageCaches();
  });

  afterEach(async () => {
    if (proxy && typeof proxy.stop === 'function') {
      try { await proxy.stop(); } catch { /* ignore */ }
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    if (tempHome && fs.existsSync(tempHome)) {
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    proxy = null;
    tempHome = null;
    gatewayMock = null;
  });

  async function startProxy() {
    proxy = require('../../src/services/gateway/proxyServer');
    const port = await getFreePort();
    await proxy.start({ host: '127.0.0.1', port });
    return port;
  }

  test('over-quota customer → 429 with structured Chinese error, gateway not called', async () => {
    const month = monthKey();
    writeStores({
      customer: baseCustomer({ monthlyRequests: 3 }),
      usage: {
        cus_http1: {
          [month]: { requests: 3, inputTokens: 0, outputTokens: 0, totalTokens: 0, costCny: 0, billedCny: 0 },
        },
      },
    });
    const port = await startProxy();

    const resp = await postJson({
      port,
      token: CUSTOMER_TOKEN,
      pathname: '/v1/chat/completions',
      body: { model: 'kiro/claude-sonnet-4', stream: false, messages: [{ role: 'user', content: 'hello' }] },
    });

    expect(resp.statusCode).toBe(429);
    expect(resp.body.error.code).toBe('monthly_requests_exceeded');
    expect(resp.body.error.type).toBe('quota_exceeded');
    expect(resp.body.error.message).toContain('cus_http1');
    expect(resp.body.error.message).toContain('月度请求数已超限');
    expect(resp.body.error.message).toContain('3/3');
    expect(resp.body.error.quota).toEqual({
      scope: 'requests',
      used: 3,
      limit: 3,
      month,
    });
    expect(gatewayMock.generate).not.toHaveBeenCalled();
  });

  test('disabled customer → 403 customer_disabled', async () => {
    writeStores({ customer: baseCustomer({}, { enabled: false }) });
    const port = await startProxy();

    const resp = await postJson({
      port,
      token: CUSTOMER_TOKEN,
      pathname: '/v1/chat/completions',
      body: { model: 'kiro/claude-sonnet-4', stream: false, messages: [{ role: 'user', content: 'hello' }] },
    });

    expect(resp.statusCode).toBe(403);
    expect(resp.body.error.code).toBe('customer_disabled');
    expect(resp.body.error.message).toContain('已被停用');
    expect(gatewayMock.generate).not.toHaveBeenCalled();
  });

  test('within-quota customer passes and is metered into the gateway-owned file', async () => {
    writeStores({ customer: baseCustomer({ monthlyRequests: 5 }) });
    const port = await startProxy();

    const resp = await postJson({
      port,
      token: CUSTOMER_TOKEN,
      pathname: '/v1/chat/completions',
      body: { model: 'kiro/claude-sonnet-4', stream: false, messages: [{ role: 'user', content: 'hello' }] },
    });

    expect(resp.statusCode).toBe(200);
    expect(gatewayMock.generate).toHaveBeenCalledTimes(1);

    // Single-writer contract: metering goes to the gateway file only; the
    // ai-backend peer file is never touched by this process.
    const gatewayFile = path.join(tempHome, 'usage.gateway.json');
    expect(fs.existsSync(gatewayFile)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(gatewayFile, 'utf-8'));
    const bucket = persisted.customers.cus_http1[monthKey()];
    expect(bucket.requests).toBe(1);
    expect(bucket.inputTokens).toBe(10);
    expect(bucket.outputTokens).toBe(5);
    expect(fs.existsSync(path.join(tempHome, 'usage.json'))).toBe(false);
  });
});
