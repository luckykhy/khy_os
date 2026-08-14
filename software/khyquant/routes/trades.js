/**
 * 交易记录路由
 */
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { Trade, Strategy } = require('../models');

/**
 * 创建交易记录
 * POST /api/trades
 */
router.post('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      symbol,
      side,
      quantity,
      price,
      strategy_id,
      type = 'paper' // 默认为模拟交易
    } = req.body;

    // 验证必填字段
    if (!symbol || !side || !quantity || !price) {
      return res.status(400).json({
        success: false,
        message: '缺少必填字段'
      });
    }

    // 计算交易金额
    const amount = parseFloat(quantity) * parseFloat(price);

    // 创建交易记录
    const trade = await Trade.create({
      user_id: userId,
      strategy_id: strategy_id || null,
      symbol,
      side,
      quantity: parseFloat(quantity),
      price: parseFloat(price),
      amount,
      status: 'filled', // 模拟交易直接标记为已成交
      type,
      filledAt: new Date()
    });

    console.log('✅ 交易记录已创建:', {
      id: trade.id,
      symbol,
      side,
      quantity,
      price,
      amount
    });

    res.json({
      success: true,
      data: trade,
      message: '交易记录创建成功'
    });

  } catch (error) {
    console.error('❌ 创建交易记录失败:', error);
    res.status(500).json({
      success: false,
      message: '创建交易记录失败',
      error: error.message
    });
  }
});

/**
 * 获取交易记录列表
 * GET /api/trades
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      page = 1,
      pageSize = 20,
      symbol,
      side,
      type,
      strategy_id
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(pageSize);

    // 构建查询条件
    const where = { user_id: userId };
    if (symbol) where.symbol = symbol;
    if (side) where.side = side;
    if (type) where.type = type;
    if (strategy_id) where.strategy_id = strategy_id;

    // 查询交易记录
    const { count, rows: trades } = await Trade.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: parseInt(pageSize),
      offset,
      include: [{
        model: Strategy,
        as: 'strategy',
        attributes: ['id', 'name', 'type'],
        required: false
      }]
    });

    res.json({
      success: true,
      data: {
        trades,
        pagination: {
          total: count,
          page: parseInt(page),
          pageSize: parseInt(pageSize),
          totalPages: Math.ceil(count / parseInt(pageSize))
        }
      }
    });

  } catch (error) {
    console.error('❌ 获取交易记录失败:', error);
    res.status(500).json({
      success: false,
      message: '获取交易记录失败',
      error: error.message
    });
  }
});

/**
 * 获取单个交易记录
 * GET /api/trades/:id
 */
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const trade = await Trade.findOne({
      where: {
        id,
        user_id: userId
      },
      include: [{
        model: Strategy,
        as: 'strategy',
        attributes: ['id', 'name', 'type', 'description'],
        required: false
      }]
    });

    if (!trade) {
      return res.status(404).json({
        success: false,
        message: '交易记录不存在'
      });
    }

    res.json({
      success: true,
      data: trade
    });

  } catch (error) {
    console.error('❌ 获取交易记录失败:', error);
    res.status(500).json({
      success: false,
      message: '获取交易记录失败',
      error: error.message
    });
  }
});

/**
 * 平仓操作
 * POST /api/trades/:id/close
 */
