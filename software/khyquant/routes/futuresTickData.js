/**
 * Futures Tick Data API Routes
 *
 * Provides access to tick-level data from ZIP archives for
 * backtesting, data replay, and K-line chart display.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { authMiddleware } = require('../middleware/auth');
const futuresTickDataService = require('../services/futuresTickDataService');

// 路由加载时立即触发一次索引扫描（异步，不阻塞启动）
futuresTickDataService.scanDataSources().catch(err => {
  console.warn('[FuturesTick] 启动时扫描失败:', err.message);
});

// Upload storage: temp directory, will be moved to correct location
const upload = multer({
  dest: require('os').tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.zip', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .zip and .csv files are allowed'));
    }
  }
});

// List available trading dates (ZIP files)
router.get('/dates', authMiddleware, async (req, res) => {
  try {
    const dates = await futuresTickDataService.getAvailableDates();
    res.json({
      success: true,
      data: dates,
      count: dates.length,
    });
  } catch (error) {
    console.error('[FuturesTick] Failed to list dates:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// List instruments available for a given date
router.get('/symbols', authMiddleware, async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, message: 'date parameter is required' });
    }
    const symbols = await futuresTickDataService.getAvailableSymbols(date);
    res.json({
      success: true,
      data: symbols,
      count: symbols.length,
    });
  } catch (error) {
    console.error('[FuturesTick] Failed to list symbols:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Search symbols by query
router.get('/search', authMiddleware, async (req, res) => {
  try {
    const { q, date } = req.query;
    const results = await futuresTickDataService.searchSymbol(q || '', date || null);
    res.json({ success: true, data: results, count: results.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get raw tick data
router.get('/ticks', authMiddleware, async (req, res) => {
  try {
    const { symbol, date, limit } = req.query;
    if (!symbol || !date) {
      return res.status(400).json({ success: false, message: 'symbol and date are required' });
    }

    const { ticks, dataSource } = await futuresTickDataService.getTickData(symbol, date);
    const maxLimit = parseInt(limit) || 0;
    const data = maxLimit > 0 ? ticks.slice(0, maxLimit) : ticks;

    res.json({
      success: true,
      data,
      count: data.length,
      totalCount: ticks.length,
      dataSource,
      isMock: false,
    });
  } catch (error) {
    console.error('[FuturesTick] Failed to get ticks:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get aggregated kline data for a single date
router.get('/kline', authMiddleware, async (req, res) => {
  try {
    const { symbol, date, period = '1m' } = req.query;
    if (!symbol || !date) {
      return res.status(400).json({ success: false, message: 'symbol and date are required' });
    }

    const { bars, dataSource } = await futuresTickDataService.getKlineFromTicks(symbol, date, period);

    res.json({
      success: true,
      data: bars,
      kline: bars,
      count: bars.length,
      symbol: symbol.toUpperCase(),
      date,
      period,
      dataSource,
      isMock: bars.length === 0,
    });
  } catch (error) {
    console.error('[FuturesTick] Failed to get kline:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get aggregated kline data across a date range
router.get('/kline-range', authMiddleware, async (req, res) => {
  try {
    const { symbol, startDate, endDate, period = '1m' } = req.query;
    if (!symbol || !startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'symbol, startDate, and endDate are required' });
    }

    const { bars, dataSource } = await futuresTickDataService.getMultiDayKline(symbol, startDate, endDate, period);

    res.json({
      success: true,
      data: bars,
      kline: bars,
      count: bars.length,
      symbol: symbol.toUpperCase(),
      startDate,
      endDate,
      period,
      dataSource,
      isMock: bars.length === 0,
    });
  } catch (error) {
    console.error('[FuturesTick] Failed to get kline range:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get metadata for a specific symbol + date
router.get('/info', authMiddleware, async (req, res) => {
  try {
    const { symbol, date } = req.query;
    if (!symbol || !date) {
      return res.status(400).json({ success: false, message: 'symbol and date are required' });
    }

    const info = await futuresTickDataService.getInfo(symbol, date);
    if (!info) {
      return res.status(404).json({ success: false, message: 'Data not found' });
    }

    res.json({ success: true, data: info });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Force refresh the ZIP index (e.g. after adding new ZIPs)
router.post('/refresh', authMiddleware, async (req, res) => {
  try {
    await futuresTickDataService.refreshIndex();
    const dates = await futuresTickDataService.getAvailableDates();
    res.json({
      success: true,
      message: `Index refreshed, ${dates.length} date(s) available`,
      data: dates,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Valid period directory names for upload
const VALID_PERIODS = ['Tick', '1m', '5m', '15m', '30m', '1h', '1d'];

// Upload ZIP or CSV data file (period-first layout)
router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const dataDir = futuresTickDataService.dataDir;
    // Period from request body, default to Tick for ZIP, Tick for CSV
    const period = req.body.period || 'Tick';

    if (!VALID_PERIODS.includes(period)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        success: false,
        message: `Invalid period "${period}". Must be one of: ${VALID_PERIODS.join(', ')}`
      });
    }

    // Ensure period subdirectory exists
    const periodDir = path.join(dataDir, period);
    fs.mkdirSync(periodDir, { recursive: true });

    let destPath;
    if (ext === '.zip') {
      // ZIP must be YYYYMMDD.zip format → save to {dataDir}/{period}/YYYYMMDD.zip
      const basename = path.basename(req.file.originalname);
      if (!/^\d{8}\.zip$/.test(basename)) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({
          success: false,
          message: 'ZIP filename must be YYYYMMDD.zip format (e.g. 20260421.zip)'
        });
      }
      destPath = path.join(periodDir, basename);
      fs.copyFileSync(req.file.path, destPath);
      fs.unlinkSync(req.file.path);
    } else {
      // CSV → save to {dataDir}/{period}/{date}/filename.csv
      const date = req.body.date || req.query.date || req.file.originalname.match(/(\d{8})/)?.[1];
      if (!date) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({
          success: false,
          message: 'CSV upload requires a date parameter (YYYYMMDD) or date in filename'
        });
      }
      const dateDir = path.join(periodDir, date);
      fs.mkdirSync(dateDir, { recursive: true });
      destPath = path.join(dateDir, req.file.originalname);
      fs.copyFileSync(req.file.path, destPath);
      fs.unlinkSync(req.file.path);
    }

    // Refresh index and sync symbols
    await futuresTickDataService.refreshIndex();
    const dates = await futuresTickDataService.getAvailableDates();

    res.json({
      success: true,
      message: `File uploaded: ${req.file.originalname}`,
      data: {
        filename: req.file.originalname,
        size: req.file.size,
        destination: destPath,
        availableDates: dates
      }
    });
  } catch (error) {
    // Clean up temp file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
