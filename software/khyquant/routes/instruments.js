/**
 * 标的列表路由
 */
const express = require('express');
const router = express.Router();
const instrumentController = require('../controllers/instrumentController');
const { flexibleAuth, authMiddleware, adminMiddleware } = require('../middleware/auth');

// 获取统计信息 (必须在 /:symbol 之前)
router.get('/statistics', flexibleAuth, instrumentController.getStatistics.bind(instrumentController));

// 手动同步标的列表 (write operation — requires admin)
router.post('/sync', authMiddleware, adminMiddleware, instrumentController.syncInstruments.bind(instrumentController));

// 批量保存标的 (write operation — requires admin)
router.post('/batch', authMiddleware, adminMiddleware, instrumentController.batchSaveInstruments.bind(instrumentController));

// 获取标的列表
router.get('/', flexibleAuth, instrumentController.getInstruments.bind(instrumentController));

// 获取单个标的
router.get('/:symbol', flexibleAuth, instrumentController.getInstrument.bind(instrumentController));

// 更新标的信息
router.put('/:symbol', authMiddleware, adminMiddleware, instrumentController.updateInstrument.bind(instrumentController));

// 删除标的
router.delete('/:symbol', authMiddleware, adminMiddleware, instrumentController.deleteInstrument.bind(instrumentController));

module.exports = router;
