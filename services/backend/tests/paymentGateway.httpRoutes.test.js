'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const MODULES = [
  '../src/routes/paymentWebhooks',
  '../src/services/aiManagementServer',
  '../src/services/gateway/paymentGatewayService',
  '../src/services/gateway/customerRegistry',
  '../src/services/gateway/proxyServer',
  '../src/utils/dataHome',
];

function resetModules() {
  for (const mod of MODULES) {
    try { delete require.cache[require.resolve(mod)]; } catch { /* ignore */ }
  }
}

function withIsolatedHome(t, env = {}) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-paygw-http-'));
  const saved = {
    KHY_DATA_HOME: process.env.KHY_DATA_HOME,
    AI_PAYMENT_WEBHOOK_SECRET: process.env.AI_PAYMENT_WEBHOOK_SECRET,
    KHY_PAYMENT_WEBHOOK_SECRET: process.env.KHY_PAYMENT_WEBHOOK_SECRET,
    NODE_ENV: process.env.NODE_ENV,
  };

  process.env.KHY_DATA_HOME = tmpHome;
  delete process.env.AI_PAYMENT_WEBHOOK_SECRET;
  delete process.env.KHY_PAYMENT_WEBHOOK_SECRET;
  process.env.NODE_ENV = 'test';
  Object.assign(process.env, env);
  resetModules();

  t.after(() => {
    resetModules();
    if (saved.KHY_DATA_HOME === undefined) delete process.env.KHY_DATA_HOME;
    else process.env.KHY_DATA_HOME = saved.KHY_DATA_HOME;
    if (saved.AI_PAYMENT_WEBHOOK_SECRET === undefined) delete process.env.AI_PAYMENT_WEBHOOK_SECRET;
    else process.env.AI_PAYMENT_WEBHOOK_SECRET = saved.AI_PAYMENT_WEBHOOK_SECRET;
    if (saved.KHY_PAYMENT_WEBHOOK_SECRET === undefined) delete process.env.KHY_PAYMENT_WEBHOOK_SECRET;
    else process.env.KHY_PAYMENT_WEBHOOK_SECRET = saved.KHY_PAYMENT_WEBHOOK_SECRET;
    if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.NODE_ENV;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  return {
    customerRegistry: require('../src/services/gateway/customerRegistry'),
    paymentService: require('../src/services/gateway/paymentGatewayService'),
    paymentWebhookRouter: require('../src/routes/paymentWebhooks'),
    aiManagementServer: require('../src/services/aiManagementServer'),
  };
}

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.headersSent = false;
    this.body = '';
    this.payload = null;
    this.finished = false;
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = value;
  }

  getHeader(name) {
    return this.headers[String(name).toLowerCase()];
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [key, value] of Object.entries(headers)) this.setHeader(key, value);
    this.headersSent = true;
    return this;
  }

  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  json(payload) {
    this.payload = payload;
    this.setHeader('Content-Type', 'application/json');
    this.end(JSON.stringify(payload));
    return this;
  }

  end(chunk = '') {
    if (chunk) this.body += String(chunk);
    this.headersSent = true;
    this.finished = true;
    if (this.payload == null && this.body) {
      try { this.payload = JSON.parse(this.body); } catch { /* keep raw */ }
    }
    this.emit('finish');
    return this;
  }
}

function createMockRequest(method, routePath, body, options = {}) {
  const headers = {};
  for (const [key, value] of Object.entries(options.headers || {})) {
    headers[String(key).toLowerCase()] = value;
  }
  const payload = body == null ? null : JSON.stringify(body);
  const req = Readable.from(payload ? [payload] : []);
  req.method = method;
  req.url = routePath;
  req.headers = headers;
  req.protocol = options.protocol || 'http';
  req.body = options.parsedBody !== undefined ? options.parsedBody : undefined;
  req.authContext = options.authUser ? { user: options.authUser } : undefined;
  req.get = (name) => req.headers[String(name).toLowerCase()] || '';
  return req;
}

