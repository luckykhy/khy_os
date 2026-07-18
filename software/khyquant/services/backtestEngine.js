/**
 * Real backtest engine
 * Runs a strategy's signal function against historical kline data and computes
 * equity curve, drawdown, Sharpe ratio, and trade log.
 */
const vm = require('vm');
const klineDataService = require('./klineDataService');
const comprehensiveDataService = require('./comprehensiveDataService');
const logger = require('../utils/logger');

function toFiniteNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundFinite(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Number(num.toFixed(digits));
}

function normalizeBars(rawBars = []) {
  if (!Array.isArray(rawBars)) return [];

  const normalized = [];
  for (const item of rawBars) {
    const date = item?.date || item?.time || item?.trade_date || item?.datetime;
    const close = toFiniteNumber(item?.close ?? item?.close_price, null);
    if (!date || !Number.isFinite(close) || close <= 0) continue;

    const openRaw = toFiniteNumber(item?.open ?? item?.open_price, close);
    const highRaw = toFiniteNumber(item?.high ?? item?.high_price, close);
    const lowRaw = toFiniteNumber(item?.low ?? item?.low_price, close);
    const volumeRaw = toFiniteNumber(item?.volume, 0);

    const open = openRaw > 0 ? openRaw : close;
    const high = Math.max(highRaw > 0 ? highRaw : close, open, close);
    const low = Math.min(lowRaw > 0 ? lowRaw : close, open, close);
    const volume = Math.max(0, volumeRaw || 0);

    normalized.push({
      date: String(date),
      open,
      high,
      low,
      close,
      volume,
    });
  }

  return normalized;
}

