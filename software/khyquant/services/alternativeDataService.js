/**
 * Alternative Data Service — Multi-source fallback for A-share data.
 *
 * Wraps jsDataSources.js with a unified interface, 3s timeout per source,
 * and ordered fallback: EastMoney → Tencent → Netease → Sina → Yahoo.
 *
 * Each fetch returns: { kline: [{date,open,high,low,close,volume}], name, source }
 * or null on failure.
 */
const logger = require('../utils/logger');

let jsDataSources = null;
function getJsDataSources() {
  if (!jsDataSources) {
    try { jsDataSources = require('./jsDataSources'); } catch { jsDataSources = null; }
  }
  return jsDataSources;
}

const FETCH_TIMEOUT = 3000; // 3s per source

/**
 * Symbol normalization: strip sh/sz prefix, detect market,
 * produce the format each API expects.
 */
function normalizeSymbol(rawSymbol) {
  if (!rawSymbol) return { code: '', market: '' };
  let s = rawSymbol.replace(/^(sh|sz|SH|SZ)/, '');
  // If already has .SH/.SZ suffix, extract
  if (s.includes('.')) {
    const [code, market] = s.split('.');
    return { code, market: market.toUpperCase() };
  }
  // Detect market from code prefix
  if (s.startsWith('6') || s.startsWith('9') || /^(000|880)\d{3}$/.test(s)) {
    return { code: s, market: 'SH' };
  }
  return { code: s, market: 'SZ' };
}

/**
 * Convert raw kline result from jsDataSources to normalized format.
 */
function normalizeKline(result) {
  if (!result || !result.kline || result.kline.length === 0) return null;
  const kline = result.kline.map(item => ({
    date: item.time || item.date,
    open: parseFloat(item.open) || 0,
    high: parseFloat(item.high) || 0,
    low: parseFloat(item.low) || 0,
    close: parseFloat(item.close) || 0,
    volume: parseInt(item.volume) || 0,
    amount: parseFloat(item.amount) || 0,
    change: parseFloat(item.change) || 0,
    changePercent: parseFloat(item.changePercent || item.change_percent) || 0,
    turnoverRate: parseFloat(item.turnoverRate || item.turnover_rate) || 0,
  }));
  return { kline, name: result.name || '', source: result.source || 'unknown' };
}

/**
 * Wrap a promise with a timeout.
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}

/**
 * Fetch kline data via Sina Finance API (not in jsDataSources, implement here).
 * Uses the history kline endpoint from Sina.
 */
async function fetchFromSina(rawSymbol, options = {}) {
  const axios = require('axios');
  const { code, market } = normalizeSymbol(rawSymbol);
  const sinaSymbol = `${market.toLowerCase()}${code}`;

  // Sina realtime quote
  const url = `https://hq.sinajs.cn/list=${sinaSymbol}`;
  const resp = await axios.get(url, {
    timeout: FETCH_TIMEOUT,
    headers: { Referer: 'https://finance.sina.com.cn' },
    responseType: 'text',
  });

  const text = resp.data;
  if (!text || text.includes('=""')) return null;

  // Parse: var hq_str_sh000001="name,open,preclose,current,high,low,..."
  const match = text.match(/="([^"]+)"/);
  if (!match) return null;
  const fields = match[1].split(',');
  if (fields.length < 32) return null;

  const name = fields[0];
  const open = parseFloat(fields[1]);
  const preClose = parseFloat(fields[2]);
  const current = parseFloat(fields[3]);
  const high = parseFloat(fields[4]);
  const low = parseFloat(fields[5]);
  const volume = parseInt(fields[8]);
  const amount = parseFloat(fields[9]);
  const dateStr = fields[30]; // YYYY-MM-DD

  // Sina only gives current-day snapshot, not historical klines.
  // Return single-day kline so the service knows price is real.
  return {
    kline: [{
      time: dateStr,
      open,
      high,
      low,
      close: current,
      volume,
      amount,
    }],
    name,
    source: 'Sina Finance',
    currentPrice: current,
    preClose,
  };
}

/**
 * Fetch realtime quote from any available source.
 * Returns { current, open, high, low, preClose, change, changeRate, volume, amount, source }
 * or null if all fail.
 */
