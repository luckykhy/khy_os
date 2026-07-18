'use strict';

const express = require('express');
const router = express.Router();

const paymentGatewayService = require('../services/gateway/paymentGatewayService');

router.post('/mock', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const payment = await paymentGatewayService.processWebhook('mock', req.body || {}, {
      signature: req.get('X-KHY-Signature') || req.get('x-khy-signature') || '',
      source: 'express_webhook',
      baseUrl: paymentGatewayService.inferBaseUrl(req),
    });
    res.json({ success: true, data: payment });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const status = /signature|amount mismatch|unsupported webhook status|orderId is required/i.test(message)
      ? 400
      : (/not found/i.test(message) ? 404 : 500);
    res.status(status).json({ success: false, message });
  }
});

module.exports = router;
