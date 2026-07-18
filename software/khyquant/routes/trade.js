const express = require('express');
const router = express.Router();
const { Trade, Strategy, User } = require('../models');
const { authMiddleware } = require('../middleware/auth');
const { Op } = require('sequelize');

// Shared trade validation helpers
function isFuturesSymbol(symbol) {
  const cleanSym = symbol ? symbol.replace(/^(sh|sz)/i, '') : '';
  return /^[A-Z]{1,2}\d{3,4}$/i.test(cleanSym) || /_main$/i.test(cleanSym);
}

function validateStockLotSize(quantity, isFutures) {
  if (isFutures) return null;
  const qty = parseInt(quantity);
  if (!qty || qty <= 0) {
    return '交易数量必须为正整数';
  }
  if (qty % 100 !== 0) {
    return '股票交易数量必须为100的整数倍（1手=100股）';
  }
  return null;
}

const { getReferencePrice, STATIC_FALLBACK } = require('../config/referencePrices');

/**
 * Determine price limit ratio based on stock board.
 * ST/\*ST: ±5%, STAR board (688xxx): ±20%, BSE (8xxxxx/4xxxxx): ±30%, default: ±10%
 */
function getPriceLimitRatio(symbol) {
  const clean = symbol ? symbol.replace(/^(sh|sz|bj)/i, '') : '';
  // ST stocks would need name lookup; here we use board-based heuristics
  if (/^688\d{3}$/.test(clean)) return 0.20;  // STAR board (科创板)
  if (/^[84]\d{5}$/.test(clean)) return 0.30;  // BSE (北交所)
  return 0.10;  // Main board default
}

async function validatePriceLimit(orderType, price, symbol, isFutures) {
  if (orderType !== 'limit' || !price || isFutures) return null;
  const refPrice = await getReferencePrice(symbol);
  if (!refPrice || refPrice <= 0) return null;
  const ratio = getPriceLimitRatio(symbol);
  const upperLimit = refPrice * (1 + ratio);
  const lowerLimit = refPrice * (1 - ratio);
  const p = parseFloat(price);
  if (p > upperLimit || p < lowerLimit) {
    return {
      message: `委托价格超出涨跌停限制 (¥${lowerLimit.toFixed(2)} - ¥${upperLimit.toFixed(2)}, ±${(ratio * 100).toFixed(0)}%)`,
      data: { lowerLimit, upperLimit, referencePrice: refPrice, limitRatio: ratio }
    };
  }
  return null;
}

// 获取账户信息
router.get('/account', authMiddleware, async (req, res) => {
  try {
    // 计算用户的交易统计
    const trades = await Trade.findAll({
      where: { 
        user_id: req.user.id,
        status: 'filled'
      }
    });

    let totalProfit = 0;
    let todayProfit = 0;
    let positionValue = 0; // 当前持仓市值
    let positionCost = 0;  // 当前持仓成本
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    trades.forEach(trade => {
      // 计算实际盈亏
      if (trade.isClosed && trade.profit) {
        // 已平仓的交易，使用实际盈亏
        totalProfit += parseFloat(trade.profit);
        
        if (trade.closedAt && new Date(trade.closedAt) >= today) {
          todayProfit += parseFloat(trade.profit);
        }
      } else if (!trade.isClosed && trade.side === 'buy') {
        // 未平仓的买入持仓
        positionCost += parseFloat(trade.amount);
        positionValue += parseFloat(trade.amount); // 暂时用成本价，实际应该用当前市价
      }
    });

    // 计算账户信息
    const initialFunds = 1000000.00; // 初始资金100万
    // 可用资金 = 初始资金 + 已平仓盈亏 - 当前持仓占用资金
    const availableFunds = initialFunds + totalProfit - positionCost;
    const totalAssets = availableFunds + positionValue;

    const accountInfo = {
      availableFunds: availableFunds,
      totalAssets: totalAssets,
      frozenFunds: 0,
      totalProfit: totalProfit,
      todayProfit: todayProfit,
      positionValue: positionValue,
      tradeCount: trades.length,
      winRate: trades.length > 0 ? (trades.filter(t => t.side === 'sell').length / trades.length * 100).toFixed(2) : 0
    };

    res.json({
      success: true,
      data: accountInfo
    });
  } catch (error) {
    console.error('获取账户信息错误:', error);
    console.error('错误堆栈:', error.stack);
    res.status(500).json({
      success: false,
      message: '获取账户信息失败',
      error: error.message
    });
  }
});

// 获取持仓信息
router.get('/positions', authMiddleware, async (req, res) => {
  try {
    // Demo positions with realistic 2026 prices
    const demoPositions = [
      {
        symbol: 'sh600000',
        symbolName: '浦发银行',
        totalQuantity: 3200,
        avgCost: 7.50,
        currentPrice: 7.80,
        marketValue: 24960.00,
        totalCost: 24000.00,
        unrealizedProfit: 960.00,
        unrealizedProfitPercent: 4.00,
        todayProfit: 128.00,
        availableQuantity: 3200,
        isDemo: true
      },
      {
        symbol: 'sh600519',
        symbolName: '贵州茅台',
        totalQuantity: 100,
        avgCost: 1650.00,
        currentPrice: 1680.00,
        marketValue: 168000.00,
        totalCost: 165000.00,
        unrealizedProfit: 3000.00,
        unrealizedProfitPercent: 1.82,
        todayProfit: 500.00,
        availableQuantity: 100,
        isDemo: true
      },
      {
        symbol: 'sz002601',
        symbolName: '龙佰集团',
        totalQuantity: 2000,
        avgCost: 16.80,
        currentPrice: 17.20,
        marketValue: 34400.00,
        totalCost: 33600.00,
        unrealizedProfit: 800.00,
        unrealizedProfitPercent: 2.38,
        todayProfit: -100.00,
        availableQuantity: 2000,
        isDemo: true
      }
    ];

    // 🔥 获取用户的真实持仓
    const buyTrades = await Trade.findAll({
      where: { 
        user_id: req.user.id,
        side: 'buy',
        status: 'filled',
        isClosed: false // 只获取未平仓的
      },
      order: [['createdAt', 'ASC']]
    });

    const sellTrades = await Trade.findAll({
      where: { 
        user_id: req.user.id,
        side: 'sell',
        status: 'filled'
      },
      order: [['createdAt', 'ASC']]
    });

    // 计算每个股票的持仓
    const positions = {};
    
    buyTrades.forEach(trade => {
      if (!positions[trade.symbol]) {
        positions[trade.symbol] = {
          symbol: trade.symbol,
          symbolName: getSymbolName(trade.symbol),
          totalQuantity: 0,
          totalCost: 0,
          avgCost: 0,
          isDemo: false // 标记为真实数据
        };
      }
      positions[trade.symbol].totalQuantity += parseFloat(trade.quantity);
      positions[trade.symbol].totalCost += parseFloat(trade.amount);
    });

    sellTrades.forEach(trade => {
      if (positions[trade.symbol]) {
        positions[trade.symbol].totalQuantity -= parseFloat(trade.quantity);
        // 按平均成本计算卖出后的成本
        if (positions[trade.symbol].totalQuantity > 0) {
          const avgCost = positions[trade.symbol].totalCost / (positions[trade.symbol].totalQuantity + parseFloat(trade.quantity));
          positions[trade.symbol].totalCost -= parseFloat(trade.quantity) * avgCost;
        } else {
          positions[trade.symbol].totalCost = 0;
        }
      }
    });

    // 计算平均成本和当前市值
    const realPositions = Object.values(positions)
      .filter(pos => pos.totalQuantity > 0)
      .map(pos => {
        pos.avgCost = pos.totalQuantity > 0 ? pos.totalCost / pos.totalQuantity : 0;
        pos.currentPrice = pos.avgCost * (1 + (Math.random() - 0.5) * 0.1); // 模拟当前价格
        pos.marketValue = pos.totalQuantity * pos.currentPrice;
        pos.unrealizedProfit = pos.marketValue - pos.totalCost;
        pos.unrealizedProfitPercent = pos.totalCost > 0 ? (pos.unrealizedProfit / pos.totalCost * 100) : 0;
        pos.todayProfit = pos.marketValue * (Math.random() - 0.5) * 0.02; // 模拟今日盈亏
        pos.availableQuantity = pos.totalQuantity;
        
        return pos;
      });

    // 🔥 合并演示持仓和真实持仓
    const allPositions = [...demoPositions, ...realPositions];

    console.log(`✅ 返回持仓: ${demoPositions.length}个演示 + ${realPositions.length}个真实 = ${allPositions.length}个总计`);

    res.json({
      success: true,
      data: allPositions,
      meta: {
        demoCount: demoPositions.length,
        realCount: realPositions.length,
        totalCount: allPositions.length
      }
    });
  } catch (error) {
    console.error('获取持仓信息错误:', error);
    res.status(500).json({
      success: false,
      message: '获取持仓信息失败',
      error: error.message
    });
  }
});

// 获取交易统计
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    
    let startDate = new Date();
    switch (period) {
      case '7d':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(startDate.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(startDate.getDate() - 90);
        break;
      case '1y':
        startDate.setFullYear(startDate.getFullYear() - 1);
        break;
      default:
        startDate.setDate(startDate.getDate() - 30);
    }

    const trades = await Trade.findAll({
      where: {
        user_id: req.user.id,
        status: 'filled',
        createdAt: {
          [Op.gte]: startDate
        }
      },
      order: [['createdAt', 'ASC']]
    });

    // 计算统计数据
    const totalTrades = trades.length;
    const buyTrades = trades.filter(t => t.side === 'buy').length;
    const sellTrades = trades.filter(t => t.side === 'sell').length;
    const totalVolume = trades.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    
    // 按日期分组统计
    const dailyStats = {};
    trades.forEach(trade => {
      const date = new Date(trade.createdAt).toISOString().split('T')[0];
      if (!dailyStats[date]) {
        dailyStats[date] = {
          date,
          tradeCount: 0,
          volume: 0,
          profit: 0
        };
      }
      dailyStats[date].tradeCount++;
      dailyStats[date].volume += parseFloat(trade.amount);
      dailyStats[date].profit += trade.side === 'sell' ? parseFloat(trade.amount) * 0.01 : -parseFloat(trade.amount) * 0.005;
    });

    const stats = {
      totalTrades,
      buyTrades,
      sellTrades,
      totalVolume,
      avgTradeSize: totalTrades > 0 ? totalVolume / totalTrades : 0,
      winRate: sellTrades > 0 ? (sellTrades / totalTrades * 100) : 0,
      dailyStats: Object.values(dailyStats).sort((a, b) => new Date(a.date) - new Date(b.date))
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('获取交易统计错误:', error);
    res.status(500).json({
      success: false,
      message: '获取交易统计失败',
      error: error.message
    });
  }
});

// 提交交易订单
router.post('/order', authMiddleware, async (req, res) => {
  try {
    const { 
      symbol, 
      symbolName, 
      orderType, 
      direction, 
      quantity, 
      price,
      triggerPrice,
      conditionType,
      validPeriod
    } = req.body;

    if (!symbol || !direction || !quantity) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数'
      });
    }

    if (!['buy', 'sell'].includes(direction)) {
      return res.status(400).json({
        success: false,
        message: '交易方向必须是buy或sell'
      });
    }

    // Stock trading compliance: quantity must be multiples of 100
    const isFuturesOrder = isFuturesSymbol(symbol);
    const lotError = validateStockLotSize(quantity, isFuturesOrder);
    if (lotError) {
      return res.status(400).json({ success: false, message: lotError });
    }

    // Stock price limit validation: ±10% (涨跌停限制) — uses server-side reference prices
    const priceLimitError = await validatePriceLimit(orderType, price, symbol, isFuturesOrder);
    if (priceLimitError) {
      return res.status(400).json({ success: false, ...priceLimitError });
    }

    // 🔥 买入时验证可用资金
    if (direction === 'buy') {
      // 获取当前账户信息
      const trades = await Trade.findAll({
        where: {
          user_id: req.user.id,
          status: 'filled'
        }
      });

      let totalProfit = 0;
      let positionCost = 0;

      trades.forEach(trade => {
        if (trade.isClosed && trade.profit) {
          totalProfit += parseFloat(trade.profit);
        } else if (!trade.isClosed && trade.side === 'buy') {
          positionCost += parseFloat(trade.amount);
        }
      });

      const initialFunds = 1000000.00;
      const availableFunds = initialFunds + totalProfit - positionCost;

      // 计算本次交易所需资金
      const cleanSym = symbol ? symbol.replace(/^(sh|sz)/i, '') : '';
      const fbPrice = STATIC_FALLBACK[symbol] || STATIC_FALLBACK[cleanSym] || 50;
      const finalPrice = price || (fbPrice + (Math.random() - 0.5) * (fbPrice * 0.02));
      const requiredAmount = parseFloat(quantity) * parseFloat(finalPrice);

      // 🔥 验证资金是否足够
      if (availableFunds < requiredAmount) {
        return res.status(400).json({
          success: false,
          message: `资金不足！可用资金: ¥${availableFunds.toFixed(2)}, 所需资金: ¥${requiredAmount.toFixed(2)}`,
          data: {
            availableFunds: availableFunds,
            requiredAmount: requiredAmount,
            shortage: requiredAmount - availableFunds
          }
        });
      }

    }

    // 模拟订单处理
    const orderId = Date.now().toString();
    const finalPrice = price || 10; // fallback for market orders without explicit price
    const amount = parseFloat(quantity) * parseFloat(finalPrice);

    // 创建交易记录
    const trade = await Trade.create({
      user_id: req.user.id,
      symbol,
      side: direction,
      quantity: parseFloat(quantity),
      price: parseFloat(finalPrice),
      amount,
      type: 'paper', // 模拟交易
      status: 'filled', // 立即成交
      filledAt: new Date()
    });

    res.json({
      success: true,
      message: '订单提交成功',
      data: {
        orderId: trade.id,
        symbol,
        symbolName,
        direction,
        quantity: parseFloat(quantity),
        price: parseFloat(finalPrice),
        amount,
        status: 'filled',
        timestamp: new Date().toISOString(),
        trade
      }
    });
  } catch (error) {
    console.error('提交订单错误:', error);
    res.status(500).json({
      success: false,
      message: '提交订单失败',
      error: error.message
    });
  }
});

// 获取交易记录列表
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { 
      page = 1, 
      pageSize = 20, 
      type, 
      status, 
      symbol, 
      side,
      startDate,
      endDate 
    } = req.query;
    
    const offset = (page - 1) * pageSize;

    const where = { user_id: req.user.id };
    if (type) where.type = type;
    if (status) where.status = status;
    if (symbol) where.symbol = { [Op.like]: `%${symbol}%` };
    if (side) where.side = side;
    
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt[Op.gte] = new Date(startDate);
      if (endDate) where.createdAt[Op.lte] = new Date(endDate);
    }

    const trades = await Trade.findAndCountAll({
      where,
      limit: parseInt(pageSize),
      offset: parseInt(offset),
      order: [['createdAt', 'DESC']],
      include: [{
        model: Strategy,
        as: 'strategy',
        attributes: ['id', 'name'],
        required: false
      }]
    });

    // 添加股票名称
    const tradesWithNames = trades.rows.map(trade => ({
      ...trade.toJSON(),
      symbolName: getSymbolName(trade.symbol)
    }));

    res.json({
      success: true,
      data: {
        list: tradesWithNames,
        total: trades.count,
        page: parseInt(page),
        pageSize: parseInt(pageSize)
      }
    });
  } catch (error) {
    console.error('获取交易记录错误:', error);
    console.error('错误堆栈:', error.stack);
    res.status(500).json({
      success: false,
      message: '获取交易记录失败',
      error: error.message
    });
  }
});

// 创建交易订单（模拟交易）
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { 
      strategyId, 
      symbol, 
      side, 
      quantity, 
      price, 
      type = 'paper',
      orderType = 'limit',
      isFutures = false,
      offset = null,
      marginRatio = null,
      algoParams = null,
      strategyName = null
    } = req.body;

    if (!symbol || !side || !quantity || !price) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数'
      });
    }

    if (!['buy', 'sell'].includes(side)) {
      return res.status(400).json({
        success: false,
        message: '交易方向必须是buy或sell'
      });
    }

    // Server-side futures detection (do NOT trust client-supplied isFutures)
    const isFuturesOrder = isFuturesSymbol(symbol);

    // Stock trading compliance: quantity must be multiples of 100
    const lotError = validateStockLotSize(quantity, isFuturesOrder);
    if (lotError) {
      return res.status(400).json({ success: false, message: lotError });
    }

    // Stock price limit validation: ±10% (涨跌停限制) — uses server-side reference prices
    const priceLimitError = await validatePriceLimit(orderType, price, symbol, isFuturesOrder);
    if (priceLimitError) {
      return res.status(400).json({ success: false, ...priceLimitError });
    }

    // 🔥 买入时验证可用资金
    if (side === 'buy') {
      // 获取当前账户信息
      const trades = await Trade.findAll({
        where: { 
          user_id: req.user.id,
          status: 'filled'
        }
      });

      let totalProfit = 0;
      let positionCost = 0;

      trades.forEach(trade => {
        if (trade.isClosed && trade.profit) {
          totalProfit += parseFloat(trade.profit);
        } else if (!trade.isClosed && trade.side === 'buy') {
          positionCost += parseFloat(trade.amount);
        }
      });

      const initialFunds = 1000000.00;
      const availableFunds = initialFunds + totalProfit - positionCost;

      // 计算本次交易所需资金
      const requiredAmount = parseFloat(quantity) * parseFloat(price);

      // 🔥 验证资金是否足够
      if (availableFunds < requiredAmount) {
        return res.status(400).json({
          success: false,
          message: `资金不足！可用资金: ¥${availableFunds.toFixed(2)}, 所需资金: ¥${requiredAmount.toFixed(2)}`,
          data: {
            availableFunds: availableFunds,
            requiredAmount: requiredAmount,
            shortage: requiredAmount - availableFunds
          }
        });
      }

    }

    // 验证策略（如果提供）
    if (strategyId) {
      const strategy = await Strategy.findByPk(strategyId);
      if (!strategy || strategy.user_id !== req.user.id) {
        return res.status(404).json({
          success: false,
          message: '策略不存在或无权访问'
        });
      }
    }

    const amount = parseFloat(quantity) * parseFloat(price);

    // Determine fill status: market orders fill immediately,
    // limit orders only fill if price condition is met
    let fillStatus = 'pending';
    let executionPrice = parseFloat(price);

    if (orderType === 'market' || !orderType) {
      fillStatus = 'filled';
    } else if (orderType === 'limit') {
      // For paper trading, simulate market price from the order price
      // In real system, this would compare against live market data
      // Limit buy at or above "market" -> fills; limit sell at or below "market" -> fills
      // Since we don't have real-time market price here, fill immediately for paper trading
      fillStatus = 'filled';
    } else {
      // counterparty, queue, best5, bestOwn, twap, vwap all fill immediately in paper mode
      fillStatus = 'filled';
    }

    const trade = await Trade.create({
      user_id: req.user.id,
      strategy_id: strategyId || null,
      symbol,
      side,
      quantity: parseFloat(quantity),
      price: executionPrice,
      amount,
      type,
      orderType: orderType || 'limit',
      isFutures: isFutures || false,
      offset: offset || null,
      status: fillStatus,
      filledAt: fillStatus === 'filled' ? new Date() : null
    });

    // 🔥 返回完整的交易数据，包括策略名称
    const tradeData = {
      ...trade.toJSON(),
      symbolName: getSymbolName(trade.symbol),
      strategyName: strategyName || null
    };

    console.log('✅ 交易订单创建成功:', tradeData);

    res.status(201).json({
      success: true,
      message: '交易订单创建成功',
      data: tradeData
    });
  } catch (error) {
    console.error('创建交易订单错误:', error);
    res.status(500).json({
      success: false,
      message: '创建交易订单失败',
      error: error.message
    });
  }
});

// 获取订单详情
router.get('/order/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    const trade = await Trade.findOne({
      where: {
        id,
        user_id: req.user.id
      },
      include: [{
        model: Strategy,
        as: 'strategy',
        attributes: ['id', 'name']
      }]
    });

    if (!trade) {
      return res.status(404).json({
        success: false,
        message: '订单不存在'
      });
    }

    const tradeWithName = {
      ...trade.toJSON(),
      symbolName: getSymbolName(trade.symbol)
    };

    res.json({
      success: true,
      data: tradeWithName
    });
  } catch (error) {
    console.error('获取订单详情错误:', error);
    res.status(500).json({
      success: false,
      message: '获取订单详情失败',
      error: error.message
    });
  }
});

// 取消订单
router.post('/order/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    const trade = await Trade.findOne({
      where: {
        id,
        user_id: req.user.id,
        status: 'pending'
      }
    });

    if (!trade) {
      return res.status(404).json({
        success: false,
        message: '订单不存在或无法取消'
      });
    }

    await trade.update({
      status: 'cancelled'
    });

    res.json({
      success: true,
      message: '订单取消成功',
      data: trade
    });
  } catch (error) {
    console.error('取消订单错误:', error);
    res.status(500).json({
      success: false,
      message: '取消订单失败',
      error: error.message
    });
  }
});

