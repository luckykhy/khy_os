/**
 * K-line Data Service — Data Source Priority
 *
 * Priority 1: AKShare
 * Priority 2: AData
 * Priority 3: Enhanced Mock Data
 *
 * Successful real data fetches are dual-written to PostgreSQL and SQLite.
 */
const { Op } = require('sequelize');
const moment = require('moment');
const cacheService = require('./cacheService');
const sqliteBackupService = require('./sqliteBackupService');
const networkDetector = require('./networkDetector');
const enhancedMockDataService = require('./enhancedMockDataService');
const logger = require('../utils/logger');

// Lazy-load to avoid circular deps
let KlineData = null;
function getKlineModel() {
  if (!KlineData) {
    try { KlineData = require('../models/KlineData'); } catch { KlineData = null; }
  }
  return KlineData;
}

let akshareDataService = null;
function getAkshare() {
  if (!akshareDataService) {
    try { akshareDataService = require('./akshareDataService'); } catch { akshareDataService = null; }
  }
  return akshareDataService;
}

let pythonDataSourceService = null;
function getPythonDataSourceService() {
  if (!pythonDataSourceService) {
    try { pythonDataSourceService = require('./pythonDataSourceService'); } catch { pythonDataSourceService = null; }
  }
  return pythonDataSourceService;
}

let tickDataAdapter = null;
function getTickDataAdapter() {
  if (!tickDataAdapter) {
    try { tickDataAdapter = require('./tickDataAdapter'); } catch { tickDataAdapter = null; }
  }
  return tickDataAdapter;
}

let futuresTickDataService = null;
function getFuturesTickService() {
  if (!futuresTickDataService) {
    try { futuresTickDataService = require('./futuresTickDataService'); } catch { futuresTickDataService = null; }
  }
  return futuresTickDataService;
}

/**
 * Detect instrument type from symbol.
 */
function detectInstrumentType(symbol) {
  if (!symbol) return 'stock';
  const s = symbol.replace(/^(sh|sz|SH|SZ)/, '');
  // Index: sh000001, 000300, 399001
  if (/^(000|399)\d{3}$/.test(s)) return 'index';
  // Futures: rb2410, IF2406, etc.
  if (/^[A-Za-z]{1,3}\d{3,4}$/.test(s) || /^(IF|IC|IH|IM)\d{4}$/.test(s)) return 'futures';
  return 'stock';
}

function inferDataTypeFromPeriod(period = 'daily') {
  const normalizedPeriod = String(period || '').toLowerCase();
  if (normalizedPeriod === 'tick') return 'tick';
  if (['1m', '5m', '15m', '30m', '60m', '1min', '5min', '15min', '30min', '60min', 'minute'].includes(normalizedPeriod)) {
    return 'minute';
  }
  return 'daily';
}

function normalizeDataType(dataType, period = 'daily') {
  const normalized = String(dataType || '').toLowerCase().trim();
  if (['daily', 'minute', 'tick'].includes(normalized)) return normalized;
  return inferDataTypeFromPeriod(period);
}

class KlineDataService {
  constructor() {
    // Initialize network detector on first use
    this._netInitDone = false;
  }

  async _ensureNetInit() {
    if (!this._netInitDone) {
      this._netInitDone = true;
      await networkDetector.init().catch(() => {});
    }
  }

  /**
   * Save kline data to PostgreSQL (bulk upsert).
   */
  async _writePostgres(symbol, name, period, klineArray) {
    const Model = getKlineModel();
    if (!Model) return { success: false, count: 0 };

    const records = klineArray.map(item => ({
      symbol,
      name,
      period,
      trade_date: item.time || item.date || item.trade_date,
      open_price: item.open,
      high_price: item.high,
      low_price: item.low,
      close_price: item.close,
      volume: item.volume,
      amount: item.amount || 0,
      change_amount: item.change || 0,
      change_percent: item.changePercent || item.change_percent || 0,
      turnover_rate: item.turnoverRate || item.turnover_rate || 0,
    }));

    const batchSize = 500;
    let total = 0;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const result = await Model.bulkCreate(batch, {
        updateOnDuplicate: [
          'name', 'open_price', 'high_price', 'low_price', 'close_price',
          'volume', 'amount', 'change_amount', 'change_percent', 'turnover_rate',
          'updated_at',
        ],
      });
      total += result.length;
    }
    return { success: true, count: total };
  }

  /**
   * Write kline data to SQLite backup.
   */
  _writeSQLite(symbol, period, klineArray) {
    try {
      sqliteBackupService.backupKlineData(symbol, period, klineArray);
    } catch { /* ignore */ }
  }

  /**
   * Public save API (backwards-compatible).
   */
  async saveKlineData(symbol, name, period, klineArray, options = {}) {
    const dataType = normalizeDataType(options?.dataType, period);
    const instrumentType = options?.instrumentType || detectInstrumentType(symbol);
    if (!klineArray || klineArray.length === 0) return { success: false, count: 0 };
    try {
      const [pgResult] = await Promise.all([
        this._writePostgres(symbol, name, period, klineArray).catch(() => ({ success: false, count: 0 })),
        Promise.resolve(this._writeSQLite(symbol, period, klineArray)),
      ]);
      return {
        ...pgResult,
        dataType,
        instrumentType
      };
    } catch (err) {
      logger.error('saveKlineData failed', { error: err.message });
      return { success: false, count: 0, error: err.message };
    }
  }

  /**
   * Read kline from PostgreSQL.
   */
  async _readPostgres(symbol, period, startDate, endDate, limit) {
    const Model = getKlineModel();
    if (!Model) return null;

    const where = { symbol, period };
    if (startDate || endDate) {
      where.trade_date = {};
      if (startDate) where.trade_date[Op.gte] = startDate;
      if (endDate) where.trade_date[Op.lte] = endDate;
    }

    const data = await Model.findAll({ where, order: [['trade_date', 'ASC']], limit });
    if (!data || data.length === 0) return null;

    return data.map(item => ({
      date: item.trade_date,
      open: parseFloat(item.open_price),
      high: parseFloat(item.high_price),
      low: parseFloat(item.low_price),
      close: parseFloat(item.close_price),
      volume: parseInt(item.volume),
      amount: parseFloat(item.amount),
      change: parseFloat(item.change_amount),
      changePercent: parseFloat(item.change_percent),
      turnoverRate: parseFloat(item.turnover_rate),
    }));
  }

  /**
   * Read kline from SQLite backup.
   */
  _readSQLite(symbol, period, startDate, endDate, limit) {
    try {
      const data = sqliteBackupService.getKlineData(symbol, period, startDate, endDate, limit);
      return data && data.length > 0 ? data : null;
    } catch {
      return null;
    }
  }

  _normalizeKlineRows(rows = [], dataType = 'daily') {
    const normalizedDataType = normalizeDataType(dataType);
    const timeFormat = normalizedDataType === 'daily' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm:ss';

    return rows
      .map((item) => {
        const day = item.time || item.date || item.trade_date || item.timestamp;
        if (!day) return null;

        const open = Number(item.open ?? item.open_price ?? 0);
        const high = Number(item.high ?? item.high_price ?? 0);
        const low = Number(item.low ?? item.low_price ?? 0);
        const close = Number(item.close ?? item.close_price ?? 0);
        const volume = Number(item.volume ?? item.vol ?? 0);
        const amount = Number(item.amount ?? item.turnover ?? 0);
        const change = Number(item.change ?? item.change_amount ?? (close - open));
        const changePercent = Number(item.changePercent ?? item.change_percent ?? (open > 0 ? (change / open) * 100 : 0));

        const date = moment(day).isValid() ? moment(day).format(timeFormat) : String(day).slice(0, normalizedDataType === 'daily' ? 10 : 19);
        return {
          time: date,
          date,
          timestamp: moment(day).isValid() ? moment(day).valueOf() : null,
          open: Number.isFinite(open) ? open : 0,
          high: Number.isFinite(high) ? high : 0,
          low: Number.isFinite(low) ? low : 0,
          close: Number.isFinite(close) ? close : 0,
          volume: Number.isFinite(volume) ? volume : 0,
          amount: Number.isFinite(amount) ? amount : 0,
          change: Number.isFinite(change) ? Number(change.toFixed(2)) : 0,
          changePercent: Number.isFinite(changePercent) ? Number(changePercent.toFixed(2)) : 0,
          turnoverRate: Number(item.turnoverRate ?? item.turnover_rate ?? 0) || 0
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  _applyDateRange(rows, startDate, endDate) {
    if (!startDate && !endDate) return rows;
    const start = startDate ? moment(startDate).startOf('day') : null;
    const end = endDate ? moment(endDate).endOf('day') : null;

    return rows.filter((row) => {
      const d = moment(row.date);
      if (!d.isValid()) return false;
      if (start && d.isBefore(start)) return false;
      if (end && d.isAfter(end)) return false;
      return true;
    });
  }

  _applyLimit(rows, period, limit) {
    const parsedLimit = Number.isFinite(limit) ? limit : parseInt(limit, 10);
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      return rows;
    }

    const effectiveLimit = period === 'daily' ? Math.max(100, parsedLimit) : parsedLimit;
    return rows.length > effectiveLimit ? rows.slice(-effectiveLimit) : rows;
  }

  /**
   * Priority 1: Fetch real data from AKShare.
   */
  async _fetchAkshare(symbol, period, startDate, endDate, limit) {
    const akshare = getAkshare();
    if (!akshare || typeof akshare.getStockData !== 'function') return null;

    const raw = await Promise.race([
      akshare.getStockData(symbol, period === 'daily' ? 'daily' : period),
      new Promise((_, rej) => setTimeout(() => rej(new Error('akshare timeout')), 90000))
    ]);

    const rows = this._normalizeKlineRows(raw?.kline || [], inferDataTypeFromPeriod(period));
    if (rows.length === 0) return null;

    const ranged = this._applyDateRange(rows, startDate, endDate);
    const limited = this._applyLimit(ranged, period, limit);
    if (limited.length === 0) return null;

    return { kline: limited, name: raw?.name || symbol, source: 'akshare' };
  }

  /**
   * Priority 2: Fetch real data from AData.
   */
  async _fetchAData(symbol, period, startDate, endDate, limit) {
    const python = getPythonDataSourceService();
    if (!python || typeof python.getKlineFromAData !== 'function') return null;

    const kType = period === 'weekly' ? 2 : period === 'monthly' ? 3 : 1;
    const effectiveStartDate = startDate || moment().subtract(5, 'years').format('YYYY-MM-DD');
    const raw = await Promise.race([
      python.getKlineFromAData(symbol, { kType, startDate: effectiveStartDate }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('adata timeout')), 12000))
    ]);

    const rawRows = Array.isArray(raw?.kline)
      ? raw.kline
      : Array.isArray(raw?.data?.kline)
        ? raw.data.kline
        : Array.isArray(raw)
          ? raw
          : [];

    const rows = this._normalizeKlineRows(rawRows, inferDataTypeFromPeriod(period));
    if (rows.length === 0) return null;

    const ranged = this._applyDateRange(rows, startDate, endDate);
    const limited = this._applyLimit(ranged, period, limit);
    if (limited.length === 0) return null;

    return { kline: limited, name: raw?.name || raw?.symbol || symbol, source: 'adata' };
  }

  /**
   * Get kline data with strict source order:
   * AKShare -> AData -> Enhanced Mock.
   */
  async getKlineData(symbol, period, startDate, endDate, limit = 1000, options = {}) {
    await this._ensureNetInit();

    const dataType = normalizeDataType(options?.dataType, period);
    const instrumentType = options?.instrumentType || detectInstrumentType(symbol);
    const cacheKey = `kline:${symbol}:${instrumentType}:${dataType}:${period}:${startDate || ''}:${endDate || ''}:${limit}`;
    const isRealtime = dataType !== 'daily' || ['1m', '5m', '15m', '30m', '60m'].includes(period);
    const cacheTTL = isRealtime ? 30 : 3600;

    const cached = await cacheService.get(cacheKey).catch(() => null);
    if (cached && Array.isArray(cached.kline) && cached.kline.length > 0 && !cached.isMock && !cached.isPartialMock) {
      return {
        kline: cached.kline,
        data_source: cached.source || 'cache',
        isMock: false,
        dataType: cached.dataType || dataType,
        instrumentType: cached.instrumentType || instrumentType
      };
    }
    if (Array.isArray(cached) && cached.length > 0) {
      return { kline: cached, data_source: 'cache', isMock: false, dataType, instrumentType };
    }

    // Tick adapter path (foundation only). Keep existing functionality intact when adapter is unavailable.
    if (dataType === 'tick') {
      try {
        const adapter = getTickDataAdapter();
        if (adapter && typeof adapter.fetchTicks === 'function') {
          const tickRows = await adapter.fetchTicks({
            symbol,
            startDate,
            endDate,
            limit,
            instrumentType
          });

          if (Array.isArray(tickRows) && tickRows.length > 0) {
            await cacheService.set(cacheKey, {
              kline: tickRows,
              source: 'tick_adapter',
              isMock: false,
              dataType,
              instrumentType
            }, cacheTTL).catch(() => {});
            return {
              kline: tickRows,
              tickData: tickRows,
              data_source: 'tick_adapter',
              isMock: false,
              dataType,
              instrumentType
            };
          }
        }
      } catch (error) {
        logger.warn('Tick adapter fetch failed', { symbol, error: error.message });
      }

      const tickMock = this._generateTickMock(symbol, limit);
      await cacheService.set(cacheKey, {
        kline: tickMock,
        source: 'tick_mock',
        isMock: true,
        dataType,
        instrumentType
      }, cacheTTL).catch(() => {});
      return {
        kline: tickMock,
        tickData: tickMock,
        data_source: 'tick_mock',
        isMock: true,
        dataType,
        instrumentType
      };
    }

    // Priority 0: Futures tick ZIP data (for futures symbols with intraday/daily periods)
    if (instrumentType === 'futures') {
      try {
        const ftSvc = getFuturesTickService();
        if (ftSvc) {
          const dates = await ftSvc.getAvailableDates();
          // Find applicable date(s)
          let targetDate = null;
          if (startDate) {
            const sd = startDate.replace(/-/g, '');
            targetDate = dates.find(d => d >= sd) || dates[dates.length - 1];
          } else {
            targetDate = dates[dates.length - 1]; // latest available
          }

          if (targetDate) {
            const symbols = await ftSvc.getAvailableSymbols(targetDate);
            // Resolve the actual symbol to query: direct match or _main -> dominant contract
            const resolvedSymbol = this._resolveFuturesSymbol(symbol, symbols);
            if (resolvedSymbol) {
              const ftPeriod = this._normalizeFuturesPeriod(period);
              const { bars, dataSource: ftSource } = await ftSvc.getKlineFromTicks(resolvedSymbol, targetDate, ftPeriod);
              if (bars && bars.length > 0) {
                const limited = this._applyLimit(bars, period, limit);
                await cacheService.set(cacheKey, {
                  kline: limited,
                  source: ftSource,
                  isMock: false,
                  dataType,
                  instrumentType
                }, 7200).catch(() => {});
                return {
                  kline: limited,
                  data_source: ftSource,
                  isMock: false,
                  dataType,
                  instrumentType
                };
              }
            }
          }
        }
      } catch (error) {
        logger.warn('Futures tick ZIP fetch failed, falling through', { symbol, error: error.message });
      }
    }

    // Priority 1: AKShare
    try {
      const akResult = await this._fetchAkshare(symbol, period, startDate, endDate, limit);
      if (akResult) {
        Promise.all([
          this._writePostgres(symbol, akResult.name, period, akResult.kline).catch(() => {}),
          Promise.resolve(this._writeSQLite(symbol, period, akResult.kline))
        ]).catch(() => {});
        await cacheService.set(cacheKey, {
          kline: akResult.kline,
          source: 'akshare',
          isMock: false,
          dataType,
          instrumentType
        }, cacheTTL).catch(() => {});
        return { kline: akResult.kline, data_source: 'akshare', isMock: false, dataType, instrumentType };
      }
    } catch (error) {
      logger.warn('AKShare fetch failed', { symbol, error: error.message });
    }

    // Priority 2: AData
    try {
      const adataResult = await this._fetchAData(symbol, period, startDate, endDate, limit);
      if (adataResult) {
        Promise.all([
          this._writePostgres(symbol, adataResult.name, period, adataResult.kline).catch(() => {}),
          Promise.resolve(this._writeSQLite(symbol, period, adataResult.kline))
        ]).catch(() => {});
        await cacheService.set(cacheKey, {
          kline: adataResult.kline,
          source: 'adata',
          isMock: false,
          dataType,
          instrumentType
        }, cacheTTL).catch(() => {});
        return { kline: adataResult.kline, data_source: 'adata', isMock: false, dataType, instrumentType };
      }
    } catch (error) {
      logger.warn('AData fetch failed', { symbol, error: error.message });
    }

    // Priority 2.5: Try database for partial real data before falling back to pure mock
    let dbData = null;
    try {
      dbData = await this._readPostgres(symbol, period, startDate, endDate, limit);
    } catch (pgErr) {
      logger.debug('Postgres read failed', { symbol, error: pgErr.message });
    }
    if (!dbData) {
      try {
        dbData = this._readSQLite(symbol, period, startDate, endDate, limit);
      } catch (sqlErr) {
        logger.debug('SQLite read failed', { symbol, error: sqlErr.message });
      }
    }

    if (dbData && dbData.length > 0) {
      // Have partial real data — fill gaps with mock data
      const needed = (limit || 1000) - dbData.length;
      if (needed > 0) {
        // Determine date range for mock fill: before the earliest real data point
        const earliest = dbData[0].date || dbData[0].time;
        const mockEnd = earliest ? moment(earliest).subtract(1, 'day').format('YYYY-MM-DD') : startDate;
        const mockData = this._generateEnhancedMock(symbol, period, startDate, mockEnd, needed);
        if (mockData && mockData.length > 0) {
          // Prepend mock data before real data
          const combined = [...mockData, ...dbData].slice(0, limit || 1000);
          logger.info('Combined DB real data + mock fill', {
            symbol,
            realCount: dbData.length,
            mockFillCount: mockData.length,
            totalCount: combined.length
          });
          return { kline: combined, data_source: 'db+mock_fill', isMock: true, isPartialMock: true, dataType, instrumentType };
        }
      }
      // Enough real data from DB, no mock needed
      await cacheService.set(cacheKey, {
        kline: dbData,
        source: 'database',
        isMock: false,
        dataType,
        instrumentType
      }, cacheTTL).catch(() => {});
      return { kline: dbData, data_source: 'database', isMock: false, dataType, instrumentType };
    }

    // Priority 3: Enhanced mock — never cache mock data so real sources are retried next request
    const mock = this._generateEnhancedMock(symbol, period, startDate, endDate, limit);
    return { kline: mock, data_source: 'enhanced_mock', isMock: true, dataType, instrumentType };
  }

  _generateEnhancedMock(symbol, period, startDate, endDate, limit) {
    try {
      return enhancedMockDataService.generateEnhancedKLineData({
        symbol,
        period: period || 'daily',
        startDate: startDate || null,
        endDate: endDate || null,
        limit: Number.isFinite(limit) ? limit : parseInt(limit, 10) || 1000
      });
    } catch (error) {
      logger.warn('Enhanced mock generation failed', {
        symbol,
        period,
        startDate,
        endDate,
        error: error.message
      });
      return this._generateRealisticMock(symbol, limit);
    }
  }

  _generateTickMock(symbol, countOrLimit = 1000) {
    const limit = Math.max(100, Number.parseInt(countOrLimit, 10) || 1000);
    const ticks = [];
    const now = moment();
    let lastPrice = detectInstrumentType(symbol) === 'futures' ? 3800 : 12;
    let cumulativeVolume = 0;
    let openInterest = 120000;

    for (let i = limit; i > 0; i--) {
      const timestamp = now.clone().subtract(i, 'seconds');
      const move = (Math.random() - 0.5) * (lastPrice * 0.0008);
      const price = Math.max(0.01, lastPrice + move);
      const spread = Math.max(0.01, price * 0.0002);
      const bidPrice = Number((price - spread / 2).toFixed(4));
      const askPrice = Number((price + spread / 2).toFixed(4));
      const tradeVolume = Math.floor(Math.random() * 30) + 1;
      const bidVolume = Math.floor(Math.random() * 100) + 10;
      const askVolume = Math.floor(Math.random() * 100) + 10;

      cumulativeVolume += tradeVolume;
      openInterest += Math.floor((Math.random() - 0.5) * 8);

      ticks.push({
        timestamp: timestamp.valueOf(),
        time: timestamp.format('YYYY-MM-DD HH:mm:ss.SSS'),
        bidPrice,
        askPrice,
        bidVolume,
        askVolume,
        lastPrice: Number(price.toFixed(4)),
        volume: cumulativeVolume,
        openInterest: Math.max(0, openInterest)
      });

      lastPrice = price;
    }

    return ticks;
  }

  // ──────── Realistic Mock Data (A3) ────────────────────────────────────────

  /**
   * Get last known close price from DB for a symbol (public API).
   * @param {string} symbol
   * @returns {Promise<number|null>}
   */
  async getLastClosePrice(symbol) {
    return this._getLastKnownPrice(symbol);
  }

  /**
   * Get last known close price from DB for a symbol.
   * @private
   */
  async _getLastKnownPrice(symbol) {
    try {
      const Model = getKlineModel();
      if (!Model) return null;
      const row = await Model.findOne({
        where: { symbol },
        order: [['trade_date', 'DESC']],
        attributes: ['close_price'],
      });
      return row ? parseFloat(row.close_price) : null;
    } catch {
      return null;
    }
  }

  /**
   * Generate realistic mock kline data.
   * - Index (sh000001 etc): per-symbol realistic base, +/-1.5% daily
   * - Stock: last known DB price as base, +/-2% daily
   * - Futures (rb*): base 3800, +/-3% daily
   * - OHLCV: high=close*1.005, low=close*0.995, realistic volume
   */
  _generateRealisticMock(symbol, count = 500) {
    try {
      return enhancedMockDataService.generateEnhancedKLineData({
        symbol,
        period: 'daily',
        limit: Math.max(100, parseInt(count, 10) || 500)
      });
    } catch {
      // fallback to legacy in-method generator
    }

    const type = detectInstrumentType(symbol);
    let basePrice, volatility, baseVolume;

    // Per-symbol realistic 2026 fallback prices
    const symbolPrices = {
      'sh000300': 4660, '000300': 4660, 'sh000001': 3350, '000001': 3350,
      'sz399001': 10800, '399001': 10800, 'sz399006': 2100, '399006': 2100,
      'sh600519': 1680, '600519': 1680, 'sh600036': 38, '600036': 38,
      'sz000001': 11, 'sz000858': 148, '000858': 148,
      'sh600000': 7.8, '600000': 7.8, 'sh601318': 52, '601318': 52,
      'sz002594': 280, '002594': 280, 'sz000002': 8.5, '000002': 8.5,
    };
    const clean = symbol.replace(/^(sh|sz)/i, '');
    const knownPrice = symbolPrices[symbol] || symbolPrices[clean];

    switch (type) {
      case 'index':
        basePrice = knownPrice || 4660;
        volatility = 0.015;
        baseVolume = 250000000;
        break;
      case 'futures':
        basePrice = knownPrice || 3800;
        volatility = 0.03;
        baseVolume = 800000;
        break;
      default: // stock
        basePrice = knownPrice || 15.0;
        volatility = 0.02;
        baseVolume = 5000000;
        break;
    }

    // Try to use last known DB price for stocks
    // (sync fallback — async version attempted but mock must be sync here)
    if (type === 'stock') {
      try {
        const sqliteData = sqliteBackupService.getKlineData(symbol, 'daily', null, null, 1);
        if (sqliteData && sqliteData.length > 0 && sqliteData[0].close) {
          basePrice = sqliteData[0].close;
        }
      } catch { /* use default */ }
    }

    // Ensure we generate enough calendar days to produce at least 250 trading days
    const minTradingDays = 250;
    const calendarDays = Math.max(count, Math.ceil(minTradingDays * 7 / 5) + 10);

    const data = [];
    let price = basePrice;
    const now = moment();

    for (let i = calendarDays; i > 0; i--) {
      const date = now.clone().subtract(i, 'days').format('YYYY-MM-DD');
      // Skip weekends for realism
      const dow = now.clone().subtract(i, 'days').day();
      if (dow === 0 || dow === 6) continue;

      const dailyChange = (Math.random() - 0.5) * 2 * volatility;
      const close = parseFloat((price * (1 + dailyChange)).toFixed(2));
      const open = parseFloat(price.toFixed(2));
      const high = parseFloat((Math.max(open, close) * 1.005).toFixed(2));
      const low = parseFloat((Math.min(open, close) * 0.995).toFixed(2));
      const volume = Math.floor(baseVolume * (0.6 + Math.random() * 0.8));
      const amount = parseFloat((volume * (high + low) / 2).toFixed(2));
      const change = parseFloat((close - open).toFixed(2));
      const changePercent = parseFloat(((change / open) * 100).toFixed(2));

      data.push({
        time: date,
        date,
        open,
        high,
        low,
        close,
        volume,
        amount,
        change,
        changePercent,
        turnoverRate: 0,
      });

      price = close;
    }

    return data;
  }

  // Backwards-compatible alias
  _generateMockKline(symbol, countOrOptions = 500) {
    if (countOrOptions && typeof countOrOptions === 'object') {
      const { period = 'daily', startDate = null, endDate = null, limit = 500 } = countOrOptions;
      return this._generateEnhancedMock(symbol, period, startDate, endDate, limit);
    }

    return this._generateRealisticMock(symbol, countOrOptions);
  }

  /**
   * Map period strings to futuresTickDataService format.
   */
  /**
   * Resolve a symbol against available futures symbols.
   * Handles: direct match, _main suffix (dominant contract), and 8888/9999 aliases.
   * For xx_main symbols, picks the contract with the largest volume (dominant).
   * Returns the resolved symbol or null if not found.
   */
  _resolveFuturesSymbol(symbol, availableSymbols) {
    const upper = symbol.toUpperCase();
    // Direct match
    if (availableSymbols.includes(upper)) return upper;

    // Handle _main / _MAIN suffix: e.g. rb_main -> RB + pick dominant
    const mainMatch = upper.match(/^([A-Z]+)[-_]?MAIN$/i);
    if (mainMatch) {
      const prefix = mainMatch[1].toUpperCase();
      // Try 8888 first (exchange main contract continuous)
      if (availableSymbols.includes(`${prefix}8888`)) return `${prefix}8888`;
      // Try 9999 (index continuous)
      if (availableSymbols.includes(`${prefix}9999`)) return `${prefix}9999`;
      // Fall back: find all contracts for this product, pick by nearest active month
      const candidates = availableSymbols.filter(s => {
        const m = s.match(/^([A-Z]+)(\d{4})$/);
        return m && m[1] === prefix && !['8888', '9998', '9999'].includes(m[2]);
      });
      if (candidates.length > 0) {
        // Sort by contract month, pick nearest future month
        candidates.sort();
        return candidates[0];
      }
    }

    // Handle plain product code without month: e.g. "rb" -> try rb8888/rb9999/first
    if (/^[A-Z]+$/i.test(upper) && upper.length <= 3) {
      if (availableSymbols.includes(`${upper}8888`)) return `${upper}8888`;
      if (availableSymbols.includes(`${upper}9999`)) return `${upper}9999`;
    }

    return null;
  }

  _normalizeFuturesPeriod(period) {
    const map = {
      'daily': '1d', '1d': '1d', 'day': '1d',
      '1min': '1m', '1m': '1m', 'minute': '1m',
      '5min': '5m', '5m': '5m',
      '15min': '15m', '15m': '15m',
      '30min': '30m', '30m': '30m',
      '60min': '1h', '1h': '1h', 'hour': '1h',
    };
    const key = String(period || '').toLowerCase();
    return map[key] || '1m';
  }

  // ──────── Utility methods ─────────────────────────────────────────────────

  async getLatestDate(symbol, period) {
    try {
      const Model = getKlineModel();
      if (!Model) return null;
      const latest = await Model.findOne({
        where: { symbol, period },
        order: [['trade_date', 'DESC']],
        attributes: ['trade_date'],
      });
      return latest ? latest.trade_date : null;
    } catch (err) {
      logger.error('getLatestDate failed', { error: err.message });
      return null;
    }
  }

  async needsUpdate(symbol, period) {
    const latestDate = await this.getLatestDate(symbol, period);
    if (!latestDate) return true;
    return moment(latestDate).format('YYYY-MM-DD') !== moment().format('YYYY-MM-DD');
  }

  async getDataStats(symbol, period) {
    try {
      const { sequelize } = require('../config/database');
      const Model = getKlineModel();
      if (!Model) return null;
      return await Model.findOne({
        where: { symbol, period },
        attributes: [
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
          [sequelize.fn('MIN', sequelize.col('trade_date')), 'earliest_date'],
          [sequelize.fn('MAX', sequelize.col('trade_date')), 'latest_date'],
        ],
        raw: true,
      });
    } catch (err) {
      logger.error('getDataStats failed', { error: err.message });
      return null;
    }
  }
}

module.exports = new KlineDataService();
