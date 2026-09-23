/**
 * Real backtest engine
 * Runs a strategy's signal function against historical kline data and computes
 * equity curve, drawdown, Sharpe ratio, and trade log.
 *
 * A-share realism (borrowed from qlib / backtrader execution models):
 *  - T+1 settlement: shares bought on bar i cannot be sold until bar i+1
 *    (`lockedShares` tracks same-day purchases). Default on; opt out via
 *    `options.tPlus1 = false` for non-A-share instruments.
 *  - Transaction costs: commission (default 0.0003, both sides), stamp duty
 *    (default 0.001, sell side only — A-share rule), and optional slippage
 *    (default 0.001 = 0.1%). All overridable via `options` so legacy callers
 *    keep byte-identical behavior when they pass the old signature.
 */
const vm = require('vm');
const crypto = require('crypto');
const klineDataService = require('./klineDataService');
const comprehensiveDataService = require('./comprehensiveDataService');
const logger = require('../utils/logger');

// A-share default transaction cost model (single source of truth for this
// engine). Callers may override each value via options; the defaults mirror
// strategyEngine.js's existing 0.0003 commission / 0.001 stamp duty so the
// two engines stop diverging.
const DEFAULT_COSTS = Object.freeze({
  commissionRate: 0.0003, // 0.03%, charged on both buy and sell notional
  stampDutyRate: 0.001, // 0.1%, sell side only (A-share)
  slippage: 0.001, // 0.1% adverse price move per fill
  tPlus1: true, // A-share: same-day purchase locked until next bar
});

function toFiniteNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundFinite(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Number(num.toFixed(digits));
}

/**
 * Resolve the effective cost model from options, falling back to the A-share
 * defaults. Boolean `tPlus1` defaults to true (A-share); numeric rates fall
 * back to DEFAULT_COSTS when not provided.
 */
function resolveCosts(options) {
  return {
    commissionRate: toFiniteNumber(options.commissionRate, DEFAULT_COSTS.commissionRate),
    stampDutyRate: toFiniteNumber(options.stampDutyRate, DEFAULT_COSTS.stampDutyRate),
    slippage: toFiniteNumber(options.slippage, DEFAULT_COSTS.slippage),
    tPlus1: options.tPlus1 === undefined ? DEFAULT_COSTS.tPlus1 : options.tPlus1 === true,
  };
}

/**
 * Reproducibility fingerprint (borrowed from freqtrade's backtest cache key):
 * a short SHA-1 over everything that deterministically determines a result.
 * Identical inputs always yield an identical fingerprint, so a stored backtest
 * row can be matched against its code+params+data range later. Callers persist
 * it alongside the result.
 *
 * @param {object} p
 * @param {string} p.signalCode - raw strategy source (string form of signalFn)
 * @param {object} p.params - strategy parameters
 * @param {string} p.symbol
 * @param {string} p.startDate
 * @param {string} p.endDate
 * @param {object} p.costs - resolved cost model
 * @returns {string} 16-char hex fingerprint
 */
