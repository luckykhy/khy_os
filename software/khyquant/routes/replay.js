const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

// EMA helper
function calculateEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

// POST /api/replay/start — start data replay session
router.post('/start', authMiddleware, async (req, res) => {
  try {
    const { symbol, startDate, endDate, speed = 1, period = 'daily', strategyId, dataSource = 'mock', date } = req.body;

    const sessionId = `replay_${req.user.id}_${Date.now()}`;

    let klineData;
    let replayDataSourceLabel = 'mock';

    if (dataSource === 'futures-tick' && date) {
      // Load real tick data from folder or ZIP, aggregated to kline
      const futuresTickDataService = require('../services/futuresTickDataService');
      const replayPeriod = period === 'daily' ? '1m' : period;
      const { bars, dataSource: tickDataSource } = await futuresTickDataService.getKlineFromTicks(symbol, date, replayPeriod);
      klineData = bars;

      if (!klineData || klineData.length === 0) {
        return res.status(400).json({
          success: false,
          message: `No tick data found for ${symbol} on ${date}`
        });
      }
      // Store data source info for later reference
      replayDataSourceLabel = tickDataSource;
    } else {
      // Default: use mock data
      const enhancedMockDataService = require('../services/enhancedMockDataService');
      klineData = enhancedMockDataService.generateEnhancedKLineData({
        symbol,
        period,
        startDate: startDate || null,
        endDate: endDate || new Date().toISOString().split('T')[0],
        limit: 2500
      });
    }

    // Store session in memory
    global.replaySessions = global.replaySessions || {};
    global.replaySessions[sessionId] = {
      symbol,
      data: klineData,
      currentIndex: 0,
      speed,
      period,
      dataSourceLabel: replayDataSourceLabel,
      strategyId: strategyId || null,
      isPlaying: false,
      cash: 1000000,
      positions: {},
      trades: [],
      equity: [{ time: klineData[0]?.date, value: 1000000 }]
    };

    res.json({
      success: true,
      sessionId,
      totalCandles: klineData.length,
      startDate: klineData[0]?.date,
      endDate: klineData[klineData.length - 1]?.date,
      message: 'Replay session created'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/replay/:sessionId/next — get next N candles
router.get('/:sessionId/next', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { count = 1 } = req.query;
    const session = global.replaySessions?.[sessionId];
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const candles = session.data.slice(session.currentIndex, session.currentIndex + parseInt(count));
    session.currentIndex += candles.length;
    const isFinished = session.currentIndex >= session.data.length;

    // Strategy signal detection (EMA crossover) if strategyId is set
    const signals = [];
    if (session.strategyId && candles.length > 0) {
      const allData = session.data.slice(0, session.currentIndex);
      if (allData.length >= 20) {
        const closes = allData.map(d => d.close);
        const closesPrev = closes.slice(0, -1);

        const ema5_now = calculateEMA(closes, 5);
        const ema20_now = calculateEMA(closes, 20);
        const ema5_prev = calculateEMA(closesPrev, 5);
        const ema20_prev = calculateEMA(closesPrev, 20);

        const latest = allData[allData.length - 1];

        // Golden cross = buy
        if (ema5_prev <= ema20_prev && ema5_now > ema20_now) {
          signals.push({ time: latest.date || latest.time, type: 'buy', price: latest.close });
          const qty = Math.floor(session.cash * 0.3 / latest.close / 100) * 100;
          if (qty > 0 && session.cash >= qty * latest.close) {
            session.cash -= qty * latest.close;
            session.positions[session.symbol] = (session.positions[session.symbol] || 0) + qty;
            session.trades.push({ side: 'buy', quantity: qty, price: latest.close, time: latest.date || latest.time });
          }
        }
        // Death cross = sell
        else if (ema5_prev >= ema20_prev && ema5_now < ema20_now) {
          signals.push({ time: latest.date || latest.time, type: 'sell', price: latest.close });
          const held = session.positions[session.symbol] || 0;
          if (held > 0) {
            session.cash += held * latest.close;
            session.positions[session.symbol] = 0;
            session.trades.push({ side: 'sell', quantity: held, price: latest.close, time: latest.date || latest.time });
          }
        }
      }
    }

    // Calculate current equity
    const positionValue = Object.entries(session.positions).reduce((sum, [sym, qty]) => {
      const lastCandle = session.data[session.currentIndex - 1];
      return sum + (qty * (lastCandle?.close || 0));
    }, 0);

    res.json({
      success: true,
      candles,
      signals,
      currentIndex: session.currentIndex,
      totalCandles: session.data.length,
      progress: Math.round(session.currentIndex / session.data.length * 100),
      isFinished,
      account: {
        cash: session.cash,
        positions: session.positions,
        equity: session.cash + positionValue
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/replay/:sessionId/trade — place paper trade during replay
router.post('/:sessionId/trade', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { side, quantity, price } = req.body;
    const session = global.replaySessions?.[sessionId];
    if (!session) return res.status(404).json({ success: false, message: '会话不存在' });

    const amount = quantity * price;
    const trade = { side, quantity, price, amount, time: Date.now() };

    if (side === 'buy') {
      if (session.cash < amount) {
        return res.json({ success: false, message: '资金不足' });
      }
      session.cash -= amount;
      session.positions[session.symbol] = (session.positions[session.symbol] || 0) + quantity;
    } else {
      const held = session.positions[session.symbol] || 0;
      if (held < quantity) {
        return res.json({ success: false, message: '持仓不足' });
      }
      session.cash += amount;
      session.positions[session.symbol] = held - quantity;
    }

    session.trades.push(trade);

    res.json({
      success: true,
      trade,
      account: { cash: session.cash, positions: session.positions }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/replay/:sessionId/summary — get replay trading summary
router.get('/:sessionId/summary', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = global.replaySessions?.[sessionId];
    if (!session) return res.status(404).json({ success: false, message: '会话不存在' });

    const totalReturn = ((session.cash - 1000000) / 1000000 * 100).toFixed(2);
    res.json({
      success: true,
      summary: {
        initialCash: 1000000,
        finalCash: session.cash,
        totalReturn: totalReturn + '%',
        tradeCount: session.trades.length,
        positions: session.positions,
        trades: session.trades
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/replay/futures-tick/dates — 获取可用日期列表
router.get('/futures-tick/dates', authMiddleware, async (req, res) => {
  try {
    const futuresTickDataService = require('../services/futuresTickDataService');
    // 每次请求都刷新索引，确保新放入的文件能被识别
    await futuresTickDataService.refreshIndex();
    const dates = await futuresTickDataService.getAvailableDates();
    res.json({ success: true, dates });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, dates: [] });
  }
});

// GET /api/replay/futures-tick/symbols?date=YYYYMMDD — 获取指定日期的合约列表
router.get('/futures-tick/symbols', authMiddleware, async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: '缺少 date 参数', symbols: [] });
    const futuresTickDataService = require('../services/futuresTickDataService');
    const symbols = await futuresTickDataService.getAvailableSymbols(date);
    res.json({ success: true, symbols });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, symbols: [] });
  }
});

// POST /api/replay/futures-tick/refresh — 手动刷新索引
router.post('/futures-tick/refresh', authMiddleware, async (req, res) => {
  try {
    const futuresTickDataService = require('../services/futuresTickDataService');
    await futuresTickDataService.refreshIndex();
    const dates = await futuresTickDataService.getAvailableDates();
    res.json({ success: true, message: '索引刷新成功', dateCount: dates.length, dates });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