class BacktestEngine {
  /**
   * Run a backtest
   * @param {Object} options
   * @param {string} options.symbol - Instrument symbol
   * @param {string} options.startDate - ISO date string
   * @param {string} options.endDate - ISO date string
   * @param {number} options.initialCapital - Starting capital (default 100000)
   * @param {Function|string} options.signalFn - Function(bar, i, bars) => 'buy'|'sell'|null
   * @param {Object} options.params - Strategy parameters
   * @returns {Object} Backtest results
   */
  async run({ symbol, startDate, endDate, initialCapital = 100000, signalFn, params = {} }) {
    // 1. Load historical data
    let barsResult = await klineDataService.getKlineData(symbol, 'daily', startDate, endDate, 10000);
    // getKlineData returns { kline: [...], ... } or an array (legacy)
    const primaryBars = Array.isArray(barsResult) ? barsResult
      : Array.isArray(barsResult?.kline) ? barsResult.kline
      : [];
    let bars = normalizeBars(primaryBars);

    // Fallback: pull from comprehensive source (which includes mock/hybrid fallback).
    if (!bars || bars.length < 2) {
      try {
        const comprehensive = await comprehensiveDataService.getComprehensiveData(symbol, {
          startDate,
          endDate,
          period: 'daily'
        });
        bars = normalizeBars(comprehensive?.kline || []);
      } catch (fallbackError) {
        logger.warn('Backtest comprehensive fallback failed', {
          symbol,
          error: fallbackError.message
        });
      }
    }

    if (!bars || bars.length < 2) {
      throw Object.assign(new Error(`Insufficient data for ${symbol}: ${bars?.length || 0} bars`), { status: 400 });
    }

    // 2. Compile signal function if string (using vm sandbox for security)
    let signal;
    if (typeof signalFn === 'string') {
      try {
        const sandbox = Object.create(null);
        // Wrap every function to cut prototype chain (.constructor.constructor → Function escape)
        const w = (fn) => { const f = (...args) => fn(...args); Object.setPrototypeOf(f, null); return f; };
        sandbox.Math = Object.freeze({
          abs: w(Math.abs), ceil: w(Math.ceil), floor: w(Math.floor),
          max: w(Math.max), min: w(Math.min), pow: w(Math.pow),
          round: w(Math.round), sqrt: w(Math.sqrt), log: w(Math.log),
          random: w(Math.random), PI: Math.PI, E: Math.E,
        });
        sandbox.Number = w(Number);
        sandbox.parseFloat = w(parseFloat);
        sandbox.parseInt = w(parseInt);
        sandbox.isNaN = w(isNaN);
        sandbox.isFinite = w(isFinite);
        const ctx = vm.createContext(sandbox);

        // Detect strategy calling convention:
        // Type A: "function strategy(data, params)" — batch mode, returns signals array
        // Type B: per-bar code that uses "bar", "i", "bars" variables
        const isBatchStrategy = /function\s+strategy\s*\(\s*data/.test(signalFn);

        if (isBatchStrategy) {
          // Batch strategy: call once with all bars, get signals array
          const script = new vm.Script(`(function(allBars, params) { ${signalFn}; return strategy(allBars, params); })`);
          const batchFn = script.runInContext(ctx, { timeout: 10000 });
          const signals = batchFn(bars, params);
          // Convert signals array to per-bar lookup
          // signals can be: [{index, signal}, ...] or [{date, signal}, ...] or array of 'buy'|'sell'|null
          const signalMap = new Map();
          if (Array.isArray(signals)) {
            for (let si = 0; si < signals.length; si++) {
              const s = signals[si];
              if (s && typeof s === 'object' && s.signal) {
                const idx = s.index != null ? s.index : s.bar_index != null ? s.bar_index : -1;
                if (idx >= 0) {
                  signalMap.set(idx, s.signal);
                } else if (s.date) {
                  // Find bar index by date
                  const matchIdx = bars.findIndex(b => b.date === s.date);
                  if (matchIdx >= 0) signalMap.set(matchIdx, s.signal);
                }
              } else if (typeof s === 'string' && s) {
                // Positional: signals[i] corresponds to bars[i]
                signalMap.set(si, s);
              }
            }
          }
          signal = (bar, i) => signalMap.get(i) || null;
        } else {
          // Per-bar strategy: wrap code as function(bar, i, bars, params)
          const script = new vm.Script(`(function(bar, i, bars, params) { ${signalFn} })`);
          signal = script.runInContext(ctx, { timeout: 5000 });
        }
      } catch (e) {
        throw Object.assign(new Error('Invalid strategy code: ' + e.message), { status: 400 });
      }
    } else if (typeof signalFn === 'function') {
      signal = signalFn;
    } else {
      throw Object.assign(new Error('signalFn must be a function or string'), { status: 400 });
    }

    // 3. Simulate
    let cash = initialCapital;
    let position = 0;
    let entryPrice = 0;
    const trades = [];
    const equity = [];
    let peakEquity = initialCapital;
    let maxDrawdown = 0;
    const dailyReturns = [];
    const frozenBars = Object.freeze(bars.map(b => Object.freeze({ ...b })));
    const frozenParams = Object.freeze({ ...params });

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const closePrice = bar.close;
      const portfolioValue = cash + position * closePrice;
      if (!Number.isFinite(portfolioValue)) {
        throw Object.assign(new Error('Backtest numeric overflow detected'), { status: 400 });
      }
      equity.push({ date: bar.date, value: portfolioValue });

      // Track drawdown
      if (portfolioValue > peakEquity) peakEquity = portfolioValue;
      const dd = peakEquity > 0 ? (peakEquity - portfolioValue) / peakEquity : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;

      // Daily return
      if (i > 0) {
        const prevValue = equity[i - 1].value;
        if (prevValue > 0) {
          dailyReturns.push((portfolioValue - prevValue) / prevValue);
        }
      }

      // Generate signal
      let sig = null;
      try {
        sig = signal(bar, i, frozenBars, frozenParams);
      } catch { /* ignore signal errors */ }

      if (sig === 'buy' && position === 0) {
        // Buy with all available cash
        const qty = Math.floor(cash / closePrice / 100) * 100; // Round to lots of 100
        if (qty > 0) {
          position = qty;
          entryPrice = closePrice;
          cash -= qty * closePrice;
          trades.push({ date: bar.date, side: 'buy', price: closePrice, quantity: qty });
        }
      } else if (sig === 'sell' && position > 0) {
        const profit = (closePrice - entryPrice) * position;
        cash += position * closePrice;
        trades.push({ date: bar.date, side: 'sell', price: closePrice, quantity: position, profit });
        position = 0;
        entryPrice = 0;
      }
    }

    // Force close remaining position at last bar
    if (position > 0) {
      const lastBar = bars[bars.length - 1];
      const profit = (lastBar.close - entryPrice) * position;
      cash += position * lastBar.close;
      trades.push({ date: lastBar.date, side: 'sell', price: lastBar.close, quantity: position, profit, forced: true });
      position = 0;
    }

    // 4. Compute metrics
    const finalCapital = cash;
    const totalReturn = (finalCapital - initialCapital) / initialCapital;
    const tradingDays = bars.length;
    const annualizedReturn = tradingDays > 0 ? Math.pow(1 + totalReturn, 252 / tradingDays) - 1 : 0;
    const winningTrades = trades.filter(t => t.side === 'sell' && (t.profit || 0) > 0);
    const losingTrades = trades.filter(t => t.side === 'sell' && (t.profit || 0) <= 0);
    const sellCount = trades.filter(t => t.side === 'sell').length;
    const winRate = sellCount > 0 ? winningTrades.length / sellCount : 0;

    // Sharpe ratio (annualized, risk-free rate = 0)
    const avgReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
    const stdReturn = dailyReturns.length > 1
      ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (dailyReturns.length - 1))
      : 0;
    const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

    const result = {
      symbol,
      startDate,
      endDate,
      initialCapital,
      finalCapital: roundFinite(finalCapital, 2),
      totalReturn: roundFinite(totalReturn * 100, 2),
      annualizedReturn: roundFinite(annualizedReturn * 100, 2),
      maxDrawdown: roundFinite(maxDrawdown * 100, 2),
      sharpeRatio: roundFinite(sharpeRatio, 4),
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: roundFinite(winRate * 100, 2),
      trades,
      equity,
      tradingDays
    };

    logger.info('Backtest completed', { symbol, totalReturn: result.totalReturn, sharpe: result.sharpeRatio });
    return result;
  }
}

module.exports = new BacktestEngine();
