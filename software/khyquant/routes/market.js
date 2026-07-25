/**
 * 市场数据路由
 * 提供标的列表、行情数据等API
 */
const express = require('express');
const router = express.Router();
const marketController = require('../controllers/marketController');
const { flexibleAuth, authMiddleware, adminMiddleware } = require('../middleware/auth');

// 获取金融标的列表（新增：与 /symbols 相同，提供别名）
router.get('/instruments', flexibleAuth, (req, res) => marketController.getSymbols(req, res));

// 获取金融标的列表
router.get('/symbols', flexibleAuth, (req, res) => marketController.getSymbols(req, res));

// 获取单个标的信息
router.get('/symbols/:symbol', flexibleAuth, (req, res) => marketController.getSymbolInfo(req, res));

// 持久化标的列表到服务器 (write operation)
router.post('/symbols/persist', authMiddleware, (req, res) => marketController.persistInstruments(req, res));

// 从持久化存储加载标的列表
router.get('/symbols/persisted/load', flexibleAuth, (req, res) => marketController.loadPersistedInstruments(req, res));

// 清除缓存 (admin only)
router.post('/cache/clear', authMiddleware, adminMiddleware, (req, res) => marketController.clearCache(req, res));

module.exports = router;