function buildFingerprint({ signalCode, params, symbol, startDate, endDate, costs }) {
  const payload = JSON.stringify({
    v: 1,
    code: String(signalCode || ''),
    params: params || {},
    symbol,
    startDate,
    endDate,
    costs: costs || {},
  });
  return crypto.createHash('sha1').update(payload, 'utf-8').digest('hex').slice(0, 16);
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
  async run({
    symbol,
    startDate,
    endDate,
    initialCapital = 100000,
    signalFn,
    params = {},
    ...costOpts
  }) {
    // A-share cost + settlement model (T+1, commission, stamp duty, slippage).
    const costs = resolveCosts(costOpts);

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
    let lockedShares = 0; // A-share T+1: shares bought today, sellable from next bar
    const trades = [];
    const equity = [];
    let peakEquity = initialCapital;
    let maxDrawdown = 0;
    const dailyReturns = [];
    const frozenBars = Object.freeze(bars.map(b => Object.freeze({ ...b })));
    const frozenParams = Object.freeze({ ...params });

    for (let i = 0; i < bars.length; i++) {
      // T+1 settlement: shares locked on the previous bar become sellable now.
      if (i > 0) {
        position += lockedShares;
        lockedShares = 0;
      }

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

      // Apply slippage: buys fill higher, sells fill lower (adverse move).
      const buyFill = closePrice * (1 + costs.slippage);
      const sellFill = closePrice * (1 - costs.slippage);

      if (sig === 'buy' && position === 0) {
        // Buy with all available cash; round to 100-share lots (A-share rule).
        const qty = Math.floor(cash / buyFill / 100) * 100;
        if (qty > 0) {
          const notional = qty * buyFill;
          const commission = notional * costs.commissionRate;
          if (cash >= notional + commission) {
            position = costs.tPlus1 ? 0 : qty; // T+1: held in lockedShares
            lockedShares = costs.tPlus1 ? qty : 0;
            entryPrice = buyFill;
            cash -= notional + commission;
            trades.push({
              date: bar.date, side: 'buy', price: buyFill, quantity: qty,
              commission, slippageCost: qty * (buyFill - closePrice), totalCost: commission,
            });
          }
        }
      } else if (sig === 'sell' && position > 0) {
        // A-share T+1: only shares already unlocked (bought on earlier bars)
        // are sellable. `position` here is the unlocked portion; same-day
        // purchases sit in `lockedShares` until the next bar's unlock.
        const notional = position * sellFill;
        const commission = notional * costs.commissionRate;
        const stampDuty = notional * costs.stampDutyRate; // sell side only
        const proceeds = notional - commission - stampDuty;
        const profit = (sellFill - entryPrice) * position - commission - stampDuty;
        cash += proceeds;
        trades.push({
          date: bar.date, side: 'sell', price: sellFill, quantity: position, profit,
          commission, stampDuty, slippageCost: position * (closePrice - sellFill),
          totalCost: commission + stampDuty,
        });
        position = 0;
        entryPrice = 0;
      }
    }

    // Force close remaining position at last bar (including T+1-locked shares).
    if (position > 0 || lockedShares > 0) {
      const closeQty = position + lockedShares;
      const lastBar = bars[bars.length - 1];
      const sellFill = lastBar.close * (1 - costs.slippage);
      const notional = closeQty * sellFill;
      const commission = notional * costs.commissionRate;
      const stampDuty = notional * costs.stampDutyRate;
      const profit = (sellFill - entryPrice) * closeQty - commission - stampDuty;
      cash += notional - commission - stampDuty;
      trades.push({
        date: lastBar.date, side: 'sell', price: sellFill, quantity: closeQty, profit,
        commission, stampDuty, forced: true,
        slippageCost: closeQty * (lastBar.close - sellFill), totalCost: commission + stampDuty,
      });
      position = 0;
      lockedShares = 0;
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

    const totalCommission = trades.reduce((s, t) => s + (t.commission || 0), 0);
    const totalStampDuty = trades.reduce((s, t) => s + (t.stampDuty || 0), 0);
    const totalSlippageCost = trades.reduce((s, t) => s + (t.slippageCost || 0), 0);

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
      totalCommission: roundFinite(totalCommission, 2),
      totalStampDuty: roundFinite(totalStampDuty, 2),
      totalSlippageCost: roundFinite(totalSlippageCost, 2),
      trades,
      equity,
      tradingDays,
      // A-share execution realism metadata, so consumers can tell which
      // assumptions produced the numbers (and reproduce them).
      execution: {
        tPlus1: costs.tPlus1,
        commissionRate: costs.commissionRate,
        stampDutyRate: costs.stampDutyRate,
        slippage: costs.slippage,
        totalCommission: roundFinite(totalCommission, 2),
        totalStampDuty: roundFinite(totalStampDuty, 2),
        totalSlippageCost: roundFinite(totalSlippageCost, 2),
      },
      // Reproducibility: sha1 over strategy code + params + symbol + range +
      // cost model. Identical inputs → identical fingerprint (freqtrade-style).
      fingerprint: buildFingerprint({
        signalCode: typeof signalFn === 'string' ? signalFn : String(signalFn),
        params: frozenParams,
        symbol,
        startDate,
        endDate,
        costs,
      }),
    };

    logger.info('Backtest completed', { symbol, totalReturn: result.totalReturn, sharpe: result.sharpeRatio });
    return result;
  }
}

// The engine is exposed as a singleton (existing call sites use
// `backtestEngine.run(...)`), with the helper functions attached for reuse by
// routes that build a fingerprint outside a run() call.
const engine = new BacktestEngine();
engine.DEFAULT_COSTS = DEFAULT_COSTS;
engine.resolveCosts = resolveCosts;
engine.buildFingerprint = buildFingerprint;

module.exports = engine;
