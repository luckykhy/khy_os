'use strict';

/**
 * usageTracker.js — Cost and token usage tracking service.
 *
 * Ported from OpenClaw's session-cost-usage.ts.
 * Tracks per-session token usage, cost estimation, and latency statistics.
 * Supports JSONL logging, tiered pricing, per-model aggregation.
 *
 * Constants:
 *   CACHE_VERSION = 2
 *   MAX_LATENCY_MS = 43200000 (12h)
 *   PRICING_TIERS defined per model family
 */

const fs = require('fs');
const path = require('path');
const { formatTokenCount, formatUsd, resolveModelCost, formatUsageLine } = require('./usageFormatter');

const CACHE_VERSION = 2;
const MAX_LATENCY_MS = 43_200_000; // 12 hours

// Pricing per 1M tokens (USD) — approximate
const PRICING = {
  'claude-3.5-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-haiku':    { input: 0.25, output: 1.25 },
  'claude-3-opus':     { input: 15.0, output: 75.0 },
  'gpt-4':             { input: 30.0, output: 60.0 },
  'gpt-4o':            { input: 5.0, output: 15.0 },
  'gpt-4o-mini':       { input: 0.15, output: 0.6 },
  'deepseek-v3':       { input: 0.27, output: 1.1 },
  'deepseek-r1':       { input: 0.55, output: 2.19 },
  'qwen-plus':         { input: 0.8, output: 2.0 },
  'default':           { input: 1.0, output: 3.0 },
};

class UsageTracker {
  /**
   * @param {object} [opts]
   * @param {string} [opts.logDir] - Directory for JSONL usage logs
   * @param {boolean} [opts.enableLogging=false] - Write JSONL logs to disk
   */
  constructor(opts = {}) {
    this._sessions = new Map(); // sessionId → SessionUsage
    this._globalStats = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUSD: 0,
      totalRequests: 0,
      startTime: Date.now(),
    };
    this._logDir = opts.logDir || null;
    this._enableLogging = opts.enableLogging || false;
    this._latencies = []; // for P50/P95/P99 calculation
    this._maxLatencies = 1000; // keep last 1000
    this._modelStats = new Map(); // model → { requests, inputTokens, outputTokens, costUSD }
  }

  /**
   * Record a model API call's usage.
   *
   * @param {object} usage
   * @param {string} usage.sessionId - Session identifier
   * @param {string} usage.model - Model name
   * @param {string} usage.provider - Provider/adapter name
   * @param {number} usage.inputTokens - Input token count
   * @param {number} usage.outputTokens - Output token count
   * @param {number} usage.durationMs - Request duration
   * @param {boolean} [usage.cached=false] - Whether response was cache hit
   * @param {boolean} [usage.success=true] - Whether request succeeded
   */
  record(usage) {
    const {
      sessionId = 'default',
      model = 'unknown',
      provider = 'unknown',
      inputTokens = 0,
      outputTokens = 0,
      durationMs = 0,
      cached = false,
      success = true,
    } = usage;

    // Calculate cost
    const pricing = this._getPricing(model);
    const costUSD = cached ? 0 :
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output;

    // Update session stats
    if (!this._sessions.has(sessionId)) {
      this._sessions.set(sessionId, {
        sessionId,
        startTime: Date.now(),
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUSD: 0,
        errors: 0,
        cacheHits: 0,
        byModel: {},
      });
    }

    const session = this._sessions.get(sessionId);
    session.requests++;
    session.inputTokens += inputTokens;
    session.outputTokens += outputTokens;
    session.costUSD += costUSD;
    if (!success) session.errors++;
    if (cached) session.cacheHits++;

    // Per-model in session
    if (!session.byModel[model]) {
      session.byModel[model] = { requests: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 };
    }
    session.byModel[model].requests++;
    session.byModel[model].inputTokens += inputTokens;
    session.byModel[model].outputTokens += outputTokens;
    session.byModel[model].costUSD += costUSD;

    // Update global stats
    this._globalStats.totalInputTokens += inputTokens;
    this._globalStats.totalOutputTokens += outputTokens;
    this._globalStats.totalCostUSD += costUSD;
    this._globalStats.totalRequests++;

    // Update model stats
    if (!this._modelStats.has(model)) {
      this._modelStats.set(model, { requests: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 });
    }
    const ms = this._modelStats.get(model);
    ms.requests++;
    ms.inputTokens += inputTokens;
    ms.outputTokens += outputTokens;
    ms.costUSD += costUSD;

    // Track latency (cap at MAX_LATENCY_MS to exclude stalls)
    if (durationMs > 0 && durationMs < MAX_LATENCY_MS && success) {
      this._latencies.push(durationMs);
      if (this._latencies.length > this._maxLatencies) {
        this._latencies.shift();
      }
    }

    // Write JSONL log
    if (this._enableLogging && this._logDir) {
      this._writeLog({
        v: CACHE_VERSION,
        ts: Date.now(),
        sessionId,
        model,
        provider,
        inputTokens,
        outputTokens,
        costUSD: Math.round(costUSD * 1_000_000) / 1_000_000,
        durationMs,
        cached,
        success,
      });
    }

    return { costUSD, pricing };
  }

  /**
   * Get session-level usage summary.
   */
  getSessionSummary(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return null;

    return {
      ...session,
      costUSD: Math.round(session.costUSD * 10000) / 10000,
      durationMs: Date.now() - session.startTime,
    };
  }

  /**
   * Get global usage summary with latency percentiles.
   */
  getGlobalSummary() {
    return {
      ...this._globalStats,
      costUSD: Math.round(this._globalStats.totalCostUSD * 10000) / 10000,
      uptimeMs: Date.now() - this._globalStats.startTime,
      activeSessions: this._sessions.size,
      latencyP50: this._percentile(50),
      latencyP95: this._percentile(95),
      latencyP99: this._percentile(99),
    };
  }

  /**
   * Get per-model usage breakdown.
   */
  getModelBreakdown() {
    const result = {};
    for (const [model, stats] of this._modelStats) {
      result[model] = {
        ...stats,
        costUSD: Math.round(stats.costUSD * 10000) / 10000,
        avgTokensPerRequest: stats.requests > 0
          ? Math.round((stats.inputTokens + stats.outputTokens) / stats.requests)
          : 0,
      };
    }
    return result;
  }

  /**
   * Format cost summary as human-readable string.
   * Uses usageFormatter for human-friendly token counts and USD.
   */
  formatSummary(sessionId) {
    const s = sessionId ? this.getSessionSummary(sessionId) : null;
    const g = this.getGlobalSummary();

    const lines = [];
    if (s) {
      const sessionLine = formatUsageLine({
        usage: { input: s.inputTokens, output: s.outputTokens, model: Object.keys(s.byModel)[0] },
        showCost: true,
      });
      lines.push(`Session: ${s.requests} req, ${sessionLine || formatTokenCount(s.inputTokens + s.outputTokens) + ' tokens'}`);
      if (s.cacheHits > 0) lines.push(`  Cache hits: ${s.cacheHits}`);
      if (s.errors > 0) lines.push(`  Errors: ${s.errors}`);
    }

    const globalCost = formatUsd(g.costUSD) || `$${g.costUSD}`;
    lines.push(`Global: ${g.totalRequests} req, ${formatTokenCount(g.totalInputTokens)} in / ${formatTokenCount(g.totalOutputTokens)} out, ${globalCost}`);
    if (g.latencyP50) lines.push(`  Latency P50/P95/P99: ${g.latencyP50}/${g.latencyP95}/${g.latencyP99}ms`);

    return lines.join('\n');
  }

  /**
   * Clean up old sessions (older than maxAgeMs).
   */
  cleanup(maxAgeMs = 3_600_000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, session] of this._sessions) {
      if (session.startTime < cutoff) {
        this._sessions.delete(id);
      }
    }
  }

  // ── Internal ──

  _getPricing(model) {
    // Exact match first, then most-specific substring match. Picking the FIRST
    // substring hit (old behavior) mis-prices versioned ids: 'gpt-4o-2024-08-06'
    // contains both 'gpt-4' and 'gpt-4o', and 'gpt-4' sits earlier in the table,
    // so it resolved to the 6× pricier gpt-4 tier (gpt-4o-mini-* was 200× off).
    // Choosing the LONGEST matching key resolves each id to its real tier while
    // keeping the same set of matchable models as `includes`.
    if (PRICING[model]) return PRICING[model];
    let best = null;
    let bestLen = -1;
    for (const [key, pricing] of Object.entries(PRICING)) {
      if (key !== 'default' && model.includes(key) && key.length > bestLen) {
        best = pricing;
        bestLen = key.length;
      }
    }
    return best || PRICING.default;
  }

  _percentile(p) {
    if (this._latencies.length === 0) return null;
    const sorted = [...this._latencies].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  _writeLog(entry) {
    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      const logFile = path.join(this._logDir, `usage-${dateStr}.jsonl`);
      fs.mkdirSync(this._logDir, { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
    } catch { /* non-critical, swallow */ }
  }
}

// Singleton instance
const usageTracker = new UsageTracker();

module.exports = {
  UsageTracker,
  usageTracker,
  PRICING,
  CACHE_VERSION,
  MAX_LATENCY_MS,
};