router.post('/:id/close', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { closeType, quantity } = req.body;

    // 查找交易记录
    const trade = await Trade.findOne({
      where: {
        id,
        user_id: userId
      }
    });

    if (!trade) {
      return res.status(404).json({
        success: false,
        message: '交易记录不存在'
      });
    }

    // 检查交易状态
    if (trade.status !== 'filled') {
      return res.status(400).json({
        success: false,
        message: '只能平仓已成交的订单'
      });
    }

    if (trade.isClosed) {
      return res.status(400).json({
        success: false,
        message: '该交易已平仓'
      });
    }

    // 验证平仓数量
    const closeQuantity = parseInt(quantity);
    if (closeQuantity <= 0 || closeQuantity > trade.quantity) {
      return res.status(400).json({
        success: false,
        message: '平仓数量无效'
      });
    }

    // 全仓平仓
    if (closeType === 'full' || closeQuantity === trade.quantity) {
      await trade.update({
        isClosed: true,
        closedAt: new Date(),
        closedQuantity: trade.quantity
      });

      console.log('✅ 全仓平仓成功:', {
        id: trade.id,
        symbol: trade.symbol,
        quantity: trade.quantity
      });

      return res.json({
        success: true,
        message: '全仓平仓成功',
        data: {
          tradeId: trade.id,
          closeType: 'full',
          closedQuantity: trade.quantity
        }
      });
    }

    // 部分平仓
    if (closeType === 'partial') {
      // 更新原交易记录的数量
      const remainingQuantity = trade.quantity - closeQuantity;
      await trade.update({
        quantity: remainingQuantity,
        amount: remainingQuantity * trade.price
      });

      // 创建平仓记录
      await Trade.create({
        user_id: userId,
        strategy_id: trade.strategy_id,
        symbol: trade.symbol,
        side: trade.side === 'buy' ? 'sell' : 'buy', // 反向操作
        quantity: closeQuantity,
        price: trade.price,
        amount: closeQuantity * trade.price,
        status: 'filled',
        type: trade.type,
        isClosed: true,
        closedAt: new Date(),
        filledAt: new Date(),
        relatedTradeId: trade.id // 关联原交易
      });

      console.log('✅ 部分平仓成功:', {
        id: trade.id,
        symbol: trade.symbol,
        closedQuantity: closeQuantity,
        remainingQuantity
      });

      return res.json({
        success: true,
        message: '部分平仓成功',
        data: {
          tradeId: trade.id,
          closeType: 'partial',
          closedQuantity: closeQuantity,
          remainingQuantity
        }
      });
    }

    res.status(400).json({
      success: false,
      message: '无效的平仓类型'
    });

  } catch (error) {
    console.error('❌ 平仓失败:', error);
    res.status(500).json({
      success: false,
      message: '平仓失败',
      error: error.message
    });
  }
});

/**
 * 删除交易记录
 * DELETE /api/trades/:id
 */
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const trade = await Trade.findOne({
      where: {
        id,
        user_id: userId
      }
    });

    if (!trade) {
      return res.status(404).json({
        success: false,
        message: '交易记录不存在'
      });
    }

    await trade.destroy();

    res.json({
      success: true,
      message: '交易记录已删除'
    });

  } catch (error) {
    console.error('❌ 删除交易记录失败:', error);
    res.status(500).json({
      success: false,
      message: '删除交易记录失败',
      error: error.message
    });
  }
});

/**
 * 获取交易统计
 * GET /api/trades/stats/summary
 */
router.get('/stats/summary', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { symbol, startDate, endDate } = req.query;

    // 构建查询条件
    const where = { user_id: userId, status: 'filled' };
    if (symbol) where.symbol = symbol;
    if (startDate || endDate) {
      where.filledAt = {};
      if (startDate) where.filledAt[Op.gte] = new Date(startDate);
      if (endDate) where.filledAt[Op.lte] = new Date(endDate);
    }

    // 获取所有交易记录
    const trades = await Trade.findAll({
      where,
      order: [['filledAt', 'ASC']]
    });

    // 计算统计数据
    const totalTrades = trades.length;
    const buyTrades = trades.filter(t => t.side === 'buy');
    const sellTrades = trades.filter(t => t.side === 'sell');
    
    const totalBuyAmount = buyTrades.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const totalSellAmount = sellTrades.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    
    const totalProfit = totalSellAmount - totalBuyAmount;
    const profitRate = totalBuyAmount > 0 ? (totalProfit / totalBuyAmount) * 100 : 0;

    res.json({
      success: true,
      data: {
        totalTrades,
        buyTrades: buyTrades.length,
        sellTrades: sellTrades.length,
        totalBuyAmount: totalBuyAmount.toFixed(2),
        totalSellAmount: totalSellAmount.toFixed(2),
        totalProfit: totalProfit.toFixed(2),
        profitRate: profitRate.toFixed(2)
      }
    });

  } catch (error) {
    console.error('❌ 获取交易统计失败:', error);
    res.status(500).json({
      success: false,
      message: '获取交易统计失败',
      error: error.message
    });
  }
});

module.exports = router;
