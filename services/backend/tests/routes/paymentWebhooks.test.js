'use strict';

const express = require('express');
const request = require('supertest');

describe('paymentWebhooks routes', () => {
  let app;
  let mockPaymentGatewayService;

  beforeEach(() => {
    jest.resetModules();

    mockPaymentGatewayService = {
      processWebhook: jest.fn().mockResolvedValue({ id: 'pay_123', status: 'success' }),
      inferBaseUrl: jest.fn().mockReturnValue('https://example.com'),
    };

    jest.mock('../../src/services/gateway/paymentGatewayService', () => mockPaymentGatewayService);

    const router = require('../../src/routes/paymentWebhooks');
    app = express();
    app.use('/webhooks', router);
  });

  test('router is defined', () => {
    const router = require('../../src/routes/paymentWebhooks');
    expect(router).toBeDefined();
    expect(typeof router).toBe('function');
  });

  test('POST /webhooks/mock returns success on valid webhook', async () => {
    const router = require('../../src/routes/paymentWebhooks');
    const testApp = express();
    testApp.use('/webhooks', router);

    const res = await request(testApp)
      .post('/webhooks/mock')
      .send({ orderId: 'order_123', amount: 100 })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ id: 'pay_123', status: 'success' });
  });

  test('POST /webhooks/mock handles empty body', async () => {
    const router = require('../../src/routes/paymentWebhooks');
    const testApp = express();
    testApp.use('/webhooks', router);

    const res = await request(testApp).post('/webhooks/mock').send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('POST /webhooks/mock returns 400 for signature error', async () => {
    mockPaymentGatewayService.processWebhook.mockRejectedValue(new Error('Invalid signature'));

    const router = require('../../src/routes/paymentWebhooks');
    const testApp = express();
    testApp.use('/webhooks', router);

    const res = await request(testApp)
      .post('/webhooks/mock')
      .send({ orderId: 'order_123' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('POST /webhooks/mock returns 400 for amount mismatch', async () => {
    mockPaymentGatewayService.processWebhook.mockRejectedValue(new Error('Amount mismatch'));

    const router = require('../../src/routes/paymentWebhooks');
    const testApp = express();
    testApp.use('/webhooks', router);

    const res = await request(testApp)
      .post('/webhooks/mock')
      .send({ orderId: 'order_123' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('POST /webhooks/mock returns 400 for unsupported webhook status', async () => {
    mockPaymentGatewayService.processWebhook.mockRejectedValue(new Error('Unsupported webhook status'));

    const router = require('../../src/routes/paymentWebhooks');
    const testApp = express();
    testApp.use('/webhooks', router);

    const res = await request(testApp)
      .post('/webhooks/mock')
      .send({ orderId: 'order_123' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('POST /webhooks/mock returns 400 for orderId is required', async () => {
    mockPaymentGatewayService.processWebhook.mockRejectedValue(new Error('orderId is required'));

    const router = require('../../src/routes/paymentWebhooks');
    const testApp = express();
    testApp.use('/webhooks', router);

    const res = await request(testApp)
      .post('/webhooks/mock')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('POST /webhooks/mock returns 404 for not found error', async () => {
    mockPaymentGatewayService.processWebhook.mockRejectedValue(new Error('Order not found'));

    const router = require('../../src/routes/paymentWebhooks');
    const testApp = express();
    testApp.use('/webhooks', router);

    const res = await request(testApp)
      .post('/webhooks/mock')
      .send({ orderId: 'order_123' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test('POST /webhooks/mock returns 500 for generic error', async () => {
    mockPaymentGatewayService.processWebhook.mockRejectedValue(new Error('Something went wrong'));

    const router = require('../../src/routes/paymentWebhooks');
    const testApp = express();
    testApp.use('/webhooks', router);

    const res = await request(testApp)
      .post('/webhooks/mock')
      .send({ orderId: 'order_123' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });

  test('POST /webhooks/mock passes signature header', async () => {
    const router = require('../../src/routes/paymentWebhooks');
    const testApp = express();
    testApp.use('/webhooks', router);

    await request(testApp)
      .post('/webhooks/mock')
      .send({ orderId: 'order_123' })
      .set('X-KHY-Signature', 'test-signature');

    expect(mockPaymentGatewayService.processWebhook).toHaveBeenCalledWith(
      'mock',
      { orderId: 'order_123' },
      expect.objectContaining({ signature: 'test-signature' })
    );
  });

  test('POST /webhooks/mock passes lowercase signature header', async () => {
    const router = require('../../src/routes/paymentWebhooks');
    const testApp = express();
    testApp.use('/webhooks', router);

    await request(testApp)
      .post('/webhooks/mock')
      .send({ orderId: 'order_123' })
      .set('x-khy-signature', 'test-signature-lowercase');

    expect(mockPaymentGatewayService.processWebhook).toHaveBeenCalledWith(
      'mock',
      { orderId: 'order_123' },
      expect.objectContaining({ signature: 'test-signature-lowercase' })
    );
  });

  test('POST /webhooks/mock handles null body gracefully', async () => {
    const router = require('../../src/routes/paymentWebhooks');
    const testApp = express();
    testApp.use('/webhooks', router);

    const res = await request(testApp).post('/webhooks/mock');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('router has correct number of routes', () => {
    const router = require('../../src/routes/paymentWebhooks');
    const routes = router.stack.filter((layer) => layer.route);
    expect(routes.length).toBe(1);
  });
});

