'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULES = [
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
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-paygw-'));
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

  const customerRegistry = require('../src/services/gateway/customerRegistry');
  const paymentService = require('../src/services/gateway/paymentGatewayService');
  return { tmpHome, customerRegistry, paymentService };
}

test('payment gateway end-to-end: create order -> confirm -> quota applied -> duplicate webhook idempotent', async (t) => {
  const { customerRegistry, paymentService } = withIsolatedHome(t);

  customerRegistry.createCustomer({
    id: 'cus_pay',
    name: 'Quota Customer',
    quota: {
      monthlyRequests: 10,
      monthlyTokens: 20,
      monthlyBudgetCny: 100,
    },
  });

  const created = await paymentService.createPayment({
    customerId: 'cus_pay',
    amountCny: 99.5,
    grant: {
      monthlyRequests: 30,
      monthlyBudgetCny: 200,
    },
    idempotencyKey: 'idem-001',
    subject: 'Top up Quota Customer',
  }, {
    actorUser: { id: 0, role: 'admin' },
    baseUrl: 'https://pay.example.test',
  });

  assert.equal(created.status, 'pending');
  assert.equal(created.customerId, 'cus_pay');
  assert.match(created.checkout.qrCodeDataUrl, /^data:image\/png;base64,/);
  assert.equal(created.events.length, 1);

  const confirmed = await paymentService.confirmMockPayment(created.id, {
    eventId: 'evt_confirm_1',
    amountCny: 99.5,
  }, {
    actorUser: { id: 0, role: 'admin' },
    baseUrl: 'https://pay.example.test',
  });

  assert.equal(confirmed.status, 'fulfilled');
  assert.ok(confirmed.paidAt);
  assert.ok(confirmed.fulfilledAt);
  assert.equal(confirmed.result.customerId, 'cus_pay');
  assert.equal(confirmed.result.quotaAfter.monthlyRequests, 40);
  assert.equal(confirmed.result.quotaAfter.monthlyTokens, 20);
  assert.equal(confirmed.result.quotaAfter.monthlyBudgetCny, 300);
  assert.equal(confirmed.events.length, 3);

  const customerAfter = customerRegistry.getCustomer('cus_pay');
  assert.equal(customerAfter.quota.monthlyRequests, 40);
  assert.equal(customerAfter.quota.monthlyBudgetCny, 300);

  const repeated = await paymentService.processWebhook('mock', {
    orderId: created.id,
    eventId: 'evt_confirm_1',
    status: 'paid',
    amountCny: 99.5,
  }, {
    skipSignatureVerification: true,
    baseUrl: 'https://pay.example.test',
  });

  assert.equal(repeated.status, 'fulfilled');
  assert.equal(repeated.result.quotaAfter.monthlyBudgetCny, 300);
  assert.equal(repeated.events.length, 3);

  const listing = await paymentService.listPayments({}, {
    actorUser: { id: 0, role: 'admin' },
  });
  assert.equal(listing.total, 1);
  assert.equal(listing.list[0].id, created.id);
});

test('mock webhook verifies HMAC signature when secret is configured', async (t) => {
  const { customerRegistry, paymentService } = withIsolatedHome(t, {
    AI_PAYMENT_WEBHOOK_SECRET: 'sig-secret-001',
  });

  customerRegistry.createCustomer({
    id: 'cus_sig',
    name: 'Signed Customer',
    quota: { monthlyBudgetCny: 50 },
  });

  const created = await paymentService.createPayment({
    customerId: 'cus_sig',
    amountCny: 10,
  }, {
    actorUser: { id: 0, role: 'admin' },
    baseUrl: 'https://pay.example.test',
  });

  const payload = {
    orderId: created.id,
    eventId: 'evt_sig_ok',
    status: 'paid',
    amountCny: 10,
  };
  const signature = paymentService.signMockWebhookPayload(payload, 'sig-secret-001');

  const paid = await paymentService.processWebhook('mock', payload, {
    signature: `sha256=${signature}`,
    baseUrl: 'https://pay.example.test',
  });

  assert.equal(paid.status, 'fulfilled');
  assert.equal(paid.result.quotaAfter.monthlyBudgetCny, 60);

  await assert.rejects(async () => {
    await paymentService.processWebhook('mock', {
      orderId: created.id,
      eventId: 'evt_sig_bad',
      status: 'paid',
      amountCny: 10,
    }, {
      signature: 'sha256=bad-signature',
      baseUrl: 'https://pay.example.test',
    });
  }, /invalid webhook signature/);
});
