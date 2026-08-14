/**
 * 综合数据 REST API —— 多源行情数据的统一查询入口
 *
 * 架构角色：属于数据治理层（对应论文第4.5节，表15 四级回退）
 *   整合 AKShare、TuShare、efinance 等多个数据源，
 *   按 Redis缓存→PostgreSQL→外部API→模拟数据 四级回退提供数据。
 *
 * 对应论文：第5.4节（数据治理与实时协同），图5 /api/market 分支
 */
const express = require('express');
const router = express.Router();
const comprehensiveDataController = require('../controllers/comprehensiveDataController');
const { authMiddleware, adminMiddleware, flexibleAuth } = require('../middleware/auth');

// ==================== 行情数据查询 ====================

// GET /kline —— 获取K线（蜡烛图）数据，支持日/周/月等多周期
router.get('/kline', flexibleAuth, comprehensiveDataController.getKlineData);

// GET /data/:symbol —— 获取指定标的的综合金融数据（四级回退策略）
router.get('/data/:symbol', flexibleAuth, comprehensiveDataController.getComprehensiveData);

// GET /range/:symbol —— 获取指定标的的可用数据时间范围
router.get('/range/:symbol', flexibleAuth, comprehensiveDataController.getDataRange);

// POST /batch —— 批量获取多个标的的行情数据
router.post('/batch', flexibleAuth, comprehensiveDataController.getBatchData);

// ==================== 金融标的与市场信息 ====================

// GET /instruments —— 获取系统支持的所有金融标的列表
router.get('/instruments', flexibleAuth, comprehensiveDataController.getSupportedInstruments);

// GET /instruments/search —— 按关键词搜索金融标的（模糊匹配代码和名称）
router.get('/instruments/search', flexibleAuth, comprehensiveDataController.searchInstruments);

// GET /markets/:marketCode? —— 获取市场信息（沪深/港股/美股等），marketCode 可选
router.get('/markets/:marketCode?', flexibleAuth, comprehensiveDataController.getMarketInfo);

// ==================== 数据源管理 ====================

// GET /sources/status —— 获取所有数据源的当前可用状态
router.get('/sources/status', flexibleAuth, comprehensiveDataController.getDataSourceStatus);

// POST /sources/test —— 测试单个数据源的连通性
router.post('/sources/test', authMiddleware, adminMiddleware, comprehensiveDataController.testDataSource);

// POST /sources/test-all —— 批量测试所有数据源
router.post('/sources/test-all', authMiddleware, adminMiddleware, comprehensiveDataController.testAllDataSources);

// GET /test-source/:sourceId —— 测试单个数据源（GET方式，供前端数据源管理页面调用）
router.get('/test-source/:sourceId', authMiddleware, adminMiddleware, comprehensiveDataController.testSingleSource);

// GET /sources/config —— 获取数据源配置信息
router.get('/sources/config', authMiddleware, adminMiddleware, comprehensiveDataController.getDataSourceConfig);

// POST /sources/config —— 更新数据源配置（启用/禁用），仅管理员可操作
router.post('/sources/config', authMiddleware, adminMiddleware, comprehensiveDataController.updateDataSourceConfig);

// GET /sources/enabled —— 获取当前已启用的数据源列表
router.get('/sources/enabled', flexibleAuth, comprehensiveDataController.getEnabledDataSources);

// POST /sources/switch —— 手动切换首选数据源，仅管理员可操作
router.post('/sources/switch', authMiddleware, adminMiddleware, comprehensiveDataController.switchDataSource);

// ==================== 缓存管理 ====================

// POST /cache/clear —— 清理行情数据缓存，仅管理员可操作
router.post('/cache/clear', authMiddleware, adminMiddleware, comprehensiveDataController.clearCache);

module.exports = router;
