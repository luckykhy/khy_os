const express = require('express');
const router = express.Router();
const { Watchlist, MarketData } = require('../models');
const { sequelize } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const { Op } = require('sequelize');

// 获取用户自选股列表
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, sector, search, type, category } = req.query;
    const offset = (page - 1) * limit;
    
    const where = { userId: req.user.id };
    
    // 按行业筛选
    if (sector) {
      where.sector = sector;
    }
    
    // 按工具类型筛选
    if (type && type !== 'all') {
      where.instrumentType = type;
    }
    
    // 按分类筛选
    if (category && category !== 'all') {
      where.category = category;
    }
    
    // 搜索功能
    if (search) {
      where[Op.or] = [
        { symbol: { [Op.iLike]: `%${search}%` } },
        { symbolName: { [Op.iLike]: `%${search}%` } }
      ];
    }
    
    const { count, rows } = await Watchlist.findAndCountAll({
      where,
      limit: parseInt(limit),
      offset,
      order: [['added_at', 'DESC']]
    });
    
    // 获取最新价格信息
    const watchlistWithPrices = await Promise.all(
      rows.map(async (item) => {
        let latestData = null;
        let latestPrice = null;
        let latestChange = null;
        let latestVolume = null;
        let lastUpdate = null;
        
        // 只有股票类型才从数据库获取价格数据
        if (item.instrumentType === 'stock') {
          latestData = await MarketData.findOne({
            where: { symbol: item.symbol },
            order: [['timestamp', 'DESC']]
          });
          
          if (latestData) {
            latestPrice = latestData.close_price;
            latestChange = ((latestData.close_price - latestData.open_price) / latestData.open_price * 100).toFixed(2);
            latestVolume = latestData.volume;
            lastUpdate = latestData.timestamp;
          }
        } else {
          // 对于指数和期货，使用基准价格或模拟数据
          latestPrice = item.basePrice || null;
          latestChange = (Math.random() * 4 - 2).toFixed(2); // 模拟涨跌幅 -2% 到 +2%
          lastUpdate = new Date();
        }
        
        return {
          ...item.toJSON(),
          latestPrice,
          latestChange,
          latestVolume,
          lastUpdate
        };
      })
    );
    
    res.json({
      success: true,
      data: {
        list: watchlistWithPrices,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          pages: Math.ceil(count / limit)
        }
      }
    });
    
  } catch (error) {
    console.error('获取自选列表错误:', error);
    res.status(500).json({
      success: false,
      message: '获取自选列表失败',
      error: error.message
    });
  }
});

// 添加股票到自选股
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { symbol, symbolName, sector, market, notes, alertPrice, alertEnabled, type, category } = req.body;
    
    if (!symbol || !symbolName) {
      return res.status(400).json({
        success: false,
        message: '代码和名称不能为空'
      });
    }
    
    // 检查是否已存在
    const existing = await Watchlist.findOne({
      where: {
        userId: req.user.id,
        symbol: symbol
      }
    });
    
    if (existing) {
      return res.status(400).json({
        success: false,
        message: '该工具已在自选中'
      });
    }
    
    const watchlistItem = await Watchlist.create({
      userId: req.user.id,
      symbol,
      symbolName,
      sector,
      market,
      notes,
      alertPrice,
      alertEnabled: alertEnabled || false,
      instrumentType: type || 'stock',  // 新增字段：工具类型
      category: category || '股票'       // 新增字段：工具分类
    });
    
    res.status(201).json({
      success: true,
      message: '添加自选成功',
      data: watchlistItem
    });
    
  } catch (error) {
    console.error('添加自选错误:', error);
    res.status(500).json({
      success: false,
      message: '添加自选失败',
      error: error.message
    });
  }
});

// 更新自选股信息
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes, alertPrice, alertEnabled } = req.body;
    
    const watchlistItem = await Watchlist.findOne({
      where: {
        id,
        userId: req.user.id
      }
    });
    
    if (!watchlistItem) {
      return res.status(404).json({
        success: false,
        message: '自选股不存在'
      });
    }
    
    await watchlistItem.update({
      notes,
      alertPrice,
      alertEnabled
    });
    
    res.json({
      success: true,
      message: '更新自选股成功',
      data: watchlistItem
    });
    
  } catch (error) {
    console.error('更新自选股错误:', error);
    res.status(500).json({
      success: false,
      message: '更新自选股失败',
      error: error.message
    });
  }
});

// 删除自选股
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    const deleted = await Watchlist.destroy({
      where: {
        id,
        userId: req.user.id
      }
    });
    
    if (deleted === 0) {
      return res.status(404).json({
        success: false,
        message: '自选股不存在'
      });
    }
    
    res.json({
      success: true,
      message: '删除自选股成功'
    });
    
  } catch (error) {
    console.error('删除自选股错误:', error);
    res.status(500).json({
      success: false,
      message: '删除自选股失败',
      error: error.message
    });
  }
});

