const express = require('express');
const router = express.Router();
const { body, query, validationResult } = require('express-validator');
const { flexibleAuth } = require('../middleware/auth');
const { Signal } = require('../models');
const { sendWeChatNotification } = require('../utils/notifier');

// --------------------------------------------------------------------
// POST /api/external/signal — Submit a trading signal (JWT or API Key)
// --------------------------------------------------------------------
router.post('/signal', flexibleAuth, [
  body('symbol')
    .trim()
    .notEmpty().withMessage('symbol is required')
    .isLength({ max: 20 }).withMessage('symbol must be ≤ 20 characters'),
  body('signal')
    .trim()
    .notEmpty().withMessage('signal is required')
    .isIn(['BUY', 'SELL', 'HOLD']).withMessage('signal must be BUY, SELL, or HOLD'),
  body('price')
    .optional()
    .isDecimal().withMessage('price must be a decimal number'),
  body('confidence')
    .optional()
    .isFloat({ min: 0, max: 1 }).withMessage('confidence must be between 0 and 1'),
  body('source')
    .optional()
    .trim()
    .isLength({ max: 100 }),
  body('metadata')
    .optional()
    .isObject().withMessage('metadata must be a JSON object')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { symbol, signal, price, confidence, source, metadata } = req.body;

    const record = await Signal.create({
      userId: req.user.id,
      symbol,
      signal,
      price: price ?? null,
      confidence: confidence ?? null,
      source: source || 'external',
      metadata: metadata ?? null
    });

    // Fire-and-forget: push to WeChat if user has a SendKey bound.
    // Uses getDataValue() because toJSON() strips sendKey for security.
    const userSendKey = req.user.getDataValue
      ? req.user.getDataValue('sendKey')
      : req.user.sendKey;
    if (userSendKey) {
      sendWeChatNotification(userSendKey, record).catch(() => {});
    }

    res.status(201).json({
      success: true,
      message: 'Signal recorded',
      data: record
    });
  } catch (error) {
    console.error('Signal creation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create signal',
      error: error.message
    });
  }
});

// --------------------------------------------------------------------
// GET /api/external/signals — List the current user's signals (JWT or API Key)
// --------------------------------------------------------------------
router.get('/signals', flexibleAuth, [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('pageSize').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('symbol').optional().trim()
], async (req, res) => {
  try {
    const page = req.query.page || 1;
    const pageSize = req.query.pageSize || 20;
    const offset = (page - 1) * pageSize;

    const where = { userId: req.user.id };
    if (req.query.symbol) {
      where.symbol = req.query.symbol;
    }

    const { count, rows } = await Signal.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: pageSize,
      offset
    });

    res.json({
      success: true,
      data: {
        list: rows,
        total: count,
        page,
        pageSize
      }
    });
  } catch (error) {
    console.error('Signal list error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve signals',
      error: error.message
    });
  }
});

module.exports = router;