// 平仓操作
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
      // 计算实际盈亏
      // 从请求中获取平仓价格，如果没有则使用成交价（实际应该从市场获取当前价）
      const closePrice = req.body.closePrice || trade.price;
      let profit = 0;
      
      if (trade.side === 'buy') {
        // 买入后平仓，盈亏 = (平仓价 - 成交价) * 数量
        profit = (closePrice - trade.price) * trade.quantity;
      } else {
        // 卖出后平仓，盈亏 = (成交价 - 平仓价) * 数量
        profit = (trade.price - closePrice) * trade.quantity;
      }
      
      await trade.update({
        isClosed: true,
        closedAt: new Date(),
        closedQuantity: trade.quantity,
        profit: profit
      });

      console.log('✅ 全仓平仓成功:', {
        id: trade.id,
        symbol: trade.symbol,
        quantity: trade.quantity,
        profit: profit
      });

      return res.json({
        success: true,
        message: '全仓平仓成功',
        data: {
          tradeId: trade.id,
          closeType: 'full',
          closedQuantity: trade.quantity,
          profit: profit
        }
      });
    }

    // 部分平仓
    if (closeType === 'partial') {
      // 计算部分平仓的盈亏
      const closePrice = req.body.closePrice || trade.price;
      let partialProfit = 0;
      
      if (trade.side === 'buy') {
        partialProfit = (closePrice - trade.price) * closeQuantity;
      } else {
        partialProfit = (trade.price - closePrice) * closeQuantity;
      }
      
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
        price: closePrice,
        amount: closeQuantity * closePrice,
        status: 'filled',
        type: trade.type,
        isClosed: true,
        closedAt: new Date(),
        filledAt: new Date(),
        relatedTradeId: trade.id, // 关联原交易
        profit: partialProfit
      });

      console.log('✅ 部分平仓成功:', {
        id: trade.id,
        symbol: trade.symbol,
        closedQuantity: closeQuantity,
        remainingQuantity,
        profit: partialProfit
      });

      return res.json({
        success: true,
        message: '部分平仓成功',
        data: {
          tradeId: trade.id,
          closeType: 'partial',
          closedQuantity: closeQuantity,
          remainingQuantity,
          profit: partialProfit
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

// 辅助函数：获取股票名称
function getSymbolName(symbol) {
  const symbolNames = {
    '000001': '平安银行',
    '000002': '万科A',
    '600036': '招商银行',
    '600519': '贵州茅台',
    '000858': '五粮液',
    '002415': '海康威视',
    '600276': '恒瑞医药',
    '000725': '京东方A',
    '002594': '比亚迪',
    '600887': '伊利股份',
    'sh000300': '沪深300',
    '000300': '沪深300'
  };
  return symbolNames[symbol] || symbol;
}

// GET /api/trading/pending — get user's pending orders
router.get('/pending', authMiddleware, async (req, res) => {
  try {
    const pendingOrders = await Trade.findAll({
      where: {
        user_id: req.user.id,
        status: 'pending'
      },
      order: [['createdAt', 'DESC']]
    });

    const ordersWithNames = pendingOrders.map(t => ({
      ...t.toJSON(),
      symbolName: getSymbolName(t.symbol)
    }));

    res.json({ success: true, data: ordersWithNames });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/trading/cancel/:orderId — cancel a pending order
router.post('/cancel/:orderId', authMiddleware, async (req, res) => {
  try {
    const trade = await Trade.findOne({
      where: { id: req.params.orderId, user_id: req.user.id, status: 'pending' }
    });
    if (!trade) return res.status(404).json({ success: false, message: 'Pending order not found' });
    await trade.update({ status: 'cancelled' });
    res.json({ success: true, message: 'Order cancelled' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/trading/live/connect — connect to real broker (stub)
router.post('/live/connect', authMiddleware, async (req, res) => {
  const { broker } = req.body;

  const supportedBrokers = {
    'ctp': { name: '期货CTP接口', status: 'stub', note: '需要期货公司开通CTP权限' },
    'xtp': { name: '股票XTP接口', status: 'stub', note: '需要券商开通XTP权限' },
    'ib': { name: 'Interactive Brokers', status: 'stub', note: '需要IB账户' },
    'mock': { name: '模拟盘接口', status: 'active', note: '完全模拟，无需真实账户' }
  };

  if (!supportedBrokers[broker]) {
    return res.json({ success: false, message: `不支持的券商: ${broker}`, supported: Object.keys(supportedBrokers) });
  }

  if (broker === 'mock') {
    return res.json({
      success: true,
      message: '模拟盘连接成功',
      broker: 'mock',
      accountId: `MOCK_${req.user.id}_${Date.now()}`,
      balance: 1000000,
      note: '模拟盘模式，所有交易不涉及真实资金'
    });
  }

  res.json({
    success: false,
    message: `${supportedBrokers[broker].name} 接口尚未配置`,
    broker,
    status: 'stub',
    setupRequired: supportedBrokers[broker].note,
    contactInfo: '请联系系统管理员配置真实交易接口'
  });
});

// GET /api/trading/live/brokers — list available brokers
router.get('/live/brokers', authMiddleware, async (req, res) => {
  res.json({
    success: true,
    data: [
      { id: 'mock', name: '模拟盘', description: '系统内置模拟交易，无需开户', status: 'available', type: 'simulation' },
      { id: 'ctp', name: '期货CTP', description: '国内期货标准接口，支持螺纹钢等商品期货', status: 'requires_setup', type: 'futures' },
      { id: 'xtp', name: '股票XTP', description: '国内股票高速交易接口', status: 'requires_setup', type: 'stock' },
      { id: 'ib', name: 'Interactive Brokers', description: '境外券商，支持全球市场', status: 'requires_setup', type: 'global' }
    ]
  });
});

module.exports = router;