// 批量添加自选股
router.post('/batch', authMiddleware, async (req, res) => {
  try {
    const { instruments } = req.body;
    
    if (!Array.isArray(instruments) || instruments.length === 0) {
      return res.status(400).json({
        success: false,
        message: '请提供有效的工具列表'
      });
    }
    
    const results = {
      success: 0,
      skipped: 0,
      failed: 0
    };
    
    for (const instrumentData of instruments) {
      try {
        // 检查是否已存在
        const existing = await Watchlist.findOne({
          where: {
            userId: req.user.id,
            symbol: instrumentData.code || instrumentData.symbol
          }
        });
        
        if (existing) {
          results.skipped++;
          continue;
        }
        
        await Watchlist.create({
          userId: req.user.id,
          symbol: instrumentData.code || instrumentData.symbol,
          symbolName: instrumentData.name,
          sector: instrumentData.sector,
          market: instrumentData.market,
          instrumentType: instrumentData.type || 'stock',
          category: instrumentData.category || '股票',
          basePrice: instrumentData.basePrice
        });
        
        results.success++;
        
      } catch (error) {
        console.error(`添加 ${instrumentData.code || instrumentData.symbol} 失败:`, error);
        results.failed++;
      }
    }
    
    res.json({
      success: true,
      message: '批量添加完成',
      data: results
    });
    
  } catch (error) {
    console.error('批量添加自选错误:', error);
    res.status(500).json({
      success: false,
      message: '批量添加失败',
      error: error.message
    });
  }
});

// 获取可选股票列表（用于添加自选股）
router.get('/available', authMiddleware, async (req, res) => {
  try {
    const { type, sector, market, search, page = 1, limit = 50 } = req.query;
    
    // 导入全面的金融工具数据
    const {
      getAllInstruments,
      getInstrumentsByType,
      getAllSectors,
      getAllMarkets
    } = require('../../scripts/comprehensive-instruments');
    
    let availableInstruments = getAllInstruments();
    
    // 按类型筛选
    if (type && type !== 'all') {
      availableInstruments = getInstrumentsByType(type);
    }
    
    // 按行业筛选
    if (sector) {
      availableInstruments = availableInstruments.filter(item => item.sector === sector);
    }
    
    // 按市场筛选
    if (market) {
      availableInstruments = availableInstruments.filter(item => item.market === market);
    }
    
    // 搜索功能
    if (search) {
      const searchLower = search.toLowerCase();
      availableInstruments = availableInstruments.filter(item => 
        item.code.toLowerCase().includes(searchLower) ||
        item.name.toLowerCase().includes(searchLower) ||
        item.sector.toLowerCase().includes(searchLower)
      );
    }
    
    // 获取用户已添加的工具
    const userWatchlist = await Watchlist.findAll({
      where: { userId: req.user.id },
      attributes: ['symbol']
    });
    
    const userSymbols = new Set(userWatchlist.map(item => item.symbol));
    
    // 标记已添加的工具
    const instrumentsWithStatus = availableInstruments.map(item => ({
      ...item,
      isInWatchlist: userSymbols.has(item.code)
    }));
    
    // 分页
    const total = instrumentsWithStatus.length;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const paginatedInstruments = instrumentsWithStatus.slice(startIndex, endIndex);
    
    // 获取统计信息
    const stats = {
      total,
      stocks: getAllInstruments().filter(item => item.type === 'stock').length,
      indices: getAllInstruments().filter(item => item.type === 'index').length,
      futures: getAllInstruments().filter(item => item.type === 'futures').length,
      sectors: getAllSectors(),
      markets: getAllMarkets()
    };
    
    res.json({
      success: true,
      data: {
        instruments: paginatedInstruments,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        },
        stats
      }
    });
    
  } catch (error) {
    console.error('获取可选金融工具列表错误:', error);
    res.status(500).json({
      success: false,
      message: '获取可选金融工具列表失败',
      error: error.message
    });
  }
});

// 获取自选股统计信息
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const totalCount = await Watchlist.count({
      where: { userId: req.user.id }
    });
    
    // 简化的行业统计
    const allWatchlist = await Watchlist.findAll({
      where: { userId: req.user.id },
      attributes: ['sector']
    });
    
    const sectorStats = {};
    allWatchlist.forEach(item => {
      const sector = item.sector || '未分类';
      sectorStats[sector] = (sectorStats[sector] || 0) + 1;
    });
    
    const sectorStatsArray = Object.entries(sectorStats)
      .map(([sector, count]) => ({ sector, count }))
      .sort((a, b) => b.count - a.count);
    
    const alertCount = await Watchlist.count({
      where: {
        userId: req.user.id,
        alertEnabled: true
      }
    });
    
    res.json({
      success: true,
      data: {
        totalCount,
        alertCount,
        sectorStats: sectorStatsArray
      }
    });
    
  } catch (error) {
    console.error('获取自选股统计错误:', error);
    res.status(500).json({
      success: false,
      message: '获取统计信息失败',
      error: error.message
    });
  }
});

module.exports = router;