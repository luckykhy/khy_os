/**
 * Tick-level Backtest Engine
 * Designed for high-frequency strategy testing on commodity futures tick data.
 * Supports CSV import with flexible column mapping.
 */

const fs = require('fs');
const path = require('path');

class TickBacktestEngine {
  constructor() {
    this.dataDir = path.join(__dirname, '../../data/tick');
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * Parse tick CSV file with auto-detection of column format
   * @param {string} filePath - Path to CSV file
   * @param {object} options - { separator, dateFormat, columnMap }
   * @returns {Array} Parsed tick data
   */
  parseTickCSV(filePath, options = {}) {
    const {
      separator = ',',
      columnMap = null,
      maxRows = 0
    } = options;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    if (lines.length < 2) {
      throw new Error('CSV file must have at least a header and one data row');
    }

    // Parse header
    const header = lines[0].split(separator).map(h => h.trim().toLowerCase());
    console.log(`[TickBacktest] CSV columns: ${header.join(', ')}`);

    // Auto-detect column mapping
    const mapping = columnMap || this.detectColumnMapping(header);
    console.log(`[TickBacktest] Column mapping:`, mapping);

    // Parse rows
    const ticks = [];
    const limit = maxRows > 0 ? Math.min(lines.length, maxRows + 1) : lines.length;

    for (let i = 1; i < limit; i++) {
      const values = lines[i].split(separator).map(v => v.trim());
      if (values.length < header.length) continue;

      const tick = {
        timestamp: values[mapping.timestamp] || values[0],
        price: parseFloat(values[mapping.price]) || 0,
        volume: parseInt(values[mapping.volume]) || 0,
        openInterest: mapping.openInterest !== undefined ? parseInt(values[mapping.openInterest]) || 0 : 0,
        bid1: mapping.bid1 !== undefined ? parseFloat(values[mapping.bid1]) || 0 : 0,
        ask1: mapping.ask1 !== undefined ? parseFloat(values[mapping.ask1]) || 0 : 0,
        direction: mapping.direction !== undefined ? values[mapping.direction] : ''
      };

      if (tick.price > 0) {
        ticks.push(tick);
      }
    }

    console.log(`[TickBacktest] Parsed ${ticks.length} ticks from ${filePath}`);
    return ticks;
  }

  /**
   * Auto-detect column mapping from header names
   */
  detectColumnMapping(header) {
    const mapping = {};

    const patterns = {
      timestamp: ['timestamp', 'time', 'datetime', 'date', 'tradingday', 'updatetime', '时间', '日期'],
      price: ['last', 'lastprice', 'price', 'close', 'latest', '最新价', '成交价'],
      volume: ['volume', 'vol', 'qty', 'quantity', '成交量', '成交手数'],
      openInterest: ['openinterest', 'oi', 'open_interest', 'position', '持仓量'],
      bid1: ['bid', 'bid1', 'bidprice1', 'buyprice', '买一价'],
      ask1: ['ask', 'ask1', 'askprice1', 'sellprice', '卖一价'],
      direction: ['direction', 'side', 'bs', '方向', 'bsflag']
    };

    for (const [field, aliases] of Object.entries(patterns)) {
      const idx = header.findIndex(h => aliases.includes(h.replace(/[_\s]/g, '').toLowerCase()));
      if (idx >= 0) {
        mapping[field] = idx;
      }
    }

    // Fallback: if timestamp not found, use column 0
    if (mapping.timestamp === undefined) mapping.timestamp = 0;
    // If price not found, try column 1
    if (mapping.price === undefined) mapping.price = 1;
    // If volume not found, try column 2
    if (mapping.volume === undefined) mapping.volume = 2;

    return mapping;
  }

  /**
   * Run tick-level backtest
   * @param {Array} ticks - Tick data array
   * @param {object} strategyConfig - Strategy configuration
   * @returns {object} Backtest results
   */
  runBacktest(ticks, strategyConfig = {}) {
    const {
      initialCapital = 100000,
      contractMultiplier = 10, // Rebar: 10 tons/lot
      marginRate = 0.12,
      commission = 3.5, // Per lot per trade
      slippage = 1, // 1 tick slippage
      strategy = 'ema_crossover',
      params = {}
    } = strategyConfig;

    let cash = initialCapital;
    let position = 0; // Positive = long, negative = short
    let entryPrice = 0;
    const trades = [];
    const equity = [];
    let maxEquity = initialCapital;
    let maxDrawdown = 0;

    // Strategy state
    const strategyState = this.initStrategy(strategy, params);

    for (let i = 0; i < ticks.length; i++) {
      const tick = ticks[i];
      const signal = this.evaluateStrategy(strategy, tick, ticks, i, strategyState);

      if (signal === 'buy' && position <= 0) {
        // Close short if any
        if (position < 0) {
          const pnl = (entryPrice - tick.price) * Math.abs(position) * contractMultiplier - commission;
          cash += pnl;
          trades.push({
            type: 'close_short',
            price: tick.price,
            quantity: Math.abs(position),
            pnl,
            timestamp: tick.timestamp
          });
        }
        // Open long
        const lots = Math.floor((cash * 0.3) / (tick.price * contractMultiplier * marginRate));
        if (lots > 0) {
          position = lots;
          entryPrice = tick.price + slippage;
          cash -= commission;
          trades.push({
            type: 'open_long',
            price: entryPrice,
            quantity: lots,
            timestamp: tick.timestamp
          });
        }
      } else if (signal === 'sell' && position >= 0) {
        // Close long if any
        if (position > 0) {
          const pnl = (tick.price - entryPrice) * position * contractMultiplier - commission;
          cash += pnl;
          trades.push({
            type: 'close_long',
            price: tick.price,
            quantity: position,
            pnl,
            timestamp: tick.timestamp
          });
        }
        // Open short
        const lots = Math.floor((cash * 0.3) / (tick.price * contractMultiplier * marginRate));
        if (lots > 0) {
          position = -lots;
          entryPrice = tick.price - slippage;
          cash -= commission;
          trades.push({
            type: 'open_short',
            price: entryPrice,
            quantity: lots,
            timestamp: tick.timestamp
          });
        }
      }

      // Calculate equity
      const unrealizedPnl = position !== 0
        ? (tick.price - entryPrice) * position * contractMultiplier
        : 0;
      const currentEquity = cash + unrealizedPnl;

      if (i % 100 === 0 || i === ticks.length - 1) {
        equity.push({ timestamp: tick.timestamp, equity: currentEquity });
      }

      maxEquity = Math.max(maxEquity, currentEquity);
      const dd = (maxEquity - currentEquity) / maxEquity;
      maxDrawdown = Math.max(maxDrawdown, dd);
    }

    // Close any remaining position at last price
    if (position !== 0 && ticks.length > 0) {
      const lastPrice = ticks[ticks.length - 1].price;
      const pnl = (lastPrice - entryPrice) * position * contractMultiplier - commission;
      cash += pnl;
      trades.push({
        type: position > 0 ? 'close_long' : 'close_short',
        price: lastPrice,
        quantity: Math.abs(position),
        pnl,
        timestamp: ticks[ticks.length - 1].timestamp,
        reason: 'end_of_data'
      });
      position = 0;
    }

    const finalEquity = cash;
    const totalReturn = ((finalEquity - initialCapital) / initialCapital * 100).toFixed(2);
    const winTrades = trades.filter(t => t.pnl > 0).length;
    const lossTrades = trades.filter(t => t.pnl < 0).length;
    const totalTrades = trades.filter(t => t.pnl !== undefined).length;

    return {
      summary: {
        initialCapital,
        finalEquity: Math.round(finalEquity * 100) / 100,
        totalReturn: parseFloat(totalReturn),
        maxDrawdown: Math.round(maxDrawdown * 10000) / 100,
        totalTrades,
        winTrades,
        lossTrades,
        winRate: totalTrades > 0 ? Math.round(winTrades / totalTrades * 10000) / 100 : 0,
        sharpeRatio: this.calculateSharpe(equity, initialCapital),
        tickCount: ticks.length
      },
      trades,
      equity
    };
  }

  initStrategy(strategy, params) {
    switch (strategy) {
      case 'ema_crossover':
        return {
          fastPeriod: params.fastPeriod || 10,
          slowPeriod: params.slowPeriod || 30,
          prices: [],
          fastEma: 0,
          slowEma: 0
        };
      case 'momentum':
        return {
          lookback: params.lookback || 50,
          threshold: params.threshold || 0.002,
          prices: []
        };
      case 'mean_reversion':
        return {
          window: params.window || 100,
          stdMultiplier: params.stdMultiplier || 2,
          prices: []
        };
      default:
        return { prices: [] };
    }
  }

  evaluateStrategy(strategy, tick, ticks, index, state) {
    state.prices.push(tick.price);

    switch (strategy) {
      case 'ema_crossover':
        return this.emaStrategy(state);
      case 'momentum':
        return this.momentumStrategy(state);
      case 'mean_reversion':
        return this.meanReversionStrategy(state);
      default:
        return null;
    }
  }

  emaStrategy(state) {
    const { fastPeriod, slowPeriod, prices } = state;
    if (prices.length < slowPeriod + 1) return null;

    const kFast = 2 / (fastPeriod + 1);
    const kSlow = 2 / (slowPeriod + 1);

    if (state.fastEma === 0) {
      state.fastEma = prices.slice(0, fastPeriod).reduce((a, b) => a + b) / fastPeriod;
      state.slowEma = prices.slice(0, slowPeriod).reduce((a, b) => a + b) / slowPeriod;
    }

    const prevFast = state.fastEma;
    const prevSlow = state.slowEma;
    state.fastEma = prices[prices.length - 1] * kFast + prevFast * (1 - kFast);
    state.slowEma = prices[prices.length - 1] * kSlow + prevSlow * (1 - kSlow);

    if (prevFast <= prevSlow && state.fastEma > state.slowEma) return 'buy';
    if (prevFast >= prevSlow && state.fastEma < state.slowEma) return 'sell';
    return null;
  }

  momentumStrategy(state) {
    const { lookback, threshold, prices } = state;
    if (prices.length < lookback + 1) return null;

    const currentPrice = prices[prices.length - 1];
    const pastPrice = prices[prices.length - 1 - lookback];
    const returnRate = (currentPrice - pastPrice) / pastPrice;

    if (returnRate > threshold) return 'buy';
    if (returnRate < -threshold) return 'sell';
    return null;
  }

  meanReversionStrategy(state) {
    const { window, stdMultiplier, prices } = state;
    if (prices.length < window) return null;

    const slice = prices.slice(-window);
    const mean = slice.reduce((a, b) => a + b) / window;
    const variance = slice.reduce((sum, p) => sum + (p - mean) ** 2, 0) / window;
    const std = Math.sqrt(variance);

    const currentPrice = prices[prices.length - 1];
    const zScore = (currentPrice - mean) / (std || 1);

    if (zScore < -stdMultiplier) return 'buy';
    if (zScore > stdMultiplier) return 'sell';
    return null;
  }

  calculateSharpe(equity, initialCapital) {
    if (equity.length < 2) return 0;
    const returns = [];
    for (let i = 1; i < equity.length; i++) {
      returns.push((equity[i].equity - equity[i - 1].equity) / equity[i - 1].equity);
    }
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    return std > 0 ? Math.round((avgReturn / std) * Math.sqrt(252) * 100) / 100 : 0;
  }

  /**
   * Parse tick data from ZIP archive via futuresTickDataService.
   * @param {string} symbol - Instrument symbol (e.g. 'A2605')
   * @param {string} date - Date string YYYYMMDD (e.g. '20260421')
   * @returns {Array} Tick data in engine-compatible format
   */
  async parseTickFromZip(symbol, date) {
    const futuresTickDataService = require('./futuresTickDataService');
    const { ticks: rawTicks } = await futuresTickDataService.getTickData(symbol, date);

    return rawTicks.map(t => ({
      timestamp: t.time,
      price: t.lastPrice,
      volume: t.volume,
      openInterest: t.openInterest,
      bid1: t.bidPrice,
      ask1: t.askPrice,
      direction: t.tradeType || '',
    }));
  }

  /**
   * List available tick data files
   */
  listTickFiles() {
    if (!fs.existsSync(this.dataDir)) return [];
    return fs.readdirSync(this.dataDir)
      .filter(f => f.endsWith('.csv'))
      .map(f => {
        const stat = fs.statSync(path.join(this.dataDir, f));
        return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
      });
  }
}

module.exports = new TickBacktestEngine();
