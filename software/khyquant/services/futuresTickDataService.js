/**
 * Futures Tick Data Service
 *
 * Multi-source data loading from the futures data directory.
 * Supports both ZIP archives and extracted date folders.
 *
 * ─── Layout A: Period-First (recommended) ───
 *   数据源/csv自制期货数据/
 *   ├── Tick/
 *   │   ├── 20260421.zip          (ZIP containing YYYYMMDD/SYMBOL.csv or SYMBOL.csv)
 *   │   ├── 20260421/SYMBOL.csv   (date folder with CSVs)
 *   │   └── SYMBOL.csv            (loose CSV — date inferred from first data row)
 *   ├── 1m/
 *   │   ├── 20260401.zip
 *   │   └── 20260401/SYMBOL.csv
 *   ├── 5m/ 15m/ 30m/ 1h/ 1d/
 *   └── ...
 *
 * ─── Layout B: Date-First (legacy, still supported) ───
 *   数据源/csv自制期货数据/
 *   ├── 20260421.zip
 *   ├── 20260421/
 *   │   ├── tick/SYMBOL.csv
 *   │   ├── 1m/SYMBOL.csv
 *   │   └── ...
 *   └── ...
 *
 * Priority chain for kline data:
 *   1. Period-first folder/ZIP      →  dataSource: "futures-{period}-folder" / "futures-{period}-zip"
 *   2. Legacy pre-aggregated folder →  dataSource: "futures-tick-precomputed-{period}"
 *   3. Aggregate from tick data     →  dataSource: "futures-tick-aggregated" / "futures-tick-zip"
 *   4. No data available            →  dataSource: "no-data"
 */

const fs = require('fs');
const path = require('path');
const StreamZip = require('node-stream-zip');
const logger = require('../utils/logger');

const TRADE_TYPE_MAP = {
  1: 'dual_open',
  2: 'dual_close',
  3: 'long_open',
  4: 'short_open',
  5: 'short_close',
  6: 'long_close',
  7: 'long_swap',
  8: 'short_swap',
};

const KNOWN_PERIODS = ['tick', '1m', '5m', '15m', '30m', '1h', '1d'];

// Map directory names (case-insensitive) to canonical period keys
const PERIOD_DIR_MAP = {
  'tick': 'tick', 'ticks': 'tick',
  '1m': '1m', '1min': '1m',
  '5m': '5m', '5min': '5m',
  '15m': '15m', '15min': '15m',
  '30m': '30m', '30min': '30m',
  '1h': '1h', '60m': '1h', '60min': '1h',
  '1d': '1d', 'daily': '1d', 'day': '1d',
};

class FuturesTickDataService {
  constructor() {
    const defaultDir = path.resolve(__dirname, '../../../数据源/csv自制期货数据');
    this.dataDir = process.env.FUTURES_TICK_DATA_DIR || defaultDir;
    // Index: { date: { zipPath, folderPath, symbols, periods: { tick, 1m, ... } } }
    this._index = {};
    this._indexBuilt = false;
    this._cache = new Map();
    this._cacheMaxSize = 30;
  }

  // ─── Index Management ────────────────────────────────────────────────

  /**
   * Scan the data directory for all data sources (folders + ZIPs).
   * Auto-detects layout: period-first (Tick/, 1m/, ...) vs date-first (legacy).
   */
  async scanDataSources() {
    this._index = {};

    if (!fs.existsSync(this.dataDir)) {
      logger.warn(`[FuturesTick] Data directory not found: ${this.dataDir}`);
      this._indexBuilt = true;
      return;
    }

    const items = fs.readdirSync(this.dataDir);

    // Detect layout: check if any top-level directory matches a period name
    const periodDirsFound = items.filter(item => {
      const lower = item.toLowerCase();
      return PERIOD_DIR_MAP[lower] && fs.statSync(path.join(this.dataDir, item)).isDirectory();
    });

    if (periodDirsFound.length > 0) {
      // ─── Layout A: Period-First ───
      logger.info(`[FuturesTick] Detected PERIOD-FIRST layout (${periodDirsFound.join(', ')})`);
      for (const dirName of periodDirsFound) {
        const periodKey = PERIOD_DIR_MAP[dirName.toLowerCase()];
        const dirPath = path.join(this.dataDir, dirName);
        await this._scanPeriodDir(periodKey, dirPath);
      }
    } else {
      // ─── Layout B: Date-First (legacy) ───
      logger.info(`[FuturesTick] Detected DATE-FIRST layout (legacy)`);
      // Pass 1: Scan extracted date folders
      for (const item of items) {
        const fullPath = path.join(this.dataDir, item);
        if (!fs.statSync(fullPath).isDirectory()) continue;
        if (!/^\d{8}$/.test(item)) continue;

        const date = item;
        this._index[date] = this._index[date] || this._makeEmptyEntry();
        this._index[date].folderPath = fullPath;
        this._scanFolder(date, fullPath);
      }

      // Pass 2: Scan ZIP files
      const zipFiles = items.filter(f => /^\d{8}\.zip$/.test(f));
      for (const zipFile of zipFiles) {
        const date = zipFile.replace('.zip', '');
        const zipPath = path.join(this.dataDir, zipFile);

        this._index[date] = this._index[date] || this._makeEmptyEntry();
        this._index[date].zipPath = zipPath;

        if (this._index[date].symbols.length === 0) {
          await this._scanZip(date, zipPath);
        } else {
          await this._scanZip(date, zipPath, true);
        }
      }
    }

    this._indexBuilt = true;

    for (const [date, entry] of Object.entries(this._index)) {
      const sources = [];
      if (entry.folderPath) sources.push('folder');
      if (entry.zipPath) sources.push('zip');
      const pSrcs = Object.keys(entry.periodSources || {});
      if (pSrcs.length > 0) sources.push(`period-first(${pSrcs.join(',')})`);
      const availPeriods = Object.entries(entry.periods)
        .filter(([, v]) => v)
        .map(([k]) => k);
      logger.info(`[FuturesTick] ${date}: ${entry.symbols.length} symbols, sources=[${sources}], periods=[${availPeriods}]`);
    }

    // Auto-import all symbols into instrument table (fire-and-forget)
    this.syncSymbolsToInstruments().catch(err => {
      logger.error(`[FuturesTick] Symbol sync failed: ${err.message}`);
    });
  }

  /**
   * Scan a period-first directory (e.g., Tick/, 1m/, 15m/).
   * Inside: YYYYMMDD.zip, YYYYMMDD/ folders, or loose SYMBOL.csv files.
   */
  async _scanPeriodDir(period, dirPath) {
    const items = fs.readdirSync(dirPath);

    // 1. Date folders (YYYYMMDD/)
    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      if (!fs.statSync(fullPath).isDirectory()) continue;
      if (!/^\d{8}$/.test(item)) continue;

      const date = item;
      this._index[date] = this._index[date] || this._makeEmptyEntry();
      const entry = this._index[date];
      entry.periods[period] = true;

      if (!entry.periodSources[period]) {
        entry.periodSources[period] = { zipPath: null, folderPath: null, looseFiles: [], symbols: [] };
      }
      entry.periodSources[period].folderPath = fullPath;

      const csvFiles = fs.readdirSync(fullPath).filter(f => f.endsWith('.csv'));
      const symbolSet = new Set(entry.periodSources[period].symbols);
      for (const csv of csvFiles) {
        symbolSet.add(csv.replace('.csv', '').toUpperCase());
      }
      entry.periodSources[period].symbols = Array.from(symbolSet).sort();
      this._mergeSymbols(entry);
    }

    // 2. ZIP files (YYYYMMDD.zip)
    const zipFiles = items.filter(f => /^\d{8}\.zip$/.test(f));
    for (const zipFile of zipFiles) {
      const date = zipFile.replace('.zip', '');
      const zipPath = path.join(dirPath, zipFile);

      this._index[date] = this._index[date] || this._makeEmptyEntry();
      const entry = this._index[date];
      entry.periods[period] = true;

      if (!entry.periodSources[period]) {
        entry.periodSources[period] = { zipPath: null, folderPath: null, looseFiles: [], symbols: [] };
      }
      entry.periodSources[period].zipPath = zipPath;

      // Scan ZIP for symbols
      try {
        const zip = new StreamZip.async({ file: zipPath });
        const entries = await zip.entries();
        const symbolSet = new Set(entry.periodSources[period].symbols);

        for (const ze of Object.values(entries)) {
          if (ze.isDirectory) continue;
          // Match YYYYMMDD/SYMBOL.csv or SYMBOL.csv
          const m = ze.name.match(/(?:^|\/)([A-Za-z]+\d{3,4})\.csv$/i);
          if (m) symbolSet.add(m[1].toUpperCase());
        }
        await zip.close();
        entry.periodSources[period].symbols = Array.from(symbolSet).sort();
        this._mergeSymbols(entry);
      } catch (err) {
        logger.error(`[FuturesTick] Failed to scan ZIP ${zipPath}: ${err.message}`);
      }
    }

    // 3. Loose CSV files (SYMBOL.csv directly in period dir)
    const looseCsvs = items.filter(f => f.endsWith('.csv') && fs.statSync(path.join(dirPath, f)).isFile());
    for (const csv of looseCsvs) {
      const symbol = csv.replace('.csv', '').toUpperCase();
      const csvPath = path.join(dirPath, csv);

      // Infer date from first data row
      const date = this._inferDateFromCsv(csvPath);
      if (!date) {
        logger.warn(`[FuturesTick] Cannot infer date from loose CSV: ${csvPath}`);
        continue;
      }

      this._index[date] = this._index[date] || this._makeEmptyEntry();
      const entry = this._index[date];
      entry.periods[period] = true;

      if (!entry.periodSources[period]) {
        entry.periodSources[period] = { zipPath: null, folderPath: null, looseFiles: [], symbols: [] };
      }
      entry.periodSources[period].looseFiles.push({ path: csvPath, symbol });
      if (!entry.periodSources[period].symbols.includes(symbol)) {
        entry.periodSources[period].symbols.push(symbol);
        entry.periodSources[period].symbols.sort();
      }
      this._mergeSymbols(entry);
    }
  }

  /** Merge periodSources symbols into the top-level entry.symbols */
  _mergeSymbols(entry) {
    const all = new Set(entry.symbols);
    for (const ps of Object.values(entry.periodSources)) {
      for (const s of ps.symbols) all.add(s);
    }
    entry.symbols = Array.from(all).sort();
  }

  /** Read first data row of a CSV to extract YYYYMMDD date string */
  _inferDateFromCsv(csvPath) {
    try {
      const fd = fs.openSync(csvPath, 'r');
      const buf = Buffer.alloc(2048);
      fs.readSync(fd, buf, 0, 2048, 0);
      fs.closeSync(fd);
      const text = buf.toString('utf-8');
      const lines = text.split('\n');
      // Try second line (first is header)
      const dataLine = lines[1] || lines[0] || '';
      // Match YYYY-MM-DD or YYYYMMDD pattern anywhere in the line
      const m = dataLine.match(/(\d{4})-(\d{2})-(\d{2})/) || dataLine.match(/(\d{4})(\d{2})(\d{2})/);
      if (m) return `${m[1]}${m[2]}${m[3]}`;
    } catch { /* ignore */ }
    return null;
  }

  _makeEmptyEntry() {
    return {
      zipPath: null,
      folderPath: null,
      symbols: [],
      periods: { tick: false, '1m': false, '5m': false, '15m': false, '30m': false, '1h': false, '1d': false },
      // Period-first layout sources: { period: { zipPath, folderPath, looseFiles: [{path, symbol}], symbols } }
      periodSources: {},
    };
  }

  /**
   * Scan an extracted date folder for sub-period folders and CSVs.
   */
  _scanFolder(date, folderPath) {
    const entry = this._index[date];
    const subItems = fs.readdirSync(folderPath);
    const symbolSet = new Set(entry.symbols);

    // Check for period sub-folders
    for (const sub of subItems) {
      const subPath = path.join(folderPath, sub);
      if (!fs.statSync(subPath).isDirectory()) continue;

      const periodKey = sub.toLowerCase();
      if (KNOWN_PERIODS.includes(periodKey)) {
        entry.periods[periodKey] = true;
        // Collect symbols from this period folder
        const csvFiles = fs.readdirSync(subPath).filter(f => f.endsWith('.csv'));
        for (const csv of csvFiles) {
          symbolSet.add(csv.replace('.csv', '').toUpperCase());
        }
      }
    }

    // Check for flat layout: CSVs directly in date folder (treat as tick)
    const rootCsvs = subItems.filter(f => f.endsWith('.csv') && fs.statSync(path.join(folderPath, f)).isFile());
    if (rootCsvs.length > 0 && !entry.periods.tick) {
      entry.periods.tick = true;
      entry._flatTickLayout = true; // Flag: ticks are in root, not in tick/ subfolder
      for (const csv of rootCsvs) {
        symbolSet.add(csv.replace('.csv', '').toUpperCase());
      }
    }

    entry.symbols = Array.from(symbolSet).sort();
  }

  /**
   * Scan ZIP for symbols (index entries only).
   */
  async _scanZip(date, zipPath, mergeOnly = false) {
    try {
      const zip = new StreamZip.async({ file: zipPath });
      const entries = await zip.entries();
      const entry = this._index[date];
      const symbolSet = new Set(entry.symbols);

      for (const zipEntry of Object.values(entries)) {
        if (zipEntry.isDirectory) continue;
        // Match both nested (YYYYMMDD/SYMBOL.csv) and flat (SYMBOL.csv) layouts
        const csvMatch = zipEntry.name.match(/(?:^|\/)([A-Za-z]+\d{3,4})\.csv$/i);
        if (csvMatch) {
          symbolSet.add(csvMatch[1].toUpperCase());
        }
      }

      await zip.close();

      entry.symbols = Array.from(symbolSet).sort();
      // ZIP data is always tick-level
      if (!mergeOnly) {
        entry.periods.tick = true;
      }
    } catch (err) {
      logger.error(`[FuturesTick] Failed to scan ZIP ${zipPath}: ${err.message}`);
    }
  }

  // Keep old name as alias for backward compat
  async scanZipFiles() {
    return this.scanDataSources();
  }

  async _ensureIndex() {
    if (!this._indexBuilt) {
      await this.scanDataSources();
    }
  }

  async refreshIndex() {
    this._indexBuilt = false;
    this._cache.clear();
    await this.scanDataSources();
  }

  // ─── Public Query API ────────────────────────────────────────────────

  async getAvailableDates() {
    await this._ensureIndex();
    return Object.keys(this._index).sort();
  }

  async getAvailableSymbols(date) {
    await this._ensureIndex();
    return this._index[date]?.symbols || [];
  }

  async getAvailablePeriods(date) {
    await this._ensureIndex();
    const entry = this._index[date];
    if (!entry) return [];
    return Object.entries(entry.periods).filter(([, v]) => v).map(([k]) => k);
  }

  async getInfo(symbol, date) {
    await this._ensureIndex();
    const entry = this._index[date];
    if (!entry) return null;

    const upperSymbol = symbol.toUpperCase();
    if (!entry.symbols.includes(upperSymbol)) return null;

    const { ticks, dataSource } = await this.getTickData(symbol, date);
    if (!ticks || ticks.length === 0) return null;

    const availPeriods = Object.entries(entry.periods).filter(([, v]) => v).map(([k]) => k);

    return {
      symbol: upperSymbol,
      date,
      exchange: ticks[0].exchange,
      rowCount: ticks.length,
      startTime: new Date(ticks[0].timestamp).toISOString(),
      endTime: new Date(ticks[ticks.length - 1].timestamp).toISOString(),
      dataSource,
      availablePeriods: availPeriods,
      hasFolder: !!entry.folderPath,
      hasZip: !!entry.zipPath,
    };
  }

  async searchSymbol(query, date = null) {
    await this._ensureIndex();
    const upperQuery = (query || '').toUpperCase();
    const results = [];
    const seen = new Set();
    const dates = date ? [date] : Object.keys(this._index);

    for (const d of dates) {
      const entry = this._index[d];
      if (!entry) continue;
      for (const sym of entry.symbols) {
        if (seen.has(sym)) continue;
        if (sym.includes(upperQuery)) {
          seen.add(sym);
          results.push({ symbol: sym, date: d });
        }
      }
    }

    return results.slice(0, 100);
  }

  // ─── Tick Data Loading ───────────────────────────────────────────────

  /**
   * Get tick data for a symbol + date.
   * Returns { ticks: Array, dataSource: string }
   */
  async getTickData(symbol, date) {
    await this._ensureIndex();

    const upperSymbol = symbol.toUpperCase();
    const cacheKey = `tick:${date}:${upperSymbol}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const entry = this._index[date];
    if (!entry) {
      return { ticks: [], dataSource: 'no-data' };
    }

    let result = null;
    const tickSrc = entry.periodSources?.tick;

    // Priority 1: Period-first tick folder
    if (!result && tickSrc?.folderPath) {
      const csvPath = path.join(tickSrc.folderPath, date, `${upperSymbol}.csv`);
      result = this._tryReadTickCsv(csvPath, upperSymbol, 'futures-tick-folder');
    }

    // Priority 2: Period-first tick loose file
    if (!result && tickSrc?.looseFiles?.length) {
      const loose = tickSrc.looseFiles.find(f => f.symbol === upperSymbol);
      if (loose) {
        result = this._tryReadTickCsv(loose.path, upperSymbol, 'futures-tick-folder');
      }
    }

    // Priority 3: Period-first tick ZIP
    if (!result && tickSrc?.zipPath) {
      try {
        const content = await this._extractCsvFromZip(tickSrc.zipPath, date, upperSymbol);
        const ticks = this._parseCsv(content, upperSymbol);
        if (ticks.length > 0) {
          result = { ticks, dataSource: 'futures-tick-zip' };
        }
      } catch (err) {
        logger.warn(`[FuturesTick] Period-first ZIP tick failed for ${upperSymbol}@${date}: ${err.message}`);
      }
    }

    // Priority 4: Legacy date-first tick folder
    if (!result && entry.folderPath && entry.periods.tick) {
      const csvPath = entry._flatTickLayout
        ? path.join(entry.folderPath, `${upperSymbol}.csv`)
        : path.join(entry.folderPath, 'tick', `${upperSymbol}.csv`);
      result = this._tryReadTickCsv(csvPath, upperSymbol, 'futures-tick-folder');
    }

    // Priority 5: Legacy date-first ZIP
    if (!result && entry.zipPath) {
      try {
        const content = await this._extractCsvFromZip(entry.zipPath, date, upperSymbol);
        const ticks = this._parseCsv(content, upperSymbol);
        if (ticks.length > 0) {
          result = { ticks, dataSource: 'futures-tick-zip' };
        }
      } catch (err) {
        logger.warn(`[FuturesTick] Legacy ZIP tick failed for ${upperSymbol}@${date}: ${err.message}`);
      }
    }

    if (!result) {
      result = { ticks: [], dataSource: 'no-data' };
    }

    this._cacheSet(cacheKey, result);
    return result;
  }

  /** Try to read bars CSV from a list of candidate paths. Returns result or null. */
  _tryReadBarsCsv(candidates, dataSource) {
    for (const csvPath of candidates) {
      if (!fs.existsSync(csvPath)) continue;
      try {
        const content = fs.readFileSync(csvPath, 'utf-8');
        const bars = this._parseBarsCsv(content);
        if (bars.length > 0) return { bars, dataSource };
      } catch (err) {
        logger.warn(`[FuturesTick] Failed to read bars CSV ${csvPath}: ${err.message}`);
      }
    }
    return null;
  }

  /** Try to read and parse tick CSV from a file path. Returns result object or null. */
  _tryReadTickCsv(csvPath, symbol, dataSource) {
    if (!fs.existsSync(csvPath)) return null;
    try {
      const content = fs.readFileSync(csvPath, 'utf-8');
      const ticks = this._parseCsv(content, symbol);
      return ticks.length > 0 ? { ticks, dataSource } : null;
    } catch (err) {
      logger.warn(`[FuturesTick] Failed to read tick CSV ${csvPath}: ${err.message}`);
      return null;
    }
  }

  // ─── K-line Data Loading ─────────────────────────────────────────────

  /**
   * Get OHLCV kline bars for a symbol + date + period.
   * Returns { bars: Array, dataSource: string }
   *
   * Priority chain:
   *   1. Pre-aggregated period folder  →  "futures-tick-precomputed-{period}"
   *   2. Aggregate from tick folder    →  "futures-tick-aggregated"
   *   3. Extract & aggregate from ZIP  →  "futures-tick-zip"
   *   4. No data                       →  "no-data"
   */
  async getKlineFromTicks(symbol, date, period = '1m') {
    await this._ensureIndex();

    const upperSymbol = symbol.toUpperCase();
    const cacheKey = `kline:${date}:${upperSymbol}:${period}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const entry = this._index[date];
    if (!entry) {
      return { bars: [], dataSource: 'no-data' };
    }

    // Return raw ticks in bar-compatible format
    if (period === 'tick') {
      const { ticks, dataSource } = await this.getTickData(symbol, date);
      const bars = ticks.map(t => ({
        time: Math.floor(t.timestamp / 1000),
        timestamp: t.timestamp,
        date: t.time,
        open: t.lastPrice,
        high: t.lastPrice,
        low: t.lastPrice,
        close: t.lastPrice,
        volume: t.volume,
        amount: t.amount,
      }));
      const result = { bars, dataSource };
      this._cacheSet(cacheKey, result);
      return result;
    }

    const bucketMs = this._periodToMs(period);
    if (!bucketMs) {
      throw new Error(`Unsupported period: ${period}`);
    }

    let result = null;
    const periodSrc = entry.periodSources?.[period];

    // Priority 1: Period-first folder
    if (!result && periodSrc?.folderPath) {
      // Try date subfolder first, then direct
      const candidates = [
        path.join(periodSrc.folderPath, date, `${upperSymbol}.csv`),
        path.join(periodSrc.folderPath, `${upperSymbol}.csv`),
      ];
      result = this._tryReadBarsCsv(candidates, `futures-${period}-folder`);
    }

    // Priority 2: Period-first loose files
    if (!result && periodSrc?.looseFiles?.length) {
      const loose = periodSrc.looseFiles.find(f => f.symbol === upperSymbol);
      if (loose) {
        result = this._tryReadBarsCsv([loose.path], `futures-${period}-folder`);
      }
    }

    // Priority 3: Period-first ZIP
    if (!result && periodSrc?.zipPath) {
      try {
        const content = await this._extractCsvFromZip(periodSrc.zipPath, date, upperSymbol);
        const bars = this._parseBarsCsv(content);
        if (bars.length > 0) {
          result = { bars, dataSource: `futures-${period}-zip` };
        }
      } catch (err) {
        logger.warn(`[FuturesTick] Period-first ZIP ${period} failed for ${upperSymbol}@${date}: ${err.message}`);
      }
    }

    // Priority 4: Legacy pre-aggregated period folder
    if (!result && entry.folderPath && entry.periods[period]) {
      const csvPath = path.join(entry.folderPath, period, `${upperSymbol}.csv`);
      result = this._tryReadBarsCsv([csvPath], `futures-tick-precomputed-${period}`);
    }

    // Priority 5: Aggregate from tick data
    if (!result) {
      const { ticks, dataSource: tickSource } = await this.getTickData(symbol, date);
      if (ticks.length > 0) {
        const bars = this._aggregateToBars(ticks, bucketMs);
        const ds = tickSource === 'futures-tick-folder' ? 'futures-tick-aggregated' : 'futures-tick-zip';
        result = { bars, dataSource: ds };
      }
    }

    if (!result) {
      result = { bars: [], dataSource: 'no-data' };
    }

    this._cacheSet(cacheKey, result);
    return result;
  }

  /**
   * Get kline across multiple dates.
   */
  async getMultiDayKline(symbol, startDate, endDate, period = '1m') {
    await this._ensureIndex();

    const dates = Object.keys(this._index)
      .filter(d => d >= startDate && d <= endDate)
      .sort();

    const allBars = [];
    let lastSource = 'no-data';

    for (const date of dates) {
      const upperSymbol = symbol.toUpperCase();
      if (!this._index[date].symbols.includes(upperSymbol)) continue;

      try {
        const { bars, dataSource } = await this.getKlineFromTicks(symbol, date, period);
        allBars.push(...bars);
        if (bars.length > 0) lastSource = dataSource;
      } catch (err) {
        logger.warn(`[FuturesTick] Failed to load ${symbol} for ${date}: ${err.message}`);
      }
    }

    return { bars: allBars, dataSource: lastSource };
  }

  // ─── CSV Parsing ─────────────────────────────────────────────────────

  /**
   * Parse pre-aggregated OHLCV bar CSV.
   * Expected: time,open,high,low,close,volume,amount (or similar headers)
   */
  _parseBarsCsv(content) {
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

    const lines = content.split('\n');
    if (lines.length < 2) return [];

    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const col = {};
    header.forEach((name, idx) => { col[name] = idx; });

    const bars = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = line.split(',');
      if (values.length < 5) continue;

      // Time: try bob (begin of bar), eob (end of bar), time, date, timestamp
      const timeStr = (
        values[col['bob']] || values[col['eob']] ||
        values[col['time']] || values[col['date']] || values[col['timestamp']] || ''
      ).trim();
      const open = parseFloat(values[col['open']]) || 0;
      const high = parseFloat(values[col['high']]) || 0;
      const low = parseFloat(values[col['low']]) || 0;
      const close = parseFloat(values[col['close']]) || 0;
      const volume = parseInt(values[col['volume']]) || 0;
      const amount = parseFloat(values[col['amount']]) || 0;
      const position = parseInt(values[col['position']]) || 0;

      if (close <= 0) continue;

      const ts = this._parseTimestamp(timeStr);
      const unixSec = ts ? Math.floor(ts / 1000) : 0;

      bars.push({
        time: unixSec,
        timestamp: ts || 0,
        date: timeStr,
        open, high, low, close, volume, amount,
        openInterest: position,
      });
    }

    return bars.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Parse tick CSV (same 15-column format as before).
   */
  _parseCsv(content, symbol) {
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

    const lines = content.split('\n');
    if (lines.length < 2) return [];

    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const col = {};
    header.forEach((name, idx) => { col[name] = idx; });

    const ticks = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = this._splitCsvLine(line);
      if (values.length < header.length) continue;

      const timestamp = this._parseTimestamp(values[col['created_at']]);
      if (!timestamp) continue;

      const lastPrice = parseFloat(values[col['price']]) || 0;
      if (lastPrice <= 0) continue;

      const { bidPrice, bidVolume, askPrice, askVolume } = this._parseQuotes(values[col['quotes']]);

      ticks.push({
        timestamp,
        time: new Date(timestamp).toISOString(),
        exchange: (values[col['exchange']] || '').trim(),
        symbol: (values[col['symbol']] || symbol).trim(),
        lastPrice,
        open: parseFloat(values[col['open']]) || lastPrice,
        high: parseFloat(values[col['high']]) || lastPrice,
        low: parseFloat(values[col['low']]) || lastPrice,
        volume: parseInt(values[col['last_volume']]) || 0,
        cumVolume: parseInt(values[col['cum_volume']]) || 0,
        amount: parseFloat(values[col['last_amount']]) || 0,
        cumAmount: parseFloat(values[col['cum_amount']]) || 0,
        openInterest: parseInt(values[col['cum_position']]) || 0,
        bidPrice, bidVolume, askPrice, askVolume,
        tradeType: TRADE_TYPE_MAP[parseInt(values[col['trade_type']])] || 'unknown',
      });
    }

    return ticks;
  }

  _splitCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && !inQuotes) { inQuotes = true; continue; }
      if (ch === '"' && inQuotes) {
        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; continue; }
        inQuotes = false; continue;
      }
      if (ch === ',' && !inQuotes) { result.push(current); current = ''; continue; }
      current += ch;
    }
    result.push(current);
    return result;
  }

  _parseQuotes(quotesStr) {
    const result = { bidPrice: 0, bidVolume: 0, askPrice: 0, askVolume: 0 };
    if (!quotesStr) return result;

    try {
      const jsonStr = quotesStr.replace(/'/g, '"');
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const q = parsed[0];
        result.bidPrice = parseFloat(q.bid_p) || 0;
        result.bidVolume = parseInt(q.bid_v) || 0;
        result.askPrice = parseFloat(q.ask_p) || 0;
        result.askVolume = parseInt(q.ask_v) || 0;
      }
    } catch {
      const bidP = quotesStr.match(/bid_p['":\s]+(\d+\.?\d*)/);
      const bidV = quotesStr.match(/bid_v['":\s]+(\d+)/);
      const askP = quotesStr.match(/ask_p['":\s]+(\d+\.?\d*)/);
      const askV = quotesStr.match(/ask_v['":\s]+(\d+)/);
      if (bidP) result.bidPrice = parseFloat(bidP[1]);
      if (bidV) result.bidVolume = parseInt(bidV[1]);
      if (askP) result.askPrice = parseFloat(askP[1]);
      if (askV) result.askVolume = parseInt(askV[1]);
    }

    return result;
  }

  _parseTimestamp(str) {
    if (!str) return null;
    const ts = new Date(str.trim()).getTime();
    return Number.isFinite(ts) ? ts : null;
  }

  // ─── ZIP Extraction ──────────────────────────────────────────────────

  async _extractCsvFromZip(zipPath, date, symbol) {
    const zip = new StreamZip.async({ file: zipPath });
    try {
      const entries = await zip.entries();
      // Try multiple path patterns inside the ZIP
      const candidates = [
        `${date}/${symbol}.csv`,
        `${symbol}.csv`,
        `${date}/${symbol.toLowerCase()}.csv`,
        `${symbol.toLowerCase()}.csv`,
      ];
      for (const name of candidates) {
        if (entries[name]) {
          const buffer = await zip.entryData(name);
          return buffer.toString('utf-8');
        }
      }
      throw new Error(`Entry not found in ZIP for ${symbol} (tried: ${candidates.join(', ')})`);
    } finally {
      await zip.close();
    }
  }

  // ─── Aggregation ─────────────────────────────────────────────────────

  _periodToMs(period) {
    const map = {
      '1s': 1000,
      '1m': 60_000, '1min': 60_000,
      '5m': 300_000, '5min': 300_000,
      '15m': 900_000, '15min': 900_000,
      '30m': 1_800_000, '30min': 1_800_000,
      '1h': 3_600_000, '60m': 3_600_000, '60min': 3_600_000,
      '1d': 86_400_000, 'daily': 86_400_000,
    };
    return map[period.toLowerCase()] || null;
  }

  _aggregateToBars(ticks, bucketMs) {
    const buckets = new Map();

    for (const tick of ticks) {
      const bucketKey = Math.floor(tick.timestamp / bucketMs) * bucketMs;

      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, {
          timestamp: bucketKey,
          open: tick.lastPrice,
          high: tick.lastPrice,
          low: tick.lastPrice,
          close: tick.lastPrice,
          volume: 0,
          amount: 0,
          tickCount: 0,
        });
      }

      const bar = buckets.get(bucketKey);
      bar.high = Math.max(bar.high, tick.lastPrice);
      bar.low = Math.min(bar.low, tick.lastPrice);
      bar.close = tick.lastPrice;
      bar.volume += tick.volume;
      bar.amount += tick.amount;
      bar.tickCount++;
    }

    return Array.from(buckets.values())
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(bar => {
        const dt = new Date(bar.timestamp);
        return {
          time: Math.floor(bar.timestamp / 1000),
          timestamp: bar.timestamp,
          date: dt.toISOString().replace('T', ' ').slice(0, 19),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          amount: Math.round(bar.amount * 100) / 100,
          tickCount: bar.tickCount,
        };
      });
  }

  // ─── Cache Helper ────────────────────────────────────────────────────

  _cacheSet(key, value) {
    if (this._cache.size >= this._cacheMaxSize) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }
    this._cache.set(key, value);
  }

  // ─── Symbol Auto-Import ──────────────────────────────────────────────

  static FUTURES_NAMES = {
    RB: '螺纹钢', HC: '热卷', I: '铁矿石', J: '焦炭', JM: '焦煤',
    A: '豆一', B: '豆二', M: '豆粕', Y: '豆油', P: '棕榈油', OI: '菜油',
    CF: '棉花', SR: '白糖', CY: '棉纱', AP: '苹果', CJ: '红枣',
    PK: '花生', LH: '生猪', UR: '尿素', SA: '纯碱', FG: '玻璃',
    CU: '铜', AL: '铝', ZN: '锌', PB: '铅', NI: '镍', SN: '锡',
    AU: '黄金', AG: '白银', SC: '原油', FU: '燃油', BU: '沥青', LU: '低硫燃油',
    MA: '甲醇', TA: 'PTA', PP: 'PP', L: '塑料', V: 'PVC', EG: '乙二醇', EB: '苯乙烯', PF: 'PF',
    C: '玉米', CS: '淀粉', JD: '鸡蛋', RR: '粳米', LR: '晚籼稻',
    IF: '沪深300期', IC: '中证500期', IM: '中证1000期', IH: '上证50期',
    T: '10年国债', TF: '5年国债', TS: '2年国债', TL: '30年国债',
    SS: '不锈钢', WR: '线材', SF: '硅铁', SM: '锰硅', ZC: '动力煤',
    SP: '纸浆', NR: '20号胶', RU: '天然橡胶', EC: '欧线集运', SI: '工业硅',
    LC: '碳酸锂', AO: '氧化铝', BR: '丁二烯橡胶', SH: '烧碱',
  };

  /**
   * Sync all symbols found in ZIP/folder data into the instrument table.
   */
  async syncSymbolsToInstruments() {
    await this._ensureIndex();
    const allSymbols = new Set();
    for (const entry of Object.values(this._index)) {
      entry.symbols.forEach(s => allSymbols.add(s.toUpperCase()));
    }

    if (allSymbols.size === 0) return;

    const instrumentService = require('./instrumentService');
    const instruments = [];

    for (const sym of allSymbols) {
      const prefix = sym.replace(/\d+$/, '').toUpperCase();
      const nameBase = FuturesTickDataService.FUTURES_NAMES[prefix] || prefix;
      const contract = sym.replace(prefix, '');
      // Continuous contracts: 8888 = dominant, 9999 = index
      let name;
      if (contract === '8888') name = `${nameBase}主力`;
      else if (contract === '9999') name = `${nameBase}指数`;
      else name = `${nameBase}${contract}`;

      instruments.push({
        symbol: sym,
        name,
        type: 'futures',
        market: 'futures',
        category: '期货'
      });
    }

    logger.info(`[FuturesTick] Syncing ${instruments.length} futures symbols to instrument table`);
    const result = await instrumentService.batchSaveInstruments(instruments);
    logger.info(`[FuturesTick] Sync done: added=${result.successCount}, updated=${result.updateCount}, skipped=${result.skipCount}`);
    return result;
  }
}

module.exports = new FuturesTickDataService();
