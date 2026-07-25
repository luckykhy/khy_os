'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const express = require('express');
const request = require('supertest');

const MODULES_TO_RESET = [
  '../../src/utils/dataHome',
  '../../src/services/gateway/proxyServer',
  '../../src/services/gateway/customerRegistry',
  '../../src/services/gateway/paymentGatewayService',
  '../../src/routes/aiGatewayPayments',
  '../../src/routes/paymentWebhooks',
];

function resetModules() {
  for (const rel of MODULES_TO_RESET) {
    try { delete require.cache[require.resolve(rel)]; } catch { /* ignore */ }
  }
}

function load(rel) {
  return require(rel);
}

function createApp(user) {
  const paymentsRoute = load('../../src/routes/aiGatewayPayments');
  const paymentWebhooksRoute = load('../../src/routes/paymentWebhooks');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/ai-gateway/payments', paymentsRoute);
  app.use('/api/payment-webhooks', paymentWebhooksRoute);
  return app;
}

describe('aiGatewayPayments route', () => {
  let tempRoot;
  let savedEnv;

  beforeEach(() => {
    savedEnv = {
      KHY_DATA_HOME: process.env.KHY_DATA_HOME,
      AI_PAYMENT_WEBHOOK_SECRET: process.env.AI_PAYMENT_WEBHOOK_SECRET,
      KHY_PAYMENT_WEBHOOK_SECRET: process.env.KHY_PAYMENT_WEBHOOK_SECRET,
    };
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-pay-route-'));
    process.env.KHY_DATA_HOME = path.join(tempRoot, '.khy');
    process.env.AI_PAYMENT_WEBHOOK_SECRET = 'route-secret';
    delete process.env.KHY_PAYMENT_WEBHOOK_SECRET;
    resetModules();
  });

  afterEach(() => {
    resetModules();
    if (savedEnv.KHY_DATA_HOME === undefined) delete process.env.KHY_DATA_HOME;
    else process.env.KHY_DATA_HOME = savedEnv.KHY_DATA_HOME;
    if (savedEnv.AI_PAYMENT_WEBHOOK_SECRET === undefined) delete process.env.AI_PAYMENT_WEBHOOK_SECRET;
    else process.env.AI_PAYMENT_WEBHOOK_SECRET = savedEnv.AI_PAYMENT_WEBHOOK_SECRET;
    if (savedEnv.KHY_PAYMENT_WEBHOOK_SECRET === undefined) delete process.env.KHY_PAYMENT_WEBHOOK_SECRET;
    else process.env.KHY_PAYMENT_WEBHOOK_SECRET = savedEnv.KHY_PAYMENT_WEBHOOK_SECRET;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function createCustomer(data = {}) {
    const customerRegistry = load('../../src/services/gateway/customerRegistry');
    return customerRegistry.createCustomer({
      id: 'cus_demo',
      name: 'Demo Customer',
      ...data,
    });
  }

  test('creates payment and fulfills it through a signed public webhook without double credit', async () => {
    const customerRegistry = load('../../src/services/gateway/customerRegistry');
    const paymentGatewayService = load('../../src/services/gateway/paymentGatewayService');
    createCustomer();
    const app = createApp({ id: 1, role: 'admin' });

    const createRes = await request(app)
      .post('/api/ai-gateway/payments')
      .send({
        customerId: 'cus_demo',
        amountCny: 88.5,
        grant: { monthlyTokens: 100000 },
        subject: 'Quota top-up',
      });

    expect(createRes.status).toBe(200);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.data.status).toBe('pending');
    expect(createRes.body.data.checkout.statusUrl).toContain(`/api/ai-gateway/payments/${createRes.body.data.id}`);
    expect(createRes.body.data.checkout.confirmUrl).toContain(`/api/ai-gateway/payments/${createRes.body.data.id}/mock/confirm`);
    expect(createRes.body.data.checkout.cancelUrl).toContain(`/api/ai-gateway/payments/${createRes.body.data.id}/cancel`);

    const orderId = createRes.body.data.id;
    const webhookPayload = {
      orderId,
      eventId: 'evt_paid_1',
      status: 'paid',
      amountCny: 88.5,
      gatewayTradeNo: 'mock_trade_1',
    };
    const signature = paymentGatewayService.signMockWebhookPayload(
      webhookPayload,
      process.env.AI_PAYMENT_WEBHOOK_SECRET
    );

    const firstWebhook = await request(app)
      .post('/api/payment-webhooks/mock')
      .set('X-KHY-Signature', signature)
      .send(webhookPayload);

    expect(firstWebhook.status).toBe(200);
    expect(firstWebhook.body.success).toBe(true);
    expect(firstWebhook.body.data.status).toBe('fulfilled');

    const customerAfterFirstWebhook = customerRegistry.getCustomer('cus_demo');
    expect(customerAfterFirstWebhook.quota.monthlyTokens).toBe(100000);

    const replayWebhook = await request(app)
      .post('/api/payment-webhooks/mock')
      .set('X-KHY-Signature', signature)
      .send(webhookPayload);

    expect(replayWebhook.status).toBe(200);
    expect(replayWebhook.body.success).toBe(true);

    const customerAfterReplay = customerRegistry.getCustomer('cus_demo');
    expect(customerAfterReplay.quota.monthlyTokens).toBe(100000);

    const detailRes = await request(app).get(`/api/ai-gateway/payments/${orderId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data.status).toBe('fulfilled');
    expect(detailRes.body.data.result.appliedGrant.monthlyTokens).toBe(100000);
    expect(detailRes.body.data.events.some((event) => event.type === 'payment.fulfilled')).toBe(true);
  });

  test('admin can fulfill a payment through the local mock confirm endpoint', async () => {
    const customerRegistry = load('../../src/services/gateway/customerRegistry');
    createCustomer({ id: 'cus_confirm' });
    const app = createApp({ id: 7, role: 'admin' });

    const createRes = await request(app)
      .post('/api/ai-gateway/payments')
      .send({
        customerId: 'cus_confirm',
        amountCny: 12,
        grant: { monthlyRequests: 25 },
      });

    expect(createRes.status).toBe(200);
    const orderId = createRes.body.data.id;

    const confirmRes = await request(app)
      .post(`/api/ai-gateway/payments/${orderId}/mock/confirm`)
      .send({
        amountCny: 12,
        gatewayTradeNo: 'mock_trade_confirm',
      });

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.success).toBe(true);
    expect(confirmRes.body.data.status).toBe('fulfilled');

    const customer = customerRegistry.getCustomer('cus_confirm');
    expect(customer.quota.monthlyRequests).toBe(25);
  });

  test('non-admin users cannot create payment orders', async () => {
    createCustomer({ id: 'cus_user' });
    const app = createApp({ id: 22, role: 'user' });

    const res = await request(app)
      .post('/api/ai-gateway/payments')
      .send({
        customerId: 'cus_user',
        amountCny: 20,
      });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});