async function invokeRoute(handler, req, res = new MockResponse()) {
  const finishPromise = new Promise((resolve) => {
    res.once('finish', () => {
      let json = res.payload;
      if (json == null && res.body) {
        try { json = JSON.parse(res.body); } catch { /* keep raw */ }
      }
      resolve({ code: res.statusCode, body: res.body, json });
    });
  });

  await Promise.resolve(handler(req, res)).catch((err) => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  return finishPromise;
}

async function dispatchAiGatewayRequest(handler, method, routePath, body, authUser = { id: 0, role: 'admin' }) {
  const req = createMockRequest(method, routePath, body, {
    authUser,
    headers: {
      host: 'daemon.example.test',
      'content-type': 'application/json',
    },
  });
  const res = new MockResponse();
  const url = new URL(req.url, 'http://daemon.example.test');
  const finishPromise = new Promise((resolve) => {
    res.once('finish', () => {
      let json = null;
      try { json = res.body ? JSON.parse(res.body) : null; } catch { /* keep raw */ }
      resolve({ code: res.statusCode, body: res.body, json });
    });
  });

  await Promise.resolve(handler(req, res, url.pathname, url.searchParams)).catch((err) => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  return finishPromise;
}

test('public payment webhook route fulfills order and applies customer quota', async (t) => {
  const { customerRegistry, paymentService, paymentWebhookRouter } = withIsolatedHome(t, {
    AI_PAYMENT_WEBHOOK_SECRET: 'webhook-secret-001',
  });

  customerRegistry.createCustomer({
    id: 'cus_route',
    name: 'Webhook Route Customer',
    quota: {
      monthlyRequests: 5,
      monthlyTokens: 100,
      monthlyBudgetCny: 20,
    },
  });

  const created = await paymentService.createPayment({
    customerId: 'cus_route',
    amountCny: 88,
    grant: {
      monthlyRequests: 7,
      monthlyTokens: 250,
      monthlyBudgetCny: 88,
    },
  }, {
    actorUser: { id: 0, role: 'admin' },
    baseUrl: 'https://pay.example.test',
  });

  const payload = {
    orderId: created.id,
    eventId: 'evt_route_paid_1',
    status: 'paid',
    amountCny: 88,
    gatewayTradeNo: 'mock_trade_route_1',
  };
  const signature = paymentService.signMockWebhookPayload(payload, 'webhook-secret-001');

  const mockRoute = paymentWebhookRouter.stack.find(
    (layer) => layer.route && layer.route.path === '/mock' && layer.route.methods.post,
  );
  assert.ok(mockRoute, 'mock webhook route should be mounted');
  const routeHandler = mockRoute.route.stack[mockRoute.route.stack.length - 1].handle;

  const response = await invokeRoute(
    routeHandler,
    createMockRequest('POST', '/mock', null, {
      parsedBody: payload,
      protocol: 'https',
      headers: {
        host: 'pay.example.test',
        'x-khy-signature': `sha256=${signature}`,
      },
    }),
  );

  assert.equal(response.code, 200);
  assert.equal(response.json.success, true);
  assert.equal(response.json.data.status, 'fulfilled');
  assert.equal(response.json.data.result.customerId, 'cus_route');
  assert.equal(response.json.data.result.quotaAfter.monthlyRequests, 12);
  assert.equal(response.json.data.result.quotaAfter.monthlyTokens, 350);
  assert.equal(response.json.data.result.quotaAfter.monthlyBudgetCny, 108);

  const customerAfter = customerRegistry.getCustomer('cus_route');
  assert.equal(customerAfter.quota.monthlyRequests, 12);
  assert.equal(customerAfter.quota.monthlyTokens, 350);
  assert.equal(customerAfter.quota.monthlyBudgetCny, 108);

  const rejected = await invokeRoute(
    routeHandler,
    createMockRequest('POST', '/mock', null, {
      parsedBody: {
        orderId: created.id,
        eventId: 'evt_route_paid_2',
        status: 'paid',
        amountCny: 88,
      },
      protocol: 'https',
      headers: {
        host: 'pay.example.test',
        'x-khy-signature': 'sha256=bad-signature',
      },
    }),
  );

  assert.equal(rejected.code, 400);
  assert.equal(rejected.json.success, false);
  assert.match(rejected.json.message, /invalid webhook signature/i);
});

test('daemon ai-gateway payment routes create, query, confirm and list orders', async (t) => {
  const { customerRegistry, aiManagementServer } = withIsolatedHome(t);
  const namespaceHandler = aiManagementServer.__test__.handleAiGatewayNamespace;

  customerRegistry.createCustomer({
    id: 'cus_daemon',
    name: 'Daemon Payment Customer',
    quota: {
      monthlyRequests: 1,
      monthlyTokens: 10,
      monthlyBudgetCny: 5,
    },
  });

  const createdResponse = await dispatchAiGatewayRequest(namespaceHandler, 'POST', '/api/ai-gateway/payments', {
    customerId: 'cus_daemon',
    amountCny: 66,
    grant: {
      monthlyRequests: 4,
      monthlyTokens: 600,
      monthlyBudgetCny: 66,
    },
    idempotencyKey: 'daemon-pay-001',
  });

  assert.equal(createdResponse.code, 200);
  assert.equal(createdResponse.json.status, 'pending');
  assert.equal(createdResponse.json.customerId, 'cus_daemon');
  assert.match(createdResponse.json.checkout.confirmUrl, /\/api\/ai-gateway\/payments\/[^/]+\/mock\/confirm$/);

  const paymentId = createdResponse.json.id;

  const detailResponse = await dispatchAiGatewayRequest(
    namespaceHandler,
    'GET',
    `/api/ai-gateway/payments/${paymentId}`,
  );

  assert.equal(detailResponse.code, 200);
  assert.equal(detailResponse.json.id, paymentId);
  assert.equal(detailResponse.json.events.length, 1);

  const confirmResponse = await dispatchAiGatewayRequest(
    namespaceHandler,
    'POST',
    `/api/ai-gateway/payments/${paymentId}/mock/confirm`,
    {
      eventId: 'evt_daemon_paid_1',
      amountCny: 66,
    },
  );

  assert.equal(confirmResponse.code, 200);
  assert.equal(confirmResponse.json.status, 'fulfilled');
  assert.equal(confirmResponse.json.result.quotaAfter.monthlyRequests, 5);
  assert.equal(confirmResponse.json.result.quotaAfter.monthlyTokens, 610);
  assert.equal(confirmResponse.json.result.quotaAfter.monthlyBudgetCny, 71);

  const listResponse = await dispatchAiGatewayRequest(namespaceHandler, 'GET', '/api/ai-gateway/payments');
  assert.equal(listResponse.code, 200);
  assert.equal(listResponse.json.total, 1);
  assert.equal(listResponse.json.list[0].id, paymentId);

  const customerAfter = customerRegistry.getCustomer('cus_daemon');
  assert.equal(customerAfter.quota.monthlyRequests, 5);
  assert.equal(customerAfter.quota.monthlyTokens, 610);
  assert.equal(customerAfter.quota.monthlyBudgetCny, 71);
});
