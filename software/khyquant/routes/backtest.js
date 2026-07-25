const express = require('express');
const router = express.Router();
const { Backtest, Strategy } = require('../models');
const { authMiddleware } = require('../middleware/auth');
const axios = require('axios');
const backtestEngine = require('../services/backtestEngine');

// 创建回测任务
router.post('/run', authMiddleware, async (req, res) => {
  try {
    const { strategyId, name, startDate, endDate, initialCapital, symbols } = req.body;

    if (!strategyId || !startDate || !endDate || !symbols || !Array.isArray(symbols)) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数'
      });
    }

    // 验证策略是否存在且属于当前用户
    const strategy = await Strategy.findByPk(strategyId);
    if (!strategy || strategy.user_id !== req.user.id) {
      return res.status(404).json({
        success: false,
        message: '策略不存在或无权访问'
      });
    }

    // 创建回测记录
    const backtest = await Backtest.create({
      user_id: req.user.id,
      strategy_id: strategyId,
      name: name || `回测_${new Date().toISOString()}`,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      initialCapital: initialCapital || 100000,
      symbols,
      status: 'pending'
    });

    // Run backtest asynchronously and update record
    res.status(201).json({
      success: true,
      message: 'Backtest started',
      data: backtest
    });

    // Execute in background
    (async () => {
      try {
        await backtest.update({ status: 'running' });
        const result = await backtestEngine.run({
          symbol: symbols[0],
          startDate,
          endDate,
          initialCapital: initialCapital || 100000,
          signalFn: strategy.code,
          params: strategy.parameters || {}
        });
        await backtest.update({
          status: 'completed',
          finalCapital: result.finalCapital,
          totalReturn: result.totalReturn,
          annualizedReturn: result.annualizedReturn,
          maxDrawdown: result.maxDrawdown,
          totalTrades: result.totalTrades,
          winningTrades: result.winningTrades,
          losingTrades: result.losingTrades,
          winRate: result.winRate,
          trades: result.trades,
          parameters: { ...strategy.parameters, sharpeRatio: result.sharpeRatio }
        });
      } catch (err) {
        await backtest.update({ status: 'failed' }).catch(() => {});
        console.error('Backtest execution failed:', err.message);
      }
    })();
  } catch (error) {
    console.error('创建回测任务错误:', error);
    res.status(500).json({
      success: false,
      message: '创建回测任务失败',
      error: error.message
    });
  }
});

// 获取回测列表
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, status } = req.query;
    const offset = (page - 1) * pageSize;

    const where = { user_id: req.user.id };
    if (status) where.status = status;

    const backtests = await Backtest.findAndCountAll({
      where,
      limit: parseInt(pageSize),
      offset: parseInt(offset),
      order: [['createdAt', 'DESC']],
      include: [{
        model: Strategy,
        as: 'strategy',
        attributes: ['id', 'name', 'type']
      }]
    });

    res.json({
      success: true,
      data: {
        list: backtests.rows,
        total: backtests.count,
        page: parseInt(page),
        pageSize: parseInt(pageSize)
      }
    });
  } catch (error) {
    console.error('获取回测列表错误:', error);
    res.status(500).json({
      success: false,
      message: '获取回测列表失败',
      error: error.message
    });
  }
});

// 获取回测详情
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const backtest = await Backtest.findByPk(id, {
      include: [{
        model: Strategy,
        as: 'strategy'
      }]
    });

    if (!backtest) {
      return res.status(404).json({
        success: false,
        message: '回测记录不存在'
      });
    }

    if (backtest.user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: '无权访问该回测记录'
      });
    }

    res.json({
      success: true,
      data: backtest
    });
  } catch (error) {
    console.error('获取回测详情错误:', error);
    res.status(500).json({
      success: false,
      message: '获取回测详情失败',
      error: error.message
    });
  }
});

// 保存回测结果
router.post('/save', authMiddleware, async (req, res) => {
  try {
    const {
      strategyId,
      strategyName,
      symbol,
      startDate,
      endDate,
      initialCapital,
      finalCapital,
      totalReturn,
      annualizedReturn,
      maxDrawdown,
      totalTrades,
      winningTrades,
      losingTrades,
      winRate,
      trades,
      signals,
      parameters
    } = req.body;

    if (!strategyId || !symbol || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数'
      });
    }

    // 验证策略是否存在
    const strategy = await Strategy.findByPk(strategyId);
    if (!strategy) {
      return res.status(404).json({
        success: false,
        message: '策略不存在'
      });
    }

    // 创建回测记录
    const backtest = await Backtest.create({
      user_id: req.user.id,
      strategy_id: strategyId,
      name: `${strategyName || strategy.name} - ${symbol}`,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      initialCapital: initialCapital || 100000,
      finalCapital: finalCapital || initialCapital,
      totalReturn: totalReturn || 0,
      annualizedReturn: annualizedReturn || 0,
      maxDrawdown: maxDrawdown || 0,
      totalTrades: totalTrades || 0,
      winningTrades: winningTrades || 0,
      losingTrades: losingTrades || 0,
      winRate: winRate || 0,
      symbols: [symbol],
      trades: trades || [],
      signals: signals || [],
      parameters: parameters || {},
      status: 'completed'
    });

    res.status(201).json({
      success: true,
      message: '回测结果已保存',
      data: backtest
    });
  } catch (error) {
    console.error('保存回测结果错误:', error);
    res.status(500).json({
      success: false,
      message: '保存回测结果失败',
      error: error.message
    });
  }
});

module.exports = router;
