/**
 * 数据缓存路由
 */
const express = require('express');
const router = express.Router();
const cacheController = require('../controllers/cacheController');

// 保存单个标的数据
router.post('/save-instrument-data', cacheController.saveInstrumentData.bind(cacheController));

// 批量保存标的数据
router.post('/batch-save', cacheController.batchSaveInstruments.bind(cacheController));

// 获取缓存的K线数据
router.get('/kline-data/:symbol', cacheController.getCachedKlineData.bind(cacheController));

// 获取缓存统计信息
router.get('/stats/:symbol', cacheController.getCacheStats.bind(cacheController));

module.exports = router;
