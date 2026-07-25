'use strict';

const express = require('express');

const paymentGatewayService = require('../services/gateway/paymentGatewayService');

const router = express.Router();

function _messageOf(error, fallback = '') {
  return String(error && error.message ? error.message : error || fallback || '').trim();
}

function _statusForError(error, fallback = 500) {
  const message = _messageOf(error).toLowerCase();
  if (!message) return fallback;
  if (
    message.includes('admin access is required')
    || message.includes('forbidden')
  ) return 403;
  if (
    message.includes('required')
    || message.includes('greater than 0')
    || message.includes('unsupported payment provider')
  ) return 400;
  if (
    message.includes('amount mismatch')
    || message.includes('unsupported webhook status')
  ) return 400;
  if (message.includes('cannot be cancelled')) return 409;
  if (message.includes('not found')) return 404;
  return fallback;
}

function _baseOptions(req, extras = {}) {
  return {
    actorUser: req.user || { id: 0, role: 'admin' },
    baseUrl: paymentGatewayService.inferBaseUrl(req),
    ...extras,
  };
}

router.get('/', async (req, res) => {
  try {
    const data = await paymentGatewayService.listPayments({
      page: req.query.page,
      pageSize: req.query.pageSize,
      status: req.query.status,
      customerId: req.query.customerId,
      provider: req.query.provider,
    }, _baseOptions(req));
    res.json({ success: true, data });
  } catch (error) {
    res.status(_statusForError(error)).json({
      success: false,
      message: '获取支付订单列表失败',
      error: _messageOf(error, 'list payments failed'),
    });
  }
});

router.post('/', async (req, res) => {
  try {
    const data = await paymentGatewayService.createPayment(req.body || {}, _baseOptions(req));
    res.json({ success: true, data });
  } catch (error) {
    res.status(_statusForError(error)).json({
      success: false,
      message: '创建支付订单失败',
      error: _messageOf(error, 'create payment failed'),
    });
  }
});

router.get('/:paymentId', async (req, res) => {
  try {
    const data = await paymentGatewayService.getPayment(req.params.paymentId, _baseOptions(req, {
      includeEvents: true,
      includeCheckout: true,
    }));
    res.json({ success: true, data });
  } catch (error) {
    res.status(_statusForError(error)).json({
      success: false,
      message: '获取支付订单详情失败',
      error: _messageOf(error, 'get payment failed'),
    });
  }
});

router.post('/:paymentId/cancel', async (req, res) => {
  try {
    const data = await paymentGatewayService.cancelPayment(req.params.paymentId, req.body || {}, _baseOptions(req));
    res.json({ success: true, data });
  } catch (error) {
    res.status(_statusForError(error)).json({
      success: false,
      message: '取消支付订单失败',
      error: _messageOf(error, 'cancel payment failed'),
    });
  }
});

router.post('/:paymentId/mock/confirm', async (req, res) => {
  try {
    const data = await paymentGatewayService.confirmMockPayment(req.params.paymentId, req.body || {}, _baseOptions(req));
    res.json({ success: true, data });
  } catch (error) {
    res.status(_statusForError(error)).json({
      success: false,
      message: '确认模拟支付失败',
      error: _messageOf(error, 'mock confirm failed'),
    });
  }
});

module.exports = router;
