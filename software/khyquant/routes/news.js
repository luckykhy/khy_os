/**
 * News data route - fetches real financial news via akshare
 * GET /api/news?keyword=xxx&limit=20
 */
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { spawn } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
const path = require('path');
const cacheService = require('../services/cacheService');
const logger = require('../utils/logger');

router.get('/', authMiddleware, async (req, res) => {
  try {
    const { keyword = '', limit = 20 } = req.query;
    const cacheKey = `news:${keyword}:${limit}`;

    // Check cache first (news cached for 10 minutes)
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, cached: true });
    }

    // Call Python script for news
    const news = await fetchNewsFromAkshare(keyword, parseInt(limit));
    if (news.length > 0) {
      await cacheService.set(cacheKey, news, 600); // 10 min
    }

    res.json({ success: true, data: news, count: news.length });
  } catch (error) {
    logger.error('News fetch failed', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch news', error: error.message });
  }
});

function fetchNewsFromAkshare(keyword, limit) {
  return new Promise((resolve) => {
    const sym = keyword || '000001';
    // Use a separate script file and pass the keyword via sys.argv to prevent
    // command injection from user-controlled keyword values.
    const newsScriptPath = path.join(__dirname, '..', 'scripts', 'fetch_akshare_news.py');
    const { findPython } = require('../utils/pythonPath');
    const pythonPath = findPython();

    let python;
    try {
      python = spawn(pythonPath, [newsScriptPath, sym, String(limit)], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
    } catch {
      resolve([]);
      return;
    }

    let out = '';
    let _idleTimer = null;
    const _resetIdle = () => {
      if (_idleTimer) clearTimeout(_idleTimer);
      _idleTimer = setTimeout(() => { try { safeKill(python); } catch {} }, 30000);
    };
    _resetIdle();
    python.stdout.on('data', d => { out += d.toString(); _resetIdle(); });
    python.on('error', () => resolve([]));
    python.on('close', (code) => {
      if (_idleTimer) clearTimeout(_idleTimer);
      try {
        const result = JSON.parse(out);
        resolve(result.success ? result.data : []);
      } catch {
        resolve([]);
      }
    });
  });
}

module.exports = router;
