/**
 * AKShare Data Service
 *
 * Anti-IP-ban measures:
 *   1. Request queue with configurable minimum interval (default 0.5s)
 *   2. Concurrency semaphore (max 1 concurrent request)
 *   3. Exponential backoff retry (3 attempts: 1s / 2s / 4s)
 *   4. User-Agent rotation in the Python script
 *   5. HTTP/SOCKS proxy support via AKSHARE_PROXY env var
 *   6. Extended cache TTL for historical / kline data (1 hour)
 *   7. Randomised delay jitter to avoid predictable patterns
 */
const { spawn } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
const path = require('path');
const fs = require('fs');

// ── Anti-ban configuration ──────────────────────────────────────────────
const MIN_REQUEST_INTERVAL_MS = parseInt(process.env.AKSHARE_MIN_INTERVAL_MS || '500', 10);
const MAX_RETRIES = parseInt(process.env.AKSHARE_MAX_RETRIES || '3', 10);
const BASE_RETRY_DELAY_MS = 1000;
const JITTER_MAX_MS = 300;

class AKShareDataService {
  constructor() {
    this.cache = new Map();
    this.realtimeCacheTTL = 120_000;      // 2 min for realtime quotes
    this.klineCacheTTL = 3_600_000;       // 1 hour for kline / historical
    this.scriptTimeoutMs = parseInt(process.env.AKSHARE_SCRIPT_TIMEOUT_MS || '30000', 10);
    this.pythonPath = require('../utils/pythonPath').findPython();
    this.scriptsDir = path.join(__dirname, '../../akshare_scripts');

    // Request queue state
    this._lastRequestTime = 0;
    this._requestQueue = Promise.resolve();
    this._activeRequests = 0;

    // Periodic cache cleanup (every 5 min)
    this._cacheGCTimer = setInterval(() => this.clearExpiredCache(), 300_000);

    this.ensureScriptsDirectory();
  }

  // ── Request queue / rate limiter ────────────────────────────────────────

  /**
   * Enqueue a request so that at most 1 runs at a time,
   * with at least MIN_REQUEST_INTERVAL_MS between each.
   */
  _enqueue(fn) {
    const wrapped = this._requestQueue.then(async () => {
      const now = Date.now();
      const elapsed = now - this._lastRequestTime;
      const waitNeeded = MIN_REQUEST_INTERVAL_MS - elapsed;

      if (waitNeeded > 0) {
        const jitter = Math.floor(Math.random() * JITTER_MAX_MS);
        await this._sleep(waitNeeded + jitter);
      }

      this._activeRequests++;
      try {
        const result = await fn();
        return result;
      } finally {
        this._lastRequestTime = Date.now();
        this._activeRequests--;
      }
    });

    // Chain next request after this one (whether it succeeds or fails)
    this._requestQueue = wrapped.catch(() => {});
    return wrapped;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Retry with exponential backoff ──────────────────────────────────────

  async _retryWithBackoff(fn, label = 'request') {
    let lastError;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const isIPBan = /403|429|频率|限制|banned|block|rate.?limit|连接.*拒绝/i.test(err.message);

        if (attempt < MAX_RETRIES - 1) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * JITTER_MAX_MS);
          console.warn(`[AKShare] ${label} attempt ${attempt + 1} failed: ${err.message}. Retrying in ${delay}ms...`);

          if (isIPBan) {
            // Double the delay on suspected IP ban
            await this._sleep(delay * 2);
          } else {
            await this._sleep(delay);
          }
        }
      }
    }

    throw lastError;
  }

  // ── Script directory & Python scripts ───────────────────────────────────

  ensureScriptsDirectory() {
    if (!fs.existsSync(this.scriptsDir)) {
      fs.mkdirSync(this.scriptsDir, { recursive: true });
    }
    this.createPythonScripts();
  }

  createPythonScripts() {
    const realtimeScript = `
import akshare as ak
import json
import sys
import os
import random
import time
import pandas as pd
from datetime import datetime, timedelta

# ── Anti-ban: User-Agent rotation ────────────────────────────────────────
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
]

def setup_session():
    """Configure requests session with random UA and optional proxy."""
    import requests
    session = requests.Session()
    session.headers.update({
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Connection": "keep-alive",
    })

    proxy = os.environ.get("AKSHARE_PROXY", "").strip()
    if proxy:
        session.proxies = {"http": proxy, "https": proxy}

    # Patch requests.get / requests.post used by akshare internally
    _orig_get = requests.get
    _orig_post = requests.post
    def patched_get(url, **kwargs):
        kwargs.setdefault("headers", {}).update({"User-Agent": random.choice(USER_AGENTS)})
        if proxy and "proxies" not in kwargs:
            kwargs["proxies"] = {"http": proxy, "https": proxy}
        return _orig_get(url, **kwargs)
    def patched_post(url, **kwargs):
        kwargs.setdefault("headers", {}).update({"User-Agent": random.choice(USER_AGENTS)})
        if proxy and "proxies" not in kwargs:
            kwargs["proxies"] = {"http": proxy, "https": proxy}
        return _orig_post(url, **kwargs)
    requests.get = patched_get
    requests.post = patched_post

    return session

# Run setup before any akshare calls
setup_session()

def get_stock_realtime(symbol):
    """Get stock realtime quote."""
    try:
        pure_code = symbol.lower().lstrip('sh').lstrip('sz') if symbol[:2].lower() in ('sh', 'sz') else symbol
        df = ak.stock_zh_a_spot_em()
        stock_data = df[df['代码'] == pure_code]

        if stock_data.empty:
            return {"error": "股票代码不存在: " + pure_code}

        row = stock_data.iloc[0]
        return {
            "symbol": symbol,
            "name": row['名称'],
            "current_price": float(row['最新价']),
            "open": float(row['今开']),
            "high": float(row['最高']),
            "low": float(row['最低']),
            "close": float(row['昨收']),
            "volume": int(row['成交量']),
            "amount": float(row['成交额']),
            "change": float(row['涨跌额']),
            "change_percent": float(row['涨跌幅']),
            "source": "AKShare实时数据"
        }
    except Exception as e:
        return {"error": str(e)}

def get_stock_kline(symbol, period='daily', count=100):
    """Get stock K-line (OHLCV) data."""
    try:
        pure_code = symbol.lower().lstrip('sh').lstrip('sz') if symbol[:2].lower() in ('sh', 'sz') else symbol
        period_map = {'daily': 'daily', 'weekly': 'weekly', 'monthly': 'monthly'}
        ak_period = period_map.get(period, 'daily')
        df = ak.stock_zh_a_hist(symbol=pure_code, period=ak_period, adjust="qfq")

        if df.empty:
            return {"error": "无法获取K线数据"}

        df = df.tail(count)
        kline_data = []
        for _, row in df.iterrows():
            kline_data.append({
                "time": row['日期'].strftime('%Y-%m-%d'),
                "open": float(row['开盘']),
                "high": float(row['最高']),
                "low": float(row['最低']),
                "close": float(row['收盘']),
                "volume": int(row['成交量'])
            })

        return {"symbol": symbol, "kline": kline_data, "source": "AKShare历史数据"}
    except Exception as e:
        return {"error": str(e)}

def get_index_realtime(symbol):
    """Get index realtime quote."""
    try:
        pure_code = symbol.lower().lstrip('sh').lstrip('sz') if symbol[:2].lower() in ('sh', 'sz') else symbol
        df = ak.stock_zh_index_spot_em()
        index_data = df[df['代码'] == pure_code]

        if index_data.empty:
            return {"error": "指数代码不存在: " + pure_code}

        row = index_data.iloc[0]
        return {
            "symbol": symbol,
            "name": row['名称'],
            "current_price": float(row['最新价']),
            "open": float(row['今开']),
            "high": float(row['最高']),
            "low": float(row['最低']),
            "close": float(row['昨收']),
            "volume": int(row['成交量']) if '成交量' in row else 0,
            "amount": float(row['成交额']) if '成交额' in row else 0,
            "change": float(row['涨跌额']),
            "change_percent": float(row['涨跌幅']),
            "source": "AKShare指数数据"
        }
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "参数不足"}))
        sys.exit(1)

    action = sys.argv[1]
    symbol = sys.argv[2]

    if action == "realtime":
        result = get_stock_realtime(symbol)
    elif action == "kline":
        count = int(sys.argv[3]) if len(sys.argv) > 3 else 100
        period = sys.argv[4] if len(sys.argv) > 4 else 'daily'
        result = get_stock_kline(symbol, period, count)
    elif action == "index":
        result = get_index_realtime(symbol)
    else:
        result = {"error": "未知操作"}

    print(json.dumps(result, ensure_ascii=False, default=str))
`;

    const scriptPath = path.join(this.scriptsDir, 'akshare_data.py');
    fs.writeFileSync(scriptPath, realtimeScript, 'utf8');

    const requirements = `akshare>=1.12.0
pandas>=1.3.0
requests>=2.25.0
`;
    fs.writeFileSync(path.join(this.scriptsDir, 'requirements.txt'), requirements, 'utf8');
  }

  // ── Python script execution ─────────────────────────────────────────────

  async executePythonScript(action, symbol, ...args) {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(this.scriptsDir, 'akshare_data.py');
      const pythonArgs = [scriptPath, action, symbol, ...args];

      console.log(`[AKShare] Executing: ${action} ${symbol}`);

      // Pass proxy config to child process environment
      const childEnv = { ...process.env };
      const proxy = process.env.AKSHARE_PROXY || '';
      if (proxy) childEnv.AKSHARE_PROXY = proxy;

      let pythonProcess;
      try {
        pythonProcess = spawn(this.pythonPath, pythonArgs, { env: childEnv });
      } catch (spawnError) {
        reject(new Error(`Python unavailable: ${spawnError.message}`));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;

      pythonProcess.on('error', (error) => {
        if (!settled) { settled = true; reject(new Error(`Python process error: ${error.message}`)); }
      });

      pythonProcess.stdout.on('data', (data) => { stdout += data.toString(); });
      pythonProcess.stderr.on('data', (data) => { stderr += data.toString(); });

      pythonProcess.on('close', (code) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (settled) return;
        settled = true;

        if (code !== 0) {
          reject(new Error(`Python script failed (exit ${code}): ${stderr.slice(0, 500)}`));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          if (result.error) {
            reject(new Error(result.error));
          } else {
            resolve(result);
          }
        } catch (error) {
          reject(new Error(`Parse failed: ${error.message}`));
        }
      });

      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { safeKill(pythonProcess, 'SIGKILL', 0); } catch {}
          reject(new Error(`Script timeout (${Math.round(this.scriptTimeoutMs / 1000)}s)`));
        }
      }, this.scriptTimeoutMs);
    });
  }

  // ── Cache helper ────────────────────────────────────────────────────────

  _getCached(cacheKey, ttl) {
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < ttl) return cached.data;
    return null;
  }

  _setCache(cacheKey, data) {
    this.cache.set(cacheKey, { data, timestamp: Date.now() });
  }

  // ── Public API (rate-limited + retried) ─────────────────────────────────

  async getStockRealtime(symbol) {
    const cacheKey = `realtime_${symbol}`;
    const cached = this._getCached(cacheKey, this.realtimeCacheTTL);
    if (cached) { console.log(`[AKShare] Cache hit: ${cacheKey}`); return cached; }

    const result = await this._enqueue(() =>
      this._retryWithBackoff(() => this.executePythonScript('realtime', symbol), `realtime(${symbol})`)
    );

    this._setCache(cacheKey, result);
    return result;
  }

  async getStockKline(symbol, period = 'daily', count = 100) {
    const cacheKey = `kline_${symbol}_${period}_${count}`;
    const cached = this._getCached(cacheKey, this.klineCacheTTL);
    if (cached) { console.log(`[AKShare] Cache hit: ${cacheKey}`); return cached; }

    const result = await this._enqueue(() =>
      this._retryWithBackoff(() => this.executePythonScript('kline', symbol, count.toString(), period), `kline(${symbol})`)
    );

    this._setCache(cacheKey, result);
    return result;
  }

  async getIndexRealtime(symbol) {
    const cacheKey = `index_${symbol}`;
    const cached = this._getCached(cacheKey, this.realtimeCacheTTL);
    if (cached) { console.log(`[AKShare] Cache hit: ${cacheKey}`); return cached; }

    const result = await this._enqueue(() =>
      this._retryWithBackoff(() => this.executePythonScript('index', symbol), `index(${symbol})`)
    );

    this._setCache(cacheKey, result);
    return result;
  }

  async getIndexHistory(symbol, options = {}) {
    const { startDate, endDate, period = 'daily' } = options;
    const cacheKey = `index_history_${symbol}_${startDate}_${endDate}_${period}`;
    const cached = this._getCached(cacheKey, this.klineCacheTTL);
    if (cached) { console.log(`[AKShare] Cache hit: ${cacheKey}`); return cached; }

    const formattedStartDate = startDate ? startDate.replace(/-/g, '') : null;
    const formattedEndDate = endDate ? endDate.replace(/-/g, '') : null;
    const args = [formattedStartDate, formattedEndDate, period].filter(arg => arg !== null);

    const result = await this._enqueue(() =>
      this._retryWithBackoff(() => this.executePythonScript('index_history', symbol, ...args), `index_history(${symbol})`)
    );

    this._setCache(cacheKey, result);
    return result;
  }

  async getStockData(symbol, options = {}) {
    try {
      const isIndex = this.isIndexSymbol(symbol);

      let realtimeData;
      if (isIndex) {
        realtimeData = await this.getIndexRealtime(symbol);
      } else {
        realtimeData = await this.getStockRealtime(symbol);
      }

      const { startDate, endDate, period = 'daily' } = options;
      let klineData;

      klineData = await this.getStockKline(symbol, period, 200);

      return {
        symbol,
        name: realtimeData.name,
        currentPrice: realtimeData.current_price,
        open: realtimeData.open,
        high: realtimeData.high,
        low: realtimeData.low,
        volume: realtimeData.volume,
        amount: realtimeData.amount,
        change: realtimeData.change,
        changePercent: realtimeData.change_percent,
        kline: klineData.kline,
        source: 'AKShare'
      };
    } catch (error) {
      console.error(`[AKShare] getStockData(${symbol}) failed: ${error.message}`);
      throw error;
    }
  }

  // ── Utility ─────────────────────────────────────────────────────────────

  isIndexSymbol(symbol) {
    const indexPrefixes = ['sh000', 'sz399', '000001', '399001', '399006'];
    return indexPrefixes.some(prefix => symbol.startsWith(prefix));
  }

  async checkEnvironment() {
    try {
      await this.executePythonScript('realtime', '000001');
      return { available: true, message: 'AKShare environment OK' };
    } catch (error) {
      return {
        available: false,
        message: `AKShare check failed: ${error.message}`,
        suggestion: 'pip install akshare'
      };
    }
  }

  async installDependencies() {
    return new Promise((resolve, reject) => {
      const requirementsPath = path.join(this.scriptsDir, 'requirements.txt');
      const installProcess = spawn(this.pythonPath, ['-m', 'pip', 'install', '-r', requirementsPath]);

      let stdout = '';
      let stderr = '';
      let settled = false;

      // Activity-aware idle timeout: pip prints progress, so resetting on output
      // tolerates long downloads while still killing a child that has truly
      // stalled (e.g. a hung network connection) instead of leaking it.
      let idleTimer = null;
      const IDLE_MS = 180000;
      const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
      const resetIdle = () => {
        clearIdle();
        idleTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (installProcess && !installProcess.killed) safeKill(installProcess);
          reject(new Error(`pip install idle timeout (${IDLE_MS / 1000}s with no output)`));
        }, IDLE_MS);
      };
      resetIdle();

      installProcess.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearIdle();
        reject(new Error(`Failed to start pip: ${err.message}`));
      });

      installProcess.stdout.on('data', (data) => { stdout += data.toString(); resetIdle(); });
      installProcess.stderr.on('data', (data) => { stderr += data.toString(); resetIdle(); });

      installProcess.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearIdle();
        if (code === 0) {
          resolve({ success: true, message: 'Dependencies installed', output: stdout });
        } else {
          reject(new Error(`Install failed: ${stderr}`));
        }
      });
    });
  }

  clearExpiredCache() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      const ttl = key.startsWith('realtime_') || key.startsWith('index_') ? this.realtimeCacheTTL : this.klineCacheTTL;
      if (now - value.timestamp > ttl) this.cache.delete(key);
    }
  }

  destroy() {
    if (this._cacheGCTimer) {
      clearInterval(this._cacheGCTimer);
      this._cacheGCTimer = null;
    }
    this.cache.clear();
  }

  getSupportedStocks() {
    return [
      { symbol: '000001', name: '上证指数', type: 'index' },
      { symbol: '399001', name: '深证成指', type: 'index' },
      { symbol: '399006', name: '创业板指', type: 'index' },
      { symbol: '000300', name: '沪深300', type: 'index' },
      { symbol: '000001', name: '平安银行', type: 'stock' },
      { symbol: '000002', name: '万科A', type: 'stock' },
      { symbol: '600000', name: '浦发银行', type: 'stock' },
      { symbol: '600036', name: '招商银行', type: 'stock' },
      { symbol: '600519', name: '贵州茅台', type: 'stock' },
      { symbol: '000858', name: '五粮液', type: 'stock' }
    ];
  }
}

module.exports = new AKShareDataService();
