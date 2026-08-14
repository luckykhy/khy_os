/**
 * Realtime Data Service — Network-Aware, Multi-Source
 *
 * Online mode:  try alternative APIs (Tencent/Sina/Netease) → akshare → simulated
 * Offline mode: last PostgreSQL/SQLite close price + ±0.3% random tick
 */
const logger = require('../utils/logger');
const networkDetector = require('./networkDetector');

// Lazy-load to avoid circular deps
let akshareDataService = null;
function getAkshare() {
  if (!akshareDataService) {
    try { akshareDataService = require('./akshareDataService'); } catch { akshareDataService = null; }
  }
  return akshareDataService;
}

let altDataService = null;
function getAltDataService() {
  if (!altDataService) {
    try { altDataService = require('./alternativeDataService'); } catch { altDataService = null; }
  }
  return altDataService;
}

class RealtimeDataService {
  constructor() {
    this.subscribers = new Map(); // symbol -> Set of ws clients
    this.intervals = new Map();   // symbol -> interval handle
    this.baseData = new Map();    // symbol -> base price data
  }

  subscribe(symbol, client) {
    if (!this.subscribers.has(symbol)) {
      this.subscribers.set(symbol, new Set());
      this.startPushData(symbol);
    }
    this.subscribers.get(symbol).add(client);
    logger.info(`Realtime subscribe: ${symbol}, clients: ${this.subscribers.get(symbol).size}`);
  }

  unsubscribe(symbol, client) {
    if (this.subscribers.has(symbol)) {
      this.subscribers.get(symbol).delete(client);
      if (this.subscribers.get(symbol).size === 0) {
        this.stopPushData(symbol);
        this.subscribers.delete(symbol);
      }
    }
  }

  async startPushData(symbol) {
    await this.initBaseData(symbol);

    const interval = setInterval(() => {
      this.pushRealtimeData(symbol);
    }, 3000);
    this.intervals.set(symbol, interval);

    // Immediate first push
    this.pushRealtimeData(symbol);
  }

  stopPushData(symbol) {
    if (this.intervals.has(symbol)) {
      clearInterval(this.intervals.get(symbol));
      this.intervals.delete(symbol);
      logger.info(`Realtime stopped: ${symbol}`);
    }
  }

  /**
   * Initialize base data from PostgreSQL or SQLite fallback.
   */
  async initBaseData(symbol) {
    // Try PostgreSQL first
    try {
      const KlineData = require('../models/KlineData');
      const latest = await KlineData.findOne({
        where: { symbol, period: 'daily' },
        order: [['trade_date', 'DESC']],
      });
      if (latest) {
        const close = parseFloat(latest.close_price);
        this.baseData.set(symbol, {
          open_price: parseFloat(latest.open_price),
          close_price: close,
          high_price: parseFloat(latest.high_price),
          low_price: parseFloat(latest.low_price),
          volume: parseInt(latest.volume) || 10000000,
          amount: parseFloat(latest.amount) || close * 10000000,
        });
        logger.info(`Realtime base from PostgreSQL: ${symbol} close=${close}`);
        return;
      }
    } catch (err) {
      logger.warn(`PostgreSQL lookup failed for realtime base: ${symbol}`, { error: err.message });
    }

    // Try SQLite backup
    try {
      const sqliteBackup = require('./sqliteBackupService');
      const rows = sqliteBackup.getKlineData(symbol, 'daily', null, null, 1);
      if (rows && rows.length > 0) {
        const r = rows[rows.length - 1];
        this.baseData.set(symbol, {
          open_price: r.open,
          close_price: r.close,
          high_price: r.high,
          low_price: r.low,
          volume: r.volume || 10000000,
          amount: r.amount || r.close * 10000000,
        });
        logger.info(`Realtime base from SQLite: ${symbol} close=${r.close}`);
        return;
      }
    } catch { /* ignore */ }

    // Fallback defaults — use per-symbol realistic 2026 prices
    const fallbackPrices = {
      'sh000300': 4660, '000300': 4660,
      'sh000001': 3350, '000001': 3350,
      'sz399001': 10800, '399001': 10800,
      'sz399006': 2100, '399006': 2100,
      'sh600519': 1680, '600519': 1680,
      'sh600036': 38, '600036': 38,
      'sz000001': 11,
      'sz000858': 148, '000858': 148,
      'sh600000': 7.8, '600000': 7.8,
      'sh601318': 52, '601318': 52,
      'sz002594': 280, '002594': 280,
      'sz000002': 8.5, '000002': 8.5,
      'rb_main': 3380, 'rb2510': 3380,
    };
    const clean = symbol.replace(/^(sh|sz)/i, '');
    const basePrice = fallbackPrices[symbol] || fallbackPrices[clean] || 10;
    this.baseData.set(symbol, {
      open_price: basePrice,
      close_price: basePrice,
      high_price: basePrice * 1.02,
      low_price: basePrice * 0.98,
      volume: 10000000,
      amount: basePrice * 10000000,
    });
  }

