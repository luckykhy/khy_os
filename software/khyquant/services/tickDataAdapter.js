/**
 * Tick Data Adapter
 *
 * Bridges tick data requests from klineDataService to the
 * futuresTickDataService (ZIP-based tick data store).
 */
const logger = require('../utils/logger');

let futuresTickDataService = null;

function getFuturesService() {
  if (!futuresTickDataService) {
    try { futuresTickDataService = require('./futuresTickDataService'); }
    catch { futuresTickDataService = null; }
  }
  return futuresTickDataService;
}

class TickDataAdapter {
  constructor() {
    this.adapterName = 'tick-adapter-futures-zip';
  }

  static requiredFields() {
    return [
      'timestamp',
      'bidPrice',
      'askPrice',
      'bidVolume',
      'askVolume',
      'lastPrice',
      'volume',
      'openInterest'
    ];
  }

  validateTickRecord(record = {}) {
    return TickDataAdapter.requiredFields().every(
      (field) => record[field] !== undefined && record[field] !== null
    );
  }

  normalizeTickRecord(record = {}) {
    return {
      timestamp: Number(record.timestamp),
      bidPrice: Number(record.bidPrice),
      askPrice: Number(record.askPrice),
      bidVolume: Number(record.bidVolume),
      askVolume: Number(record.askVolume),
      lastPrice: Number(record.lastPrice),
      volume: Number(record.volume),
      openInterest: Number(record.openInterest)
    };
  }

  /**
   * Fetch tick data for a symbol.
   * Tries futures ZIP data first; throws if unavailable.
   */
  async fetchTicks(options = {}) {
    const { symbol, startDate, endDate, limit } = options;
    if (!symbol) throw new Error('symbol is required');

    const svc = getFuturesService();
    if (!svc) throw new Error(`Tick data adapter: futuresTickDataService unavailable for ${symbol}`);

    const dates = await svc.getAvailableDates();
    if (dates.length === 0) {
      throw new Error(`Tick data adapter: no ZIP data available for ${symbol}`);
    }

    let targetDates = dates;
    if (startDate || endDate) {
      const sd = (startDate || '').replace(/-/g, '');
      const ed = (endDate || '99999999').replace(/-/g, '');
      targetDates = dates.filter(d => d >= sd && d <= ed);
    }

    if (targetDates.length === 0) {
      throw new Error(`Tick data adapter: no data in requested date range for ${symbol}`);
    }

    for (const date of targetDates) {
      const symbols = await svc.getAvailableSymbols(date);
      if (symbols.includes(symbol.toUpperCase())) {
        const { ticks } = await svc.getTickData(symbol, date);
        const result = ticks.map(t => this.normalizeTickRecord(t));
        return limit > 0 ? result.slice(0, limit) : result;
      }
    }

    throw new Error(`Tick data adapter: symbol ${symbol} not found in available ZIP data`);
  }
}

module.exports = new TickDataAdapter();