async function fetchRealtimeQuote(rawSymbol) {
  const jds = getJsDataSources();
  const { code, market } = normalizeSymbol(rawSymbol);
  const dotSymbol = `${code}.${market}`;

  // Source order: Tencent (fast) → Sina → Netease → EastMoney
  const attempts = [
    {
      name: 'Tencent',
      fn: async () => {
        const result = await jds.fetchFromTencent(dotSymbol);
        if (!result || !result.currentPrice) return null;
        return {
          current: result.currentPrice,
          open: result.kline?.[result.kline.length - 1]?.open || result.currentPrice,
          high: result.kline?.[result.kline.length - 1]?.high || result.currentPrice,
          low: result.kline?.[result.kline.length - 1]?.low || result.currentPrice,
          preClose: result.currentPrice,
          change: 0,
          changeRate: 0,
          volume: 0,
          amount: 0,
          source: 'tencent_realtime',
        };
      },
    },
    {
      name: 'Sina',
      fn: async () => {
        const result = await fetchFromSina(rawSymbol);
        if (!result || !result.currentPrice) return null;
        const k = result.kline[0];
        const change = parseFloat((result.currentPrice - result.preClose).toFixed(2));
        const changeRate = result.preClose ? parseFloat(((change / result.preClose) * 100).toFixed(2)) : 0;
        return {
          current: result.currentPrice,
          open: k.open,
          high: k.high,
          low: k.low,
          preClose: result.preClose,
          change,
          changeRate,
          volume: k.volume,
          amount: k.amount,
          source: 'sina_realtime',
        };
      },
    },
    {
      name: 'Netease',
      fn: async () => {
        const result = await jds.fetchFromNetease(dotSymbol);
        if (!result || !result.currentPrice) return null;
        return {
          current: result.currentPrice,
          open: result.currentPrice,
          high: result.currentPrice,
          low: result.currentPrice,
          preClose: result.currentPrice,
          change: 0,
          changeRate: 0,
          volume: 0,
          amount: 0,
          source: 'netease_realtime',
        };
      },
    },
  ];

  for (const attempt of attempts) {
    try {
      const quote = await withTimeout(attempt.fn(), FETCH_TIMEOUT);
      if (quote) {
        logger.info(`Realtime quote from ${attempt.name}: ${rawSymbol} = ${quote.current}`);
        return quote;
      }
    } catch (err) {
      logger.debug(`Realtime ${attempt.name} failed for ${rawSymbol}: ${err.message}`);
    }
  }

  return null;
}

/**
 * Fetch kline data from alternative sources with ordered fallback.
 * Returns: { kline: [...], name, source } or null if all fail.
 *
 * Priority: EastMoney → Tencent → Sina → Netease → Yahoo
 */
async function fetchKlineData(rawSymbol, options = {}) {
  const jds = getJsDataSources();
  if (!jds) return null;

  const { code, market } = normalizeSymbol(rawSymbol);
  const dotSymbol = `${code}.${market}`;
  const { startDate, endDate, period } = options;

  const sources = [
    {
      name: 'EastMoney',
      fn: () => jds.fetchFromEastMoney(dotSymbol, { startDate, endDate, period }),
    },
    {
      name: 'Tencent',
      fn: () => jds.fetchFromTencent(dotSymbol, { startDate, endDate }),
    },
    {
      name: 'Sina',
      fn: () => fetchFromSina(rawSymbol, { startDate, endDate }),
    },
    {
      name: 'Netease',
      fn: () => jds.fetchFromNetease(dotSymbol, { startDate, endDate }),
    },
    {
      name: 'Yahoo',
      fn: () => jds.fetchFromYahoo(dotSymbol, { startDate, endDate }),
    },
  ];

  for (const src of sources) {
    try {
      const raw = await withTimeout(src.fn(), FETCH_TIMEOUT);
      const normalized = normalizeKline(raw);
      if (normalized && normalized.kline.length > 0) {
        logger.info(`Kline from ${src.name}: ${rawSymbol}, ${normalized.kline.length} bars`);
        return normalized;
      }
    } catch (err) {
      logger.debug(`Kline ${src.name} failed for ${rawSymbol}: ${err.message}`);
    }
  }

  logger.warn(`All alternative kline sources failed for ${rawSymbol}`);
  return null;
}

/**
 * Test which data sources are reachable. Returns a report object.
 */
async function testConnectivity() {
  const jds = getJsDataSources();
  const testSymbol = '000001.SH';
  const results = {};

  const sources = [
    { name: 'EastMoney', fn: () => jds.fetchFromEastMoney(testSymbol) },
    { name: 'Tencent', fn: () => jds.fetchFromTencent(testSymbol) },
    { name: 'Sina', fn: () => fetchFromSina('sh000001') },
    { name: 'Netease', fn: () => jds.fetchFromNetease(testSymbol) },
    { name: 'Yahoo', fn: () => jds.fetchFromYahoo(testSymbol) },
  ];

  for (const src of sources) {
    const start = Date.now();
    try {
      const raw = await withTimeout(src.fn(), 5000);
      const ok = raw && ((raw.kline && raw.kline.length > 0) || raw.currentPrice);
      results[src.name] = {
        accessible: !!ok,
        latencyMs: Date.now() - start,
        records: raw?.kline?.length || 0,
        error: ok ? null : 'empty response',
      };
    } catch (err) {
      results[src.name] = {
        accessible: false,
        latencyMs: Date.now() - start,
        records: 0,
        error: err.message,
      };
    }
  }

  return results;
}

module.exports = {
  fetchKlineData,
  fetchRealtimeQuote,
  testConnectivity,
  normalizeSymbol,
};