  /**
   * Push realtime data to all subscribers of a symbol.
   * Online: try akshare first; Offline: simulated tick.
   */
  async pushRealtimeData(symbol) {
    const clients = this.subscribers.get(symbol);
    if (!clients || clients.size === 0) return;

    const baseData = this.baseData.get(symbol);
    if (!baseData) return;

    let realtimeData = null;

    // Online mode: try alternative APIs first, then akshare
    if (networkDetector.isOnline()) {
      // Try alternative APIs (Tencent → Sina → Netease)
      try {
        const alt = getAltDataService();
        if (alt) {
          const quote = await alt.fetchRealtimeQuote(symbol);
          if (quote && quote.current) {
            realtimeData = {
              symbol,
              current: quote.current,
              open: quote.open || baseData.open_price,
              high: quote.high || baseData.high_price,
              low: quote.low || baseData.low_price,
              preClose: quote.preClose || baseData.open_price,
              change: quote.change || 0,
              changeRate: quote.changeRate || 0,
              volume: quote.volume || 0,
              amount: quote.amount || 0,
              time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
              dataSource: quote.source || 'alt_realtime',
            };
          }
        }
      } catch { /* fall through */ }

      // Try akshare if alternatives failed
      if (!realtimeData) {
        try {
          const akshare = getAkshare();
          if (akshare && typeof akshare.getRealtimeQuote === 'function') {
            const quote = await Promise.race([
              akshare.getRealtimeQuote(symbol),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
            ]);
            if (quote && quote.current) {
              realtimeData = {
                symbol,
                current: parseFloat(quote.current),
                open: parseFloat(quote.open || baseData.open_price),
                high: parseFloat(quote.high || baseData.high_price),
                low: parseFloat(quote.low || baseData.low_price),
                preClose: parseFloat(quote.preClose || baseData.open_price),
                change: parseFloat(quote.change || 0),
                changeRate: parseFloat(quote.changeRate || quote.changePercent || 0),
                volume: parseInt(quote.volume || 0),
                amount: parseFloat(quote.amount || 0),
                time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
                dataSource: 'akshare_realtime',
              };
            }
          }
        } catch { /* fall through to simulated tick */ }
      }
    }

    // Offline / akshare failed: simulated tick ±0.3%
    if (!realtimeData) {
      realtimeData = this._generateSimulatedTick(symbol, baseData);
    }

    // Update base data with latest price
    this.baseData.set(symbol, {
      ...baseData,
      close_price: realtimeData.current,
      high_price: Math.max(baseData.high_price, realtimeData.current),
      low_price: Math.min(baseData.low_price, realtimeData.current),
    });

    // Broadcast
    const message = JSON.stringify({
      type: 'realtime',
      symbol,
      data: realtimeData,
      timestamp: new Date().toISOString(),
    });

    clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    });
  }

  /**
   * Generate a simulated tick with ±0.3% movement from last close.
   */
  _generateSimulatedTick(symbol, baseData) {
    const lastPrice = baseData.close_price;
    const changePercent = (Math.random() - 0.5) * 0.006; // ±0.3%
    const current = parseFloat((lastPrice * (1 + changePercent)).toFixed(2));
    const change = parseFloat((current - baseData.open_price).toFixed(2));
    const changeRate = parseFloat(((change / baseData.open_price) * 100).toFixed(2));
    const volume = Math.floor(Math.random() * 1000000) + 500000;
    const amount = parseFloat((volume * current).toFixed(2));

    return {
      symbol,
      current,
      open: baseData.open_price,
      high: Math.max(baseData.high_price, current),
      low: Math.min(baseData.low_price, current),
      preClose: baseData.open_price,
      change,
      changeRate,
      volume,
      amount,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      dataSource: 'simulated',
    };
  }

  cleanup() {
    this.intervals.forEach(interval => clearInterval(interval));
    this.intervals.clear();
    this.subscribers.clear();
    this.baseData.clear();
    logger.info('Realtime data service cleaned up');
  }
}

module.exports = new RealtimeDataService();
