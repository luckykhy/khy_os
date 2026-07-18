const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { Strategy, Backtest, Trade, AISuggestion, User } = require('../models');

/**
 * 获取仪表板统计数据
 * GET /api/dashboard/stats
 */
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('Dashboard stats requested for user:', userId);

    // 1. 获取策略总数
    const strategiesCount = await Strategy.count({
      where: { user_id: userId }
    }).catch(err => {
      console.error('Error counting strategies:', err);
      return 0;
    });

    // 2. 获取回测次数
    const backtestsCount = await Backtest.count({
      where: { user_id: userId }
    }).catch(err => {
      console.error('Error counting backtests:', err);
      return 0;
    });

    // 3. 获取交易记录数
    const tradesCount = await Trade.count({
      where: { user_id: userId }
    }).catch(err => {
      console.error('Error counting trades:', err);
      return 0;
    });

    // 4. 获取AI建议数
    const aiSuggestionsCount = await AISuggestion.count({
      where: { user_id: userId }
    }).catch(err => {
      console.error('Error counting AI suggestions:', err);
      return 0;
    });

    console.log('Counts:', { strategiesCount, backtestsCount, tradesCount, aiSuggestionsCount });

    // 5. 获取最近的策略（最多5条）
    const recentStrategies = await Strategy.findAll({
      where: { user_id: userId },
      order: [['updated_at', 'DESC']],
      limit: 5,
      attributes: ['id', 'name', 'status', 'language', 'updated_at']
    }).catch(err => {
      console.error('Error fetching recent strategies:', err);
      return [];
    });

    // 6. 获取最近的回测（最多5条）
    const recentBacktests = await Backtest.findAll({
      where: { user_id: userId },
      order: [['createdAt', 'DESC']],
      limit: 5,
      attributes: ['id', 'strategy_id', 'status', 'totalReturn', 'maxDrawdown', 'createdAt']
    }).catch(err => {
      console.error('Error fetching recent backtests:', err);
      return [];
    });

    console.log('Recent data fetched successfully');

    res.json({
      success: true,
      data: {
        stats: {
          strategies: strategiesCount,
          backtests: backtestsCount,
          trades: tradesCount,
          aiSuggestions: aiSuggestionsCount
        },
        trends: {
          strategies: 0,
          backtests: 0,
          trades: 0,
          aiSuggestions: 0
        },
        recentStrategies: recentStrategies.map(s => ({
          id: s.id,
          name: s.name || '未命名策略',
          type: 'custom',
          status: s.status || 'draft',
          language: s.language || 'javascript',
          updatedAt: s.updated_at
        })),
        recentBacktests: recentBacktests.map(b => ({
          id: b.id,
          name: `回测_${b.id}`,
          strategyId: b.strategy_id,
          status: b.status || 'pending',
          totalReturn: b.totalReturn || 0,
          sharpeRatio: 0,
          maxDrawdown: b.maxDrawdown || 0,
          createdAt: b.createdAt
        }))
      }
    });
  } catch (error) {
    console.error('获取仪表板统计数据失败:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: '获取统计数据失败',
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * 获取用户概览信息
 * GET /api/dashboard/overview
 */
router.get('/overview', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // 获取用户信息
    const user = await User.findByPk(userId, {
      attributes: ['id', 'username', 'email', 'role', 'createdAt']
    });

    // 获取活跃策略数
    const activeStrategies = await Strategy.count({
      where: {
        user_id: userId,
        status: 'active'
      }
    });

    // 获取成功的回测数
    const successfulBacktests = await Backtest.count({
      where: {
        user_id: userId,
        status: 'completed'
      }
    });

    // 获取最佳回测结果
    const bestBacktest = await Backtest.findOne({
      where: { user_id: userId },
      order: [['totalReturn', 'DESC']],
      attributes: ['id', 'strategy_id', 'totalReturn'],
      include: [{
        model: Strategy,
        attributes: ['name']
      }]
    });

    res.json({
      success: true,
      data: {
        user: {
          username: user.username,
          email: user.email,
          role: user.role,
          memberSince: user.createdAt
        },
        summary: {
          activeStrategies,
          successfulBacktests,
          bestBacktest: bestBacktest ? {
            strategyName: bestBacktest.Strategy?.name || '未知策略',
            totalReturn: bestBacktest.totalReturn
          } : null
        }
      }
    });
  } catch (error) {
    console.error('获取用户概览失败:', error);
    res.status(500).json({
      success: false,
      message: '获取概览信息失败',
      error: error.message
    });
  }
});

module.exports = router;


/**
 * 获取所有股票代码列表(使用AData)
 * GET /api/dashboard/all-stocks
 */
router.get('/all-stocks', async (req, res) => {
  try {
    const { getAllStockCodesWithCache } = require('../services/adataStockListService');
    
    console.log('📊 请求获取所有股票列表...');
    const result = await getAllStockCodesWithCache();
    
    if (result.success) {
      res.json({
        success: true,
        data: result.data,
        total: result.total,
        source: result.source,
        cached: result.cached || false,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error,
        message: result.message
      });
    }
  } catch (error) {
    console.error('❌ 获取股票列表失败:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: '获取股票列表失败'
    });
  }
});

/**
 * 清除股票列表缓存
 * POST /api/dashboard/clear-stocks-cache
 */
router.post('/clear-stocks-cache', authMiddleware, async (req, res) => {
  try {
    const { clearCache } = require('../services/adataStockListService');
    clearCache();
    
    res.json({
      success: true,
      message: '缓存已清除'
    });
  } catch (error) {
    console.error('清除缓存失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
