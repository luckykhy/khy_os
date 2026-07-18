const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const tickBacktestEngine = require('../services/tickBacktestEngine');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for CSV uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../data/tick');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// Upload tick data CSV
router.post('/upload-tick-data', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const filePath = req.file.path;
    const fileName = req.file.filename;
    const preview = tickBacktestEngine.parseTickCSV(filePath, { maxRows: 10 });
    res.json({
      success: true,
      data: {
        fileName,
        originalName: req.file.originalname,
        size: req.file.size,
        previewRows: preview.length,
        sampleTick: preview[0] || null
      },
      message: `File uploaded: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`
    });
  } catch (error) {
    console.error('Tick data upload failed:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Run tick-level backtest
router.post('/run-tick', async (req, res) => {
  try {
    const {
      fileName,
      strategy = 'ema_crossover',
      params = {},
      initialCapital = 100000,
      contractMultiplier = 10,
      marginRate = 0.12,
      commission = 3.5,
      slippage = 1,
      maxRows = 0
    } = req.body;

    if (!fileName) {
      return res.status(400).json({ success: false, message: 'fileName is required' });
    }
    const filePath = path.join(__dirname, '../../data/tick', fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Tick data file not found' });
    }

    console.log(`[TickBacktest] Running backtest on ${fileName} with strategy=${strategy}`);
    const ticks = tickBacktestEngine.parseTickCSV(filePath, { maxRows });
    if (ticks.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid tick data found in file' });
    }

    const result = tickBacktestEngine.runBacktest(ticks, {
      initialCapital, contractMultiplier, marginRate, commission, slippage, strategy, params
    });

    res.json({
      success: true,
      data: result,
      message: `Backtest completed: ${ticks.length} ticks, ${result.summary.totalTrades} trades, return: ${result.summary.totalReturn}%`
    });
  } catch (error) {
    console.error('Tick backtest failed:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Run tick-level backtest using ZIP data (no file upload needed)
router.post('/run-from-zip', async (req, res) => {
  try {
    const {
      symbol,
      date,
      strategy = 'ema_crossover',
      params = {},
      initialCapital = 100000,
      contractMultiplier = 10,
      marginRate = 0.12,
      commission = 3.5,
      slippage = 1,
      maxRows = 0
    } = req.body;

    if (!symbol || !date) {
      return res.status(400).json({ success: false, message: 'symbol and date are required' });
    }

    console.log(`[TickBacktest] Running ZIP backtest: ${symbol} @ ${date}, strategy=${strategy}`);

    let ticks = [];
    let dataSource = 'unknown';

    try {
      ticks = await tickBacktestEngine.parseTickFromZip(symbol, date);
      dataSource = 'futures-tick';
    } catch (err) {
      console.log(`[TickBacktest] No futures tick data for ${symbol}@${date}: ${err.message}`);
    }

    // Fallback: look for uploaded CSV matching symbol
    if (ticks.length === 0) {
      const uploadDir = path.join(__dirname, '../../data/tick');
      if (fs.existsSync(uploadDir)) {
        const candidates = fs.readdirSync(uploadDir)
          .filter(f => f.toLowerCase().includes(symbol.toLowerCase()) && f.endsWith('.csv'))
          .sort().reverse();
        if (candidates.length > 0) {
          ticks = tickBacktestEngine.parseTickCSV(path.join(uploadDir, candidates[0]));
          dataSource = 'uploaded-csv';
          console.log(`[TickBacktest] Using uploaded CSV: ${candidates[0]}`);
        }
      }
    }

    if (maxRows > 0) ticks = ticks.slice(0, maxRows);

    if (ticks.length === 0) {
      return res.status(400).json({ success: false, message: `No tick data found for ${symbol} @ ${date}` });
    }

    const result = tickBacktestEngine.runBacktest(ticks, {
      initialCapital, contractMultiplier, marginRate, commission, slippage, strategy, params
    });

    res.json({
      success: true,
      data: result,
      dataSource,
      message: `Backtest completed (${dataSource}): ${ticks.length} ticks, ${result.summary.totalTrades} trades, return: ${result.summary.totalReturn}%`
    });
  } catch (error) {
    console.error('ZIP backtest failed:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// List available ZIP dates for backtest
router.get('/zip-dates', async (req, res) => {
  try {
    const futuresTickDataService = require('../services/futuresTickDataService');
    const dates = await futuresTickDataService.getAvailableDates();
    res.json({ success: true, data: dates });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// List symbols available in a ZIP
router.get('/zip-symbols', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: 'date is required' });
    const futuresTickDataService = require('../services/futuresTickDataService');
    const symbols = await futuresTickDataService.getAvailableSymbols(date);
    res.json({ success: true, data: symbols, count: symbols.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// List available tick data files
router.get('/tick-files', async (req, res) => {
  try {
    const files = tickBacktestEngine.listTickFiles();
    res.json({ success: true, data: files });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete tick data file
router.delete('/tick-files/:fileName', async (req, res) => {
  try {
    const { fileName } = req.params;
    const filePath = path.join(__dirname, '../../data/tick', fileName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true, message: `Deleted ${fileName}` });
    } else {
      res.status(404).json({ success: false, message: 'File not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
