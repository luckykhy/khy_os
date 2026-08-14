const express = require('express');
const router = express.Router();
const klineDataService = require('../services/klineDataService');
const enhancedMockDataService = require('../services/enhancedMockDataService');
const { authMiddleware } = require('../middleware/auth');
const { spawn } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
const path = require('path');

/**
 * Detect if a symbol is a futures contract
 * Futures symbols: rb2410 (rebar), IF2406, IC2406, etc.
 */
function isFuturesSymbol(symbol) {
  return /^[A-Za-z]{1,3}\d{3,4}$/.test(symbol) || /^(IF|IC|IH|IM)\d{4}$/.test(symbol);
}

/**
 * Detect instrument type from symbol pattern
 */
function detectInstrumentType(symbol) {
  if (isFuturesSymbol(symbol)) return 'futures';
  if (/^(sh|sz)?(000|399)\d{3}$/.test(symbol)) return 'index';
  if (/^(sh|sz|SH|SZ)?\d{6}$/.test(symbol)) return 'stock';
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

function normalizeDateParam(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeLimit(value, fallback = 1000) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * 获取K线数据
 * GET /api/kline-data/:symbol
 */
router.get('/:symbol', authMiddleware, async (req, res) => {
  try {
    const { symbol } = req.params;
    const { period = 'daily', startDate, endDate, limit = 1000, dataType, instrumentType: instrumentTypeOverride } = req.query;
    const normalizedStartDate = normalizeDateParam(startDate);
    const normalizedEndDate = normalizeDateParam(endDate);
    const normalizedLimit = normalizeLimit(limit, 1000);
    const normalizedDataType = normalizeDataType(dataType, period);
    
    const instrumentType = instrumentTypeOverride || detectInstrumentType(symbol);
    console.log(`K-line request: ${symbol} (${instrumentType}), ${period}, dataType=${normalizedDataType}`);

    const result = await klineDataService.getKlineData(
      symbol,
      period,
      normalizedStartDate,
      normalizedEndDate,
      normalizedLimit,
      {
        dataType: normalizedDataType,
        instrumentType
      }
    );

    const kline = result.kline || [];
    res.json({
      success: true,
      data: kline,
      kline,
      count: kline.length,
      instrumentType: result.instrumentType || instrumentType,
      dataType: result.dataType || normalizedDataType,
      isMock: !!result.isMock,
      dataSource: result.data_source || 'unknown'
    });
  } catch (error) {
    console.error('获取K线数据失败:', error);
    // Never surface error to user — return mock so chart is never black.
    const mock = enhancedMockDataService.generateEnhancedKLineData({
      symbol: req.params.symbol,
      period: req.query.period || 'daily',
      startDate: normalizeDateParam(req.query.startDate),
      endDate: normalizeDateParam(req.query.endDate),
      limit: normalizeLimit(req.query.limit, 500)
    });
    res.json({
      success: true,
      data: mock,
      kline: mock,
      count: mock.length,
      instrumentType: req.query.instrumentType || detectInstrumentType(req.params.symbol),
      dataType: normalizeDataType(req.query.dataType, req.query.period || 'daily'),
      isMock: true,
      dataSource: 'enhanced_mock'
    });
  }
});

/**
 * 同步K线数据
 * POST /api/kline-data/sync
 */
router.post('/sync', authMiddleware, async (req, res) => {
  try {
    const {
      symbol,
      name,
      period = 'daily',
      startDate,
      endDate,
      dataType,
      instrumentType: instrumentTypeOverride
    } = req.body;
    
    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: '标的代码不能为空'
      });
    }

    const normalizedDataType = normalizeDataType(dataType, period);
    const instrumentType = instrumentTypeOverride || detectInstrumentType(symbol);
    
    console.log(`🔄 同步K线数据: ${symbol}, ${period}, dataType=${normalizedDataType}, instrumentType=${instrumentType}`);
    
    // 调用Python脚本获取历史数据
    const pythonScript = path.join(__dirname, '../services/adataService.py');
    const pythonCmd = require('../utils/pythonPath').findPython();
    const args = ['historical', symbol, period];
    
    if (startDate) args.push(startDate);
    if (endDate) args.push(endDate);
    
    let python;
    try {
      python = spawn(pythonCmd, [pythonScript, ...args]);
    } catch (spawnError) {
      console.error('❌ 无法启动Python进程:', spawnError.message);
      return res.status(500).json({
        success: false,
        message: 'Python不可用,无法同步K线数据',
        error: spawnError.message
      });
    }
    
    let dataString = '';
    let errorString = '';
    let _responded = false;

    // Activity-aware idle timeout (resets on stdout/stderr): a network-bound
    // historical fetch that hangs would otherwise leave the request unanswered
    // and the child process orphaned.
    let _idleTimer = null;
    const IDLE_MS = 120000;
    const _clearIdle = () => { if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; } };
    const _resetIdle = () => {
      _clearIdle();
      _idleTimer = setTimeout(() => {
        if (python && !python.killed) safeKill(python);
        if (!_responded) {
          _responded = true;
          res.status(504).json({
            success: false,
            message: `Python脚本空闲超时（${IDLE_MS / 1000}s 内无输出）`
          });
        }
      }, IDLE_MS);
    };
    _resetIdle();

    // Kill the child if the client disconnects before the script finishes.
    req.on('close', () => {
      _clearIdle();
      if (python && !python.killed) safeKill(python);
    });

    // 🔥 添加错误事件监听器
    python.on('error', (error) => {
      console.error('❌ Python进程错误:', error.message);
      errorString += `Python进程错误: ${error.message}`;
      _clearIdle();
      if (!_responded) {
        _responded = true;
        res.status(500).json({
          success: false,
          message: 'Python不可用,无法同步K线数据',
          error: error.message
        });
      }
    });

    python.stdout.on('data', (data) => {
      dataString += data.toString();
      _resetIdle();
    });

    python.stderr.on('data', (data) => {
      errorString += data.toString();
      _resetIdle();
    });

    python.on('close', async (code) => {
      _clearIdle();
      if (_responded) return;
      _responded = true;
      if (code !== 0) {
        console.error('Python脚本执行失败:', errorString);
        return res.status(500).json({
          success: false,
          message: 'Python脚本执行失败',
          error: errorString
        });
      }
      
      try {
        const result = JSON.parse(dataString);
        
        if (result.success && result.data && result.data.length > 0) {
          // 保存到数据库
          const saveResult = await klineDataService.saveKlineData(
            symbol,
            name,
            period,
            result.data,
            {
              dataType: normalizedDataType,
              instrumentType
            }
          );
          
          res.json({
            success: true,
            message: '同步完成',
            data: {
              count: saveResult.count,
              source: 'AData',
              dataType: normalizedDataType,
              instrumentType
            }
          });
        } else {
          res.json({
            success: false,
            message: '未获取到数据',
            error: result.error
          });
        }
      } catch (parseError) {
        console.error('解析Python输出失败:', parseError);
        res.status(500).json({
          success: false,
          message: '解析数据失败',
          error: parseError.message
        });
      }
    });
  } catch (error) {
    console.error('同步K线数据失败:', error);
    res.status(500).json({
      success: false,
      message: '同步K线数据失败',
      error: error.message
    });
  }
});

/**
 * 获取数据统计信息
 * GET /api/kline-data/:symbol/stats
 */
router.get('/:symbol/stats', authMiddleware, async (req, res) => {
  try {
    const { symbol } = req.params;
    const { period = 'daily' } = req.query;
    
    const stats = await klineDataService.getDataStats(symbol, period);
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('获取统计信息失败:', error);
    res.status(500).json({
      success: false,
      message: '获取统计信息失败',
      error: error.message
    });
  }
});

module.exports = router;
