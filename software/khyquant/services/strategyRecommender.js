/**
 * Strategy Recommender Service
 *
 * Scores and ranks trading strategies for a given symbol using:
 *   1. Quick backtest (real win rate + return via backtestEngine)
 *   2. Instrument-type heuristic (index/stock/futures affinity)
 *   3. Optional AI commentary (via aiGateway cascade)
 *
 * Composite score = 0.40 * winRateNorm + 0.30 * returnNorm + 0.20 * sharpeNorm + 0.10 * typeAffinity
 */
const backtestEngine = require('./backtestEngine');
const logger = require('../utils/logger');

// ── Concurrency limiter ──────────────────────────────────────────────────
const MAX_CONCURRENT_BACKTESTS = parseInt(process.env.RECOMMEND_CONCURRENCY || '3', 10);

async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

// ── Recommendation cache (symbol → { timestamp, data }) ──────────────────
const CACHE_TTL_MS = parseInt(process.env.RECOMMEND_CACHE_TTL_MS || '300000', 10); // 5 minutes
const _cache = new Map();

// ── Per-backtest timeout ─────────────────────────────────────────────────
const BACKTEST_TIMEOUT_MS = parseInt(process.env.RECOMMEND_BACKTEST_TIMEOUT_MS || '5000', 10);

// ── Instrument-type affinity scores (0-100) ────────────────────────────
const TYPE_AFFINITY = {
  index:   { trend: 90, momentum: 85, mean_reversion: 70, reversal: 70, arbitrage: 60, market_making: 50, other: 60 },
  stock:   { mean_reversion: 90, reversal: 90, trend: 85, momentum: 80, arbitrage: 60, market_making: 50, other: 65 },
  futures: { arbitrage: 90, trend: 85, momentum: 80, mean_reversion: 70, reversal: 70, market_making: 75, other: 60 },
};

// ── Helpers ─────────────────────────────────────────────────────────────

function classifySymbol(symbol) {
  if (!symbol) return 'stock';
  const s = symbol.toLowerCase();
  // Futures: contains letters + numbers like 'rb2501', 'IF2506'
  if (/^[a-z]{1,2}\d{3,4}$/i.test(s)) return 'futures';
  // Index: sh000xxx, sz399xxx, 000xxx.SH
  if (/^(sh000|sz399|000\d{3}\.sh|399\d{3}\.sz)/i.test(s)) return 'index';
  return 'stock';
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Normalize a value into 0-100 given observed range.
 */
function normalize(value, min, max) {
  if (max === min) return 50;
  return clamp(((value - min) / (max - min)) * 100, 0, 100);
}

// ── Core ────────────────────────────────────────────────────────────────

class StrategyRecommender {
  /**
   * Run a quick backtest for a single strategy.
   * Returns { winRate, totalReturn, sharpeRatio } or null on failure/timeout.
   */
  async quickBacktest(signalCode, symbol, params = {}) {
    try {
      const btPromise = backtestEngine.run({
        symbol,
        initialCapital: 100000,
        signalFn: signalCode,
        params,
      });
      const timeout = new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('backtest timeout')), BACKTEST_TIMEOUT_MS);
        t.unref();
      });
      const result = await Promise.race([btPromise, timeout]);
      return {
        winRate: result.winRate,
        totalReturn: result.totalReturn,
        sharpeRatio: result.sharpeRatio,
        totalTrades: result.totalTrades,
      };
    } catch (err) {
      logger.warn('Quick backtest failed', { symbol, error: err.message });
      return null;
    }
  }

  /**
   * Extract the per-bar signal snippet from a full strategy function body.
   * backtestEngine.run() expects `signalFn` = per-bar code that receives
   * (bar, i, bars, params) and returns 'buy'|'sell'|null.
   *
   * Strategies stored in DB (seed.js) are already in this per-bar format.
   * Template strategies from the frontend use `function strategy(data, params) { ... }`.
   * We return whichever works.
   */
  extractSignalCode(code) {
    if (!code || typeof code !== 'string') return null;
    const trimmed = code.trim();

    // If it contains `function strategy(`, it's a full wrapper — not usable
    // directly by backtestEngine which expects per-bar code.
    // We can't easily convert, so return null to skip backtest.
    if (/function\s+strategy\s*\(/.test(trimmed)) return null;

    // Otherwise assume per-bar format (like seed.js strategies)
    return trimmed;
  }

  /**
   * Score and rank strategies for a given symbol.
   *
   * @param {Array} strategies - [{ id, name, type, code, parameters, ... }]
   * @param {string} symbol
   * @param {Object} options - { useAI, limit }
   * @returns {Array} ranked recommendations with real stats
   */
  async recommend(strategies, symbol, options = {}) {
    const { useAI = false, limit = 10 } = options;

    // Check cache first
    const cacheKey = `${symbol}:${strategies.length}:${limit}`;
    const cached = _cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
      return cached.data;
    }

    const instrumentType = classifySymbol(symbol);
    const affinityMap = TYPE_AFFINITY[instrumentType] || TYPE_AFFINITY.stock;

    // 1. Quick-backtest each strategy with concurrency limit
    const backtestTasks = strategies.map((s) => async () => {
      const signalCode = this.extractSignalCode(s.code);
      const bt = signalCode
        ? await this.quickBacktest(signalCode, symbol, s.parameters || {})
        : null;
      return { strategy: s, bt };
    });

    const results = await runWithConcurrency(backtestTasks, MAX_CONCURRENT_BACKTESTS);

    // 2. Collect ranges for normalization
    const bts = results.filter(r => r.bt).map(r => r.bt);
    const wrRange = bts.length ? [Math.min(...bts.map(b => b.winRate)), Math.max(...bts.map(b => b.winRate))] : [0, 100];
    const retRange = bts.length ? [Math.min(...bts.map(b => b.totalReturn)), Math.max(...bts.map(b => b.totalReturn))] : [-50, 50];
    const srRange = bts.length ? [Math.min(...bts.map(b => b.sharpeRatio)), Math.max(...bts.map(b => b.sharpeRatio))] : [-1, 3];

    // 3. Compute composite score
    const scored = results.map(({ strategy, bt }) => {
      const typeAffinity = affinityMap[strategy.type] || affinityMap.other || 60;

      let winRate, totalReturn, sharpeRatio, totalTrades;
      let hasBacktest = false;

      if (bt) {
        hasBacktest = true;
        winRate = bt.winRate;
        totalReturn = bt.totalReturn;
        sharpeRatio = bt.sharpeRatio;
        totalTrades = bt.totalTrades;
      } else {
        // Fallback: use type affinity as proxy
        winRate = typeAffinity * 0.7;
        totalReturn = 0;
        sharpeRatio = 0;
        totalTrades = 0;
      }

      const wrNorm = hasBacktest ? normalize(winRate, wrRange[0], wrRange[1]) : typeAffinity * 0.7;
      const retNorm = hasBacktest ? normalize(totalReturn, retRange[0], retRange[1]) : 50;
      const srNorm = hasBacktest ? normalize(sharpeRatio, srRange[0], srRange[1]) : 50;

      const compositeScore = Math.round(
        0.40 * wrNorm + 0.30 * retNorm + 0.20 * srNorm + 0.10 * typeAffinity
      );

      return {
        id: strategy.id,
        name: strategy.name,
        type: strategy.type || 'other',
        language: strategy.language || 'javascript',
        matchScore: clamp(compositeScore, 1, 99),
        stats: {
          winRate: parseFloat(winRate.toFixed(1)),
          return: parseFloat(totalReturn.toFixed(1)),
          sharpe: parseFloat(sharpeRatio.toFixed(2)),
          totalTrades,
        },
        hasBacktest,
        reason: this.generateReason(strategy, bt, instrumentType),
        code: strategy.code,
        parameters: strategy.parameters || {},
        isUserStrategy: strategy.isUserStrategy ?? false,
      };
    });

    // 4. Sort by composite score descending
    scored.sort((a, b) => b.matchScore - a.matchScore);

    // 5. Optional AI enhancement
    if (useAI && scored.length > 0) {
      try {
        await this.enhanceWithAI(scored.slice(0, 5), symbol, instrumentType);
      } catch (err) {
        logger.warn('AI recommendation enhancement failed, using backtest scores', { error: err.message });
      }
    }

    const finalResult = scored.slice(0, limit);

    // Cache result
    _cache.set(cacheKey, { timestamp: Date.now(), data: finalResult });
    // Evict old cache entries (keep max 50)
    if (_cache.size > 50) {
      const oldest = [..._cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldest) _cache.delete(oldest[0]);
    }

    return finalResult;
  }

  /**
   * Generate a human-readable recommendation reason.
   */
  generateReason(strategy, bt, instrumentType) {
    const typeLabels = {
      trend: '趋势跟踪', momentum: '动量捕捉', mean_reversion: '均值回归',
      reversal: '反转交易', arbitrage: '套利', market_making: '做市',
    };
    const instLabels = { index: '指数', stock: '个股', futures: '期货' };
    const typeLabel = typeLabels[strategy.type] || strategy.type || '通用';
    const instLabel = instLabels[instrumentType] || instrumentType;

    if (bt && bt.totalTrades > 0) {
      const outcome = bt.totalReturn > 0 ? '正收益' : '负收益';
      return `${typeLabel}策略，近期${instLabel}回测${bt.totalTrades}笔交易，胜率${bt.winRate.toFixed(0)}%，${outcome}`;
    }
    return `${typeLabel}策略，适合${instLabel}品种`;
  }

  /**
   * Enhance top recommendations with AI-generated commentary.
   */
  async enhanceWithAI(recommendations, symbol, instrumentType) {
    let gateway;
    try {
      gateway = require('./gateway/aiGateway');
    } catch {
      return; // gateway not available
    }

    const summary = recommendations.map(r =>
      `${r.name} (${r.type}): 胜率${r.stats.winRate}%, 收益${r.stats.return}%, Sharpe ${r.stats.sharpe}`
    ).join('\n');

    const prompt = `你是一个量化策略分析师。以下是针对${symbol}（${instrumentType}品种）的策略回测结果：

${summary}

请对每个策略给出一句话的投资建议（不超过30字），以JSON数组返回，格式：
[{"name":"策略名","advice":"建议"}]
只返回JSON，不要其他文字。`;

    const result = await gateway.generate(prompt, { timeout: 15000 });
    if (!result.success) return;

    try {
      // Extract JSON from response (may be wrapped in markdown code block)
      const jsonStr = result.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const advices = JSON.parse(jsonStr);
      if (!Array.isArray(advices)) return;

      for (const advice of advices) {
        const match = recommendations.find(r => r.name === advice.name);
        if (match && advice.advice) {
          match.aiAdvice = advice.advice;
          match.reason = advice.advice;
        }
      }
    } catch {
      // JSON parse failed — ignore, keep backtest reasons
    }
  }
}

module.exports = new StrategyRecommender();
