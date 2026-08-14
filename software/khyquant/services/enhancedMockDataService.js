const moment = require('moment');

// 各周期对应的分钟数
const PERIOD_MINUTES = {
  '1m': 1, '1min': 1,
  '5m': 5, '5min': 5,
  '15m': 15, '15min': 15,
  '30m': 30, '30min': 30,
  '1h': 60, '60m': 60, '60min': 60,
  'daily': 0, '1d': 0, 'day': 0,
  'weekly': 0, 'monthly': 0,
};

// A股交易时段（分钟线用）
const TRADING_SESSIONS = [
  { start: '09:30', end: '11:30' },
  { start: '13:00', end: '15:00' },
];

/**
 * 生成某交易日内所有交易时间点（按 intervalMinutes 间隔）
 */
function getTradingMinutes(dateStr, intervalMinutes) {
  const times = [];
  for (const session of TRADING_SESSIONS) {
    let cur = moment(`${dateStr} ${session.start}`, 'YYYY-MM-DD HH:mm');
    const end = moment(`${dateStr} ${session.end}`, 'YYYY-MM-DD HH:mm');
    while (cur.isSameOrBefore(end)) {
      times.push(cur.format('YYYY-MM-DD HH:mm'));
      cur.add(intervalMinutes, 'minutes');
    }
  }
  return times;
}

/**
 * 判断是否是分钟/小时级别周期
 */
function isIntradayPeriod(period) {
  return PERIOD_MINUTES[period] > 0;
}

class EnhancedMockDataService {
  /**
   * Generate enhanced K-line mock data.
   * Rules:
   * - no startDate => 5 years ago (daily) / last 5 trading days (intraday)
   * - daily data always contains at least 100 points
   * - intraday data generates correct time-based candles
   */
  generateEnhancedKLineData({
    symbol = 'sh000300',
    period = 'daily',
    startDate = null,
    endDate = null,
    limit = 1000
  } = {}) {
    try {
      return this._generateEnhancedKLineDataInner({ symbol, period, startDate, endDate, limit });
    } catch (error) {
      console.error('EnhancedMockDataService error, using fallback:', error.message);
      return this._generateByCount(symbol || 'sh000300', period || 'daily', Math.max(100, Math.min(limit || 200, 1200)));
    }
  }

  _generateEnhancedKLineDataInner({ symbol, period, startDate, endDate, limit }) {
    const intervalMinutes = PERIOD_MINUTES[period] || 0;

    // 分钟/小时线：按交易时段生成
    if (intervalMinutes > 0) {
      return this._generateIntradayData(symbol, period, intervalMinutes, startDate, endDate, limit);
    }

    // 日线及以上：原有逻辑
    return this._generateDailyData(symbol, period, startDate, endDate, limit);
  }

  /**
   * 生成分钟/小时级别 K 线（按真实交易时段）
   */
  _generateIntradayData(symbol, period, intervalMinutes, startDate, endDate, limit) {
    const today = moment().startOf('day');
    const seed = this._getSeed(this._detectType(symbol), symbol);
    let current = seed.basePrice;

    // 默认取最近5个交易日
    const defaultDays = Math.max(5, Math.ceil((limit * intervalMinutes) / (240)));
    const effectiveEnd = endDate ? moment(endDate).startOf('day') : today.clone();
    const effectiveStart = startDate
      ? moment(startDate).startOf('day')
      : effectiveEnd.clone().subtract(defaultDays, 'days');

    const rows = [];
    const maxRows = Math.max(50, Math.min(limit || 500, 3000));

    let cursor = effectiveStart.clone();
    while (cursor.isSameOrBefore(effectiveEnd) && rows.length < maxRows) {
      // 跳过周末
      if (cursor.day() === 0 || cursor.day() === 6) {
        cursor.add(1, 'day');
        continue;
      }

      const dateStr = cursor.format('YYYY-MM-DD');
      const times = getTradingMinutes(dateStr, intervalMinutes);

      for (const timeStr of times) {
        if (rows.length >= maxRows) break;
        const candle = this._nextCandle(current, seed.volatility, seed.volumeBase, moment(timeStr, 'YYYY-MM-DD HH:mm'), rows.length);
        // 分钟线 time 字段包含时间
        candle.time = timeStr;
        candle.date = timeStr;
        rows.push(candle);
        current = candle.close;
      }

      cursor.add(1, 'day');
    }

    return rows;
  }

  /**
   * 生成日线数据（原有逻辑）
   */
  _generateDailyData(symbol, period, startDate, endDate, limit) {
    const today = moment().startOf('day');
    const defaultStart = today.clone().subtract(5, 'years');
    const effectiveEnd = endDate ? moment(endDate).startOf('day') : today.clone();

    let effectiveStart = defaultStart.clone();
    let usedProvidedStart = false;
    if (startDate) {
      const providedStart = moment(startDate).startOf('day');
      const daysDistance = Math.abs(today.diff(providedStart, 'days'));
      if (providedStart.isValid() && daysDistance >= 30) {
        effectiveStart = providedStart;
        usedProvidedStart = true;
      }
    }

    if (!effectiveStart.isValid()) effectiveStart = defaultStart.clone();
    if (!effectiveEnd.isValid() || effectiveEnd.isBefore(effectiveStart)) {
      return this._generateByCount(symbol, period, Math.max(100, Math.min(limit, 1200)));
    }

    const rows = [];
    const type = this._detectType(symbol);
    const seed = this._getSeed(type, symbol);
    let current = seed.basePrice;
    let cursor = effectiveStart.clone();
    const maxRows = Math.max(100, Math.min(limit || 1000, 2500));

    while ((cursor.isBefore(effectiveEnd) || cursor.isSame(effectiveEnd, 'day')) && rows.length < maxRows) {
      if (cursor.day() === 0 || cursor.day() === 6) {
        cursor.add(1, 'day');
        continue;
      }

      const candle = this._nextCandle(current, seed.volatility, seed.volumeBase, cursor, rows.length);
      rows.push(candle);
      current = candle.close;
      cursor.add(1, 'day');
    }

    if (period === 'daily' && rows.length < 100) {
      const missing = 100 - rows.length;
      if (usedProvidedStart) {
        const append = this._generateFutureSuffix(rows[rows.length - 1], missing, seed);
        return [...rows, ...append];
      }
      const prepend = this._generateHistoryPrefix(rows[0], missing, seed, symbol);
      return [...prepend, ...rows];
    }

    return rows;
  }

  _generateHistoryPrefix(firstRow, count, seed) {
    const rows = [];
    let current = firstRow ? Number(firstRow.open) : seed.basePrice;
    let cursor = firstRow ? moment(firstRow.date).subtract(1, 'day') : moment().subtract(1, 'day');

    while (rows.length < count) {
      if (cursor.day() === 0 || cursor.day() === 6) {
        cursor.subtract(1, 'day');
        continue;
      }
      const candle = this._nextCandle(current, seed.volatility, seed.volumeBase, cursor, rows.length);
      rows.unshift(candle);
      current = candle.open;
      cursor.subtract(1, 'day');
    }

    return rows;
  }

  _generateFutureSuffix(lastRow, count, seed) {
    const rows = [];
    let current = lastRow ? Number(lastRow.close) : seed.basePrice;
    let cursor = lastRow ? moment(lastRow.date).add(1, 'day') : moment().add(1, 'day');

    while (rows.length < count) {
      if (cursor.day() === 0 || cursor.day() === 6) {
        cursor.add(1, 'day');
        continue;
      }
      const candle = this._nextCandle(current, seed.volatility, seed.volumeBase, cursor, rows.length);
      rows.push(candle);
      current = candle.close;
      cursor.add(1, 'day');
    }

    return rows;
  }

  _generateByCount(symbol, period, count) {
    const seed = this._getSeed(this._detectType(symbol), symbol);
    const rows = [];
    let current = seed.basePrice;
    let cursor = moment().startOf('day').subtract(count + 30, 'day');

    while (rows.length < count) {
      if (period === 'daily' && (cursor.day() === 0 || cursor.day() === 6)) {
        cursor.add(1, 'day');
        continue;
      }
      const candle = this._nextCandle(current, seed.volatility, seed.volumeBase, cursor, rows.length);
      rows.push(candle);
      current = candle.close;
      cursor.add(1, 'day');
    }

    return rows;
  }

  _nextCandle(prevClose, volatility, volumeBase, date, idx) {
    const cyclic = Math.sin((idx % 30) / 30 * Math.PI * 2) * volatility * 0.35;
    const random = (Math.random() - 0.5) * volatility * 1.2;
    const drift = cyclic + random;

    const open = Number(prevClose.toFixed(2));
    const close = Number(Math.max(0.1, open * (1 + drift)).toFixed(2));
    const high = Number((Math.max(open, close) * (1 + Math.random() * volatility * 0.6)).toFixed(2));
    const low = Number((Math.min(open, close) * (1 - Math.random() * volatility * 0.6)).toFixed(2));
    const volume = Math.floor(volumeBase * (0.65 + Math.random() * 0.9));
    const amount = Number((volume * ((high + low) / 2)).toFixed(2));
    const change = Number((close - open).toFixed(2));
    const changePercent = Number(((change / Math.max(open, 0.01)) * 100).toFixed(2));

    const day = date.format('YYYY-MM-DD');
    return {
      time: day,
      date: day,
      open,
      high,
      low,
      close,
      volume,
      amount,
      change,
      changePercent,
      turnoverRate: 0
    };
  }

  _detectType(symbol) {
    if (!symbol) return 'stock';
    const s = symbol.replace(/^(sh|sz|SH|SZ)/, '');
    if (/^(000|399)\d{3}$/.test(s)) return 'index';
    if (/^[A-Za-z]{1,3}\d{3,4}$/.test(s) || /^(IF|IC|IH|IM)\d{4}$/.test(s)) return 'futures';
    return 'stock';
  }

  _getSeed(type, symbol) {
    // Per-symbol base prices (realistic 2026 values)
    const symbolPrices = {
      'sh000300': { basePrice: 4660, volatility: 0.012, volumeBase: 200000000 },
      'sh000001': { basePrice: 3350, volatility: 0.012, volumeBase: 350000000 },
      'sz399001': { basePrice: 10800, volatility: 0.014, volumeBase: 280000000 },
      'sz399006': { basePrice: 2100, volatility: 0.018, volumeBase: 120000000 },
      'sh000016': { basePrice: 2750, volatility: 0.012, volumeBase: 80000000 },
      'sh000688': { basePrice: 1050, volatility: 0.018, volumeBase: 60000000 },
      'sh000852': { basePrice: 6200, volatility: 0.016, volumeBase: 90000000 },
      'sh000905': { basePrice: 5100, volatility: 0.015, volumeBase: 100000000 },
      'sh600519': { basePrice: 1680, volatility: 0.018, volumeBase: 3500000 },
      'sh600036': { basePrice: 38, volatility: 0.018, volumeBase: 25000000 },
      'sh600000': { basePrice: 7.8, volatility: 0.02, volumeBase: 30000000 },
      'sz000001': { basePrice: 11, volatility: 0.02, volumeBase: 40000000 },
      'sz000858': { basePrice: 148, volatility: 0.02, volumeBase: 8000000 },
      'sz000002': { basePrice: 8.5, volatility: 0.025, volumeBase: 50000000 },
      'sz002594': { basePrice: 280, volatility: 0.022, volumeBase: 6000000 },
      'sh601318': { basePrice: 52, volatility: 0.018, volumeBase: 20000000 },
      'sh601398': { basePrice: 5.8, volatility: 0.015, volumeBase: 80000000 },
      'rb_main': { basePrice: 3380, volatility: 0.02, volumeBase: 1500000 },
      'rb2510': { basePrice: 3380, volatility: 0.02, volumeBase: 1200000 },
    };

    // Try exact match first, then strip prefix for partial match
    const clean = symbol ? symbol.replace(/^(sh|sz|SH|SZ)/, '') : '';
    const match = symbolPrices[symbol] || symbolPrices['sh' + clean] || symbolPrices['sz' + clean];
    if (match) return match;

    if (type === 'index') {
      return { basePrice: 4660, volatility: 0.012, volumeBase: 180000000 };
    }
    if (type === 'futures') {
      return { basePrice: 3800, volatility: 0.025, volumeBase: 1200000 };
    }
    return { basePrice: 15, volatility: 0.02, volumeBase: 5500000 };
  }
}

module.exports = new EnhancedMockDataService();
