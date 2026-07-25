/**
 * 股票数据代理 REST API —— 行情数据的统一代理层
 *
 * 架构角色：属于数据治理层（对应论文第4.5节）
 *   前端需要的行情数据不直接调用外部 API，而是通过后端代理，
 *   后端统一处理缓存、降级和数据格式标准化。
 *
 * 对应论文：第5.4节（数据治理与实时协同）
 */
const express = require('express');
const router = express.Router();
const freeStockDataService = require('../services/freeStockDataService');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// ---------- 单只股票实时行情 ----------
// GET /:symbol —— 根据股票代码获取实时行情，后端自动选择可用数据源
router.get('/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    
    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: '股票代码不能为空'
      });
    }

    console.log(`获取股票数据: ${symbol}`);
    
    const data = await freeStockDataService.getStockData(symbol);
    
    res.json({
      success: true,
      data: data,
      message: '获取股票数据成功'
    });

  } catch (error) {
    console.error('获取股票数据失败:', error);
    res.status(500).json({
      success: false,
      message: '获取股票数据失败',
      error: error.message
    });
  }
});

// ---------- 批量获取股票行情 ----------
// POST / —— 接收 symbols 数组，并发请求多只股票数据后统一返回
router.post('/', async (req, res) => {
  try {
    const { symbols } = req.body;
    
    if (!symbols || !Array.isArray(symbols)) {
      return res.status(400).json({
        success: false,
        message: '股票代码列表格式错误'
      });
    }

    console.log(`批量获取股票数据: ${symbols.join(', ')}`);
    
    const results = {};
    
    // 并发获取多个股票数据
    const promises = symbols.map(async (symbol) => {
      try {
        const data = await freeStockDataService.getStockData(symbol);
        results[symbol] = data;
      } catch (error) {
        console.error(`获取${symbol}数据失败:`, error);
        results[symbol] = {
          error: error.message,
          source: '获取失败'
        };
      }
    });

    await Promise.all(promises);
    
    res.json({
      success: true,
      data: results,
      message: '批量获取股票数据完成'
    });

  } catch (error) {
    console.error('批量获取股票数据失败:', error);
    res.status(500).json({
      success: false,
      message: '批量获取股票数据失败',
      error: error.message
    });
  }
});

// ---------- 热门股票列表 ----------
// GET /hot-stocks —— 返回预置的热门股票列表及其最新行情
router.get('/hot-stocks', async (req, res) => {
  try {
    const hotStocks = [
      'sh000300', // 沪深300
      'sh000001', // 上证指数
      'sz399001', // 深证成指
      'sz399006', // 创业板指
      '600519',   // 贵州茅台
      '000858',   // 五粮液
      '600036',   // 招商银行
      '000001',   // 平安银行
      '000002',   // 万科A
      '600276'    // 恒瑞医药
    ];

    const results = {};
    
    // 获取热门股票的基本信息
    for (const symbol of hotStocks.slice(0, 5)) { // 只获取前5个，避免请求过多
      try {
        const data = await freeStockDataService.getStockData(symbol);
        results[symbol] = {
          symbol,
          name: getStockName(symbol),
          currentPrice: data.currentPrice,
          change: data.change,
          source: data.source
        };
      } catch (error) {
        console.error(`获取${symbol}数据失败:`, error);
      }
    }
    
    res.json({
      success: true,
      data: results,
      message: '获取热门股票数据成功'
    });

  } catch (error) {
    console.error('获取热门股票失败:', error);
    res.status(500).json({
      success: false,
      message: '获取热门股票失败',
      error: error.message
    });
  }
});

// ---------- 缓存管理 ----------
// DELETE /cache —— 清理过期的行情缓存，释放内存
router.delete('/cache', authMiddleware, adminMiddleware, (req, res) => {
  try {
    freeStockDataService.clearExpiredCache();
    res.json({
      success: true,
      message: '缓存清理成功'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '缓存清理失败',
      error: error.message
    });
  }
});

// ---------- AKShare 数据源管理 ----------
// GET /akshare/status —— 检查 AKShare Python 环境是否可用
router.get('/akshare/status', async (req, res) => {
  try {
    const status = await freeStockDataService.checkAKShareEnvironment();
    res.json({
      success: true,
      data: status,
      message: 'AKShare环境检查完成'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'AKShare环境检查失败',
      error: error.message
    });
  }
});

// POST /akshare/install —— 安装 AKShare Python 依赖（仅管理员可操作）
router.post('/akshare/install', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await freeStockDataService.installAKShareDependencies();
    res.json({
      success: true,
      data: result,
      message: 'AKShare依赖安装成功'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'AKShare依赖安装失败',
      error: error.message
    });
  }
});

// PUT /akshare/toggle —— 启用或禁用 AKShare 数据源（仅管理员可操作）
router.put('/akshare/toggle', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { enabled } = req.body;
    freeStockDataService.setAKShareEnabled(enabled);
    res.json({
      success: true,
      message: `AKShare已${enabled ? '启用' : '禁用'}`,
      data: { enabled }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'AKShare状态切换失败',
      error: error.message
    });
  }
});

// ---------- 数据源总览 ----------
// GET /datasources —— 获取所有数据源的可用状态，供前端数据源管理页面展示
router.get('/datasources', (req, res) => {
  try {
    const status = freeStockDataService.getDataSourceStatus();
    res.json({
      success: true,
      data: status,
      message: '数据源状态获取成功'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '数据源状态获取失败',
      error: error.message
    });
  }
});

// ---------- 辅助函数 ----------
// 根据股票代码返回中文名称（硬编码映射表，仅用于热门股票展示）
function getStockName(symbol) {
  const nameMap = {
    'sh000300': '沪深300',
    'sh000001': '上证指数',
    'sz399001': '深证成指',
    'sz399006': '创业板指',
    '600519': '贵州茅台',
    '000858': '五粮液',
    '600036': '招商银行',
    '000001': '平安银行',
    '000002': '万科A',
    '600276': '恒瑞医药'
  };
  return nameMap[symbol] || '未知股票';
}

module.exports = router;