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
    // Q-024 (khy问题列表3): validate keyword to prevent Python code injection via
    // string concatenation in fetchNewsFromAkshare (L46). Only allow stock-symbol chars.
    if (keyword && !/^[A-Za-z0-9.\-_]{1,20}$/.test(keyword)) {
      return res.status(400).json({ success: false, message: 'Invalid keyword: only alphanumeric, dot, hyphen, underscore (max 20 chars)' });
    }
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
    const script = [
      'import sys, json, io',
      "sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')",
      'try:',
      '    import akshare as ak',
      '    df = ak.stock_news_em(symbol="' + sym + '")',
      '    if df is not None and len(df) > 0:',
      '        df = df.head(' + limit + ')',
      '        records = []',
      '        for _, row in df.iterrows():',
      '            records.append({',
      '                "title": str(row.get("\\u65b0\\u95fb\\u6807\\u9898", "")),',
      '                "content": str(row.get("\\u65b0\\u95fb\\u5185\\u5bb9", ""))[:200],',
      '                "source": str(row.get("\\u6587\\u7ae0\\u6765\\u6e90", "")),',
      '                "url": str(row.get("\\u65b0\\u95fb\\u94fe\\u63a5", "")),',
      '                "time": str(row.get("\\u53d1\\u5e03\\u65f6\\u95f4", ""))',
      '            })',
      '        print(json.dumps({"success": True, "data": records}, ensure_ascii=False))',
      '    else:',
      '        print(json.dumps({"success": True, "data": []}))',
      'except Exception as e:',
      '    print(json.dumps({"success": False, "error": str(e)}))'
    ].join('\n');

    const { findPython } = require('../utils/pythonPath');
    const pythonPath = findPython();

    let python;
    try {
      python = spawn(pythonPath, ['-c', script], {
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
