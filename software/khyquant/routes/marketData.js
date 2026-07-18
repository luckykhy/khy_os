const express = require('express');
const router = express.Router();
const { MarketData } = require('../models');
const { authMiddleware } = require('../middleware/auth');
const marketDataService = require('../services/marketDataService');
const enhancedMockDataService = require('../services/enhancedMockDataService');

// 获取K线数据
router.get('/kline', authMiddleware, async (req, res) => {
  try {
    const { symbol, startDate, endDate, limit = 200 } = req.query;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: '请指定标的代码'
      });
    }

    // Try DB first
    let data = await marketDataService.getKLineData(symbol, startDate, endDate, limit);
    console.log('DB rows for', symbol, ':', data.length);

    if (data && data.length >= 10) {
      // Enough DB data — transform and return
      data = data.map(item => ({
        time: item.timestamp,
        date: item.timestamp,
        timestamp: item.timestamp,
        open: parseFloat(item.open_price),
        high: parseFloat(item.high_price),
        low: parseFloat(item.low_price),
        close: parseFloat(item.close_price),
        volume: parseInt(item.volume)
      }));
    } else {
      // Fallback: enhanced mock data
      console.log(`DB has insufficient data for ${symbol} (${data.length} rows), using enhanced mock`);
      const mockRows = enhancedMockDataService.generateEnhancedKLineData({
        symbol,
        period: 'daily',
        startDate: startDate || null,
        endDate: endDate || null,
        limit: Math.max(200, parseInt(limit, 10) || 200)
      });
      data = mockRows;
      console.log(`Generated ${data.length} mock candles for ${symbol}`);
    }

    // Calculate technical indicators
    const ma5 = marketDataService.calculateMA(data, 5);
    const ma10 = marketDataService.calculateMA(data, 10);
    const ma20 = marketDataService.calculateMA(data, 20);
    const ma30 = marketDataService.calculateMA(data, 30);

    res.json({
      success: true,
      data: {
        kline: data,
        indicators: {
          ma5,
          ma10,
          ma20,
          ma30
        }
      }
    });
  } catch (error) {
    console.error('Failed to get kline data:', error);
    // Never return error — generate mock data as last resort
    try {
      const mockRows = enhancedMockDataService.generateEnhancedKLineData({
        symbol: req.query.symbol,
        period: 'daily',
        limit: 500
      });
      res.json({
        success: true,
        data: { kline: mockRows, indicators: {} },
        isMock: true,
        dataSource: 'enhanced_mock'
      });
    } catch (mockError) {
      console.error('Mock data also failed:', mockError);
      res.status(500).json({
        success: false,
        message: 'Failed to get kline data',
        error: error.message
      });
    }
  }
});

// 获取实时行情
router.get('/realtime/:symbol', authMiddleware, async (req, res) => {
  try {
    const { symbol } = req.params;
    
    try {
      // 尝试获取真实行情
      const quote = await marketDataService.getRealTimeQuote(symbol);
      res.json({
        success: true,
        data: quote
      });
    } catch (error) {
      // 如果失败，返回数据库最新数据
      const latest = await MarketData.findOne({
        where: { symbol },
        order: [['timestamp', 'DESC']]
      });

      if (!latest) {
        return res.status(404).json({
          success: false,
          message: '未找到该标的的市场数据'
        });
      }

      res.json({
        success: true,
        data: latest,
        note: '模拟数据'
      });
    }
  } catch (error) {
    console.error('获取实时行情错误:', error);
    res.status(500).json({
      success: false,
      message: '获取实时行情失败',
      error: error.message
    });
  }
});

// 获取股票列表
router.get('/symbols', authMiddleware, async (req, res) => {
  try {
    const { type, limit = 100, useCache = 'true' } = req.query;
    
    console.log(`📋 获取标的列表: limit=${limit}, type=${type}`);
    
    // 使用新的market控制器
    const marketController = require('../controllers/marketController');
    return await marketController.getSymbols(req, res);
    
  } catch (error) {
    console.error('获取金融工具列表错误:', error);
    res.status(500).json({
      success: false,
      message: '获取金融工具列表失败',
      error: error.message
    });
  }
});

module.exports = router;
// 批量导入股票数据
router.post('/import', authMiddleware, async (req, res) => {
  try {
    const { days = 252, symbols = [] } = req.body;
    
    // 导入指定股票或全部股票
    let importAllStocks, importSingleStock, STOCK_LIST;
    try {
      ({ importAllStocks, importSingleStock, STOCK_LIST } = require('../../import-stock-data'));
    } catch {
      return res.status(501).json({ success: false, message: 'import-stock-data 模块不可用，请使用 CLI 的 khy data 命令导入数据' });
    }
    
    let results;
    if (symbols.length > 0) {
      // 导入指定股票
      results = { success: 0, skipped: 0, failed: 0, totalRecords: 0 };
      
      for (const symbolCode of symbols) {
        const stock = STOCK_LIST.find(s => s.code === symbolCode);
        if (stock) {
          const result = await importSingleStock(stock, days);
          if (result.success) {
            results.success++;
            results.totalRecords += result.count;
          } else if (result.skipped) {
            results.skipped++;
            results.totalRecords += result.count;
          } else {
            results.failed++;
          }
        }
      }
    } else {
      // 导入所有股票
      results = await importAllStocks(days);
    }
    
    res.json({
      success: true,
      message: '股票数据导入完成',
      data: results
    });
    
  } catch (error) {
    console.error('批量导入股票数据错误:', error);
    res.status(500).json({
      success: false,
      message: '导入失败',
      error: error.message
    });
  }
});

// 获取数据统计信息
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const { Op } = require('sequelize');
    
    // 统计各股票的数据量
    const stats = await MarketData.findAll({
      attributes: [
        'symbol',
        [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
        [sequelize.fn('MIN', sequelize.col('timestamp')), 'startDate'],
        [sequelize.fn('MAX', sequelize.col('timestamp')), 'endDate']
      ],
      group: ['symbol'],
      order: [['symbol', 'ASC']]
    });
    
    // 总统计
    const totalCount = await MarketData.count();
    const symbolCount = stats.length;
    
    res.json({
      success: true,
      data: {
        totalRecords: totalCount,
        symbolCount: symbolCount,
        symbols: stats.map(stat => ({
          symbol: stat.symbol,
          count: parseInt(stat.dataValues.count),
          startDate: stat.dataValues.startDate,
          endDate: stat.dataValues.endDate
        }))
      }
    });
    
  } catch (error) {
    console.error('获取数据统计错误:', error);
    res.status(500).json({
      success: false,
      message: '获取统计信息失败',
      error: error.message
    });
  }
});

// 清除指定股票数据
router.delete('/clear/:symbol', authMiddleware, async (req, res) => {
  try {
    const { symbol } = req.params;
    
    const deletedCount = await MarketData.destroy({
      where: { symbol }
    });
    
    res.json({
      success: true,
      message: `已清除 ${symbol} 的数据`,
      deletedCount
    });
    
  } catch (error) {
    console.error('清除股票数据错误:', error);
    res.status(500).json({
      success: false,
      message: '清除数据失败',
      error: error.message
    });
  }
});

// 清除所有数据
router.delete('/clear-all', authMiddleware, async (req, res) => {
  try {
    const deletedCount = await MarketData.destroy({
      where: {},
      truncate: true
    });
    
    res.json({
      success: true,
      message: '已清除所有股票数据',
      deletedCount
    });
    
  } catch (error) {
    console.error('清除所有数据错误:', error);
    res.status(500).json({
      success: false,
      message: '清除所有数据失败',
      error: error.message
    });
  }
});