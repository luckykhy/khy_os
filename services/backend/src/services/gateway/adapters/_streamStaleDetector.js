'use strict';

/**
 * StreamStaleDetector — detects stale SSE streams across all adapters.
 *
 * Tracks last chunk time per active stream. When no data arrives within
 * a provider-specific threshold, fires the onStale callback (typically
 * to abort and trigger retry/fallback).
 *
 * Provider thresholds account for typical response patterns:
 * - Claude: extended thinking can pause output for 60-90s
 * - GPT/OpenAI: typically fast, 45s silence is suspicious
 * - DeepSeek: slower inference, 90s threshold
 * - Ollama: local, variable speed, 120s
 * - Default: 90s
 */

const PROVIDER_STALE_MS = Object.freeze({
  claude:   90_000,
  anthropic: 90_000,
  gpt:      45_000,
  openai:   45_000,
  deepseek: 90_000,
  ollama:   120_000,
  gemini:   60_000,
  default:  90_000,
});

// Pre-projected provider keys for the prefix match. Hoisted to a module constant
// (Ch2「不要每轮重建可复用结构」): a StreamStaleDetector is constructed per streaming
// request across all adapters, and the constructor rebuilt this keys array on every
// construction. PROVIDER_STALE_MS is frozen above (mutation impossible), so the keys
// snapshot is stable; insertion order is preserved, keeping the prefix .find() match
// byte-identical to the prior per-call Object.keys().
const _PROVIDER_STALE_KEYS = Object.keys(PROVIDER_STALE_MS);

// ── I1 阈值调优(门控 KHY_STREAM_STALE_TUNING,默认开)──────────────────────
// 病根:推理模型(o1/o3、deepseek-r1、thinking 模式)在**首 token 之前**会静默思考,
// 远超历史 gpt/openai 45s 底线 → `_check()` 判 stale → `ac.abort()` → 任务被莫名中断。
// 修复(全部在门开时才生效,门关逐字节回退旧行为):
//   1) 把 gpt/openai 的稳态底线抬到与 default 一致的 90s(其余 provider 不动)。
//   2) 首 token 宽限:首 chunk 到达前用 `KHY_STREAM_FIRST_TOKEN_GRACE_MS`(默认 120s),
//      给静默推理留足时间;首 chunk 一到即回落到稳态阈值。
//   3) `KHY_STREAM_STALE_MS`(numeric>0)可整体覆盖稳态阈值,便于现场按 provider 调参。
// 契约与本文件一致:纯读 env、确定性、绝不抛。显式 options.thresholdMs 仍最高优先(调用方最懂)。
const _FALSY = new Set(['0', 'false', 'off', 'no']);
const _norm = require('../../../utils/normLower');
const _FAST_PROVIDER_KEYS = new Set(['gpt', 'openai']);
const _FAST_FLOOR_MS = 90_000;        // gpt/openai 抬齐 default
const _DEFAULT_GRACE_MS = 120_000;    // 首 token 宽限默认值

/** 门控:默认开,仅显式 0/false/off/no 才关。 */
function _isStaleTuningEnabled(env) {
  return !_FALSY.has(_norm(env && env.KHY_STREAM_STALE_TUNING));
}

/** 解析非负毫秒 env;非法/缺省 → fallback。绝不抛。 */
function _parseNonNegMs(raw, fallback) {
  const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 计算调优后的稳态阈值与首 token 宽限(纯函数,绝不抛)。
 * 门关 → { thresholdMs: 旧查表值, graceMs: 0 } 逐字节等价旧行为。
 * @returns {{ thresholdMs:number, graceMs:number }}
 */
function _resolveStaleTuning(matchedKey, options, env) {
  const legacy = options.thresholdMs || PROVIDER_STALE_MS[matchedKey] || PROVIDER_STALE_MS.default;
  // 显式 thresholdMs 覆盖或门关:不做任何调优,零宽限,字节等价。
  if (options.thresholdMs || !_isStaleTuningEnabled(env)) {
    return { thresholdMs: legacy, graceMs: 0 };
  }
  let base = PROVIDER_STALE_MS[matchedKey] || PROVIDER_STALE_MS.default;
  if (_FAST_PROVIDER_KEYS.has(matchedKey)) base = Math.max(base, _FAST_FLOOR_MS);
  const override = _parseNonNegMs(env && env.KHY_STREAM_STALE_MS, 0);
  if (override > 0) base = override;
  const graceMs = _parseNonNegMs(env && env.KHY_STREAM_FIRST_TOKEN_GRACE_MS, _DEFAULT_GRACE_MS);
  return { thresholdMs: base, graceMs };
}


class StreamStaleDetector {
  /**
   * @param {object} options
   * @param {string}   [options.provider='default'] - Provider name for threshold lookup
   * @param {number}   [options.thresholdMs]        - Override threshold (ms)
   * @param {Function} [options.onStale]            - Called when stream goes stale: (elapsedMs) => void
   * @param {Function} [options.onWarn]             - Called at 80% of threshold: (elapsedMs) => void
   */
  constructor(options = {}) {
    const provider = String(options.provider || 'default').toLowerCase();
    // Match provider prefix (e.g. "claude-3-opus" → "claude")
    const matchedKey = _PROVIDER_STALE_KEYS.find(k => provider.includes(k));
    const tuned = _resolveStaleTuning(matchedKey, options, options.env || process.env);
    this._thresholdMs = tuned.thresholdMs;
    // 首 token 宽限:首 chunk 未到之前用 max(阈值, graceMs);首 chunk 一到即回落稳态阈值。
    // graceMs===0(门关/显式覆盖)时 _graceMs === _thresholdMs,首 token 前后阈值一致 → 字节等价。
    this._graceMs = Math.max(this._thresholdMs, tuned.graceMs || 0);
    this._warnMs = Math.floor(this._thresholdMs * 0.8);
    this._onStale = options.onStale || null;
    this._onWarn = options.onWarn || null;
    this._lastChunkTs = Date.now();
    this._timer = null;
    this._warned = false;
    this._stale = false;
    this._provider = provider;

    // ── Diagnostic latency tracking ──
    this._chunkCount = 0;
    this._totalBytes = 0;
    this._latencies = [];       // inter-chunk latency samples (ms)
    this._minLatency = Infinity;
    this._maxLatency = 0;
    this._sumLatency = 0;
    this._firstChunkTs = null;
    this._lastTouchTs = null;
  }

  /**
   * Start monitoring. Call after stream connection is established.
   */
  start() {
    if (this._timer) return this;
    this._lastChunkTs = Date.now();
    this._warned = false;
    this._stale = false;
    this._timer = setInterval(() => this._check(), Math.min(5000, this._warnMs));
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  /**
   * Call on every received data chunk to reset the stale timer.
   * @param {number} [byteLen=0] - Size of the chunk in bytes (for throughput tracking)
   */
  touch(byteLen = 0) {
    const now = Date.now();
    // Record inter-chunk latency
    if (this._lastTouchTs !== null) {
      const gap = now - this._lastTouchTs;
      this._latencies.push(gap);
      this._sumLatency += gap;
      if (gap < this._minLatency) this._minLatency = gap;
      if (gap > this._maxLatency) this._maxLatency = gap;
    } else {
      this._firstChunkTs = now;
    }
    this._lastTouchTs = now;
    this._chunkCount++;
    this._totalBytes += (byteLen || 0);
    this._lastChunkTs = now;
    this._warned = false;
  }

  /**
   * Stop monitoring, clean up, and emit stream health telemetry.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // Emit stream health telemetry on stop (non-blocking, best-effort).
    // Inverted via _streamHealthSink (DESIGN-ARCH-051 §6.4): the detector no
    // longer reaches up into the telemetryService singleton; telemetry registers
    // itself as the sink at load. No-op when no sink is registered — exactly the
    // pre-existing "telemetry unavailable" fallthrough.
    if (this._chunkCount > 0) {
      try {
        const stats = this.getLatencyStats();
        require('../_streamHealthSink').emitStreamHealth({
          service: 'stream_health',
          method: `${this._provider}_stream`,
          success: !this._stale,
          elapsed: stats.totalDurationMs,
          meta: { chunkCount: stats.chunkCount, p50: stats.p50, p95: stats.p95, totalBytes: stats.totalBytes },
        });
      } catch { /* sink unavailable */ }
    }
  }

  /**
   * Whether the stream has been declared stale.
   */
  get isStale() {
    return this._stale;
  }

  /**
   * Get diagnostic latency statistics for the current stream.
   * @returns {{ chunkCount, totalBytes, totalDurationMs, minMs, maxMs, avgMs, p50, p95, provider, stale }}
   */
  getLatencyStats() {
    const count = this._latencies.length;
    if (count === 0) {
      return {
        chunkCount: this._chunkCount, totalBytes: this._totalBytes,
        totalDurationMs: 0, minMs: 0, maxMs: 0, avgMs: 0, p50: 0, p95: 0,
        provider: this._provider, stale: this._stale,
      };
    }
    const sorted = this._latencies.slice().sort((a, b) => a - b);
    const p50 = sorted[Math.floor(count * 0.5)];
    const p95 = sorted[Math.floor(count * 0.95)];
    const totalDuration = this._lastTouchTs && this._firstChunkTs
      ? this._lastTouchTs - this._firstChunkTs : 0;
    return {
      chunkCount: this._chunkCount,
      totalBytes: this._totalBytes,
      totalDurationMs: totalDuration,
      minMs: this._minLatency === Infinity ? 0 : this._minLatency,
      maxMs: this._maxLatency,
      avgMs: Math.round(this._sumLatency / count),
      p50,
      p95,
      provider: this._provider,
      stale: this._stale,
    };
  }

  _check() {
    const elapsed = Date.now() - this._lastChunkTs;
    // 首 token 宽限:首 chunk 到达前(_firstChunkTs 仍为 null)用更宽的 _graceMs,
    // 给推理模型的静默思考留足时间;首 chunk 一到即回落稳态 _thresholdMs。
    // 门关时 _graceMs === _thresholdMs,此分支与旧逻辑逐字节等价。
    const activeThreshold = this._firstChunkTs === null ? this._graceMs : this._thresholdMs;
    const activeWarn = this._firstChunkTs === null ? Math.floor(this._graceMs * 0.8) : this._warnMs;
    if (elapsed >= activeThreshold && !this._stale) {
      this._stale = true;
      this.stop();
      if (this._onStale) {
        try { this._onStale(elapsed); } catch { /* non-critical */ }
      }
    } else if (elapsed >= activeWarn && !this._warned) {
      this._warned = true;
      if (this._onWarn) {
        try { this._onWarn(elapsed); } catch { /* non-critical */ }
      }
    }
  }
}

/**
 * Wrap a Node.js readable stream with stale detection.
 * Returns the detector instance for manual stop if needed.
 *
 * @param {import('stream').Readable} stream - The data stream to monitor
 * @param {object} options - StreamStaleDetector options + { abortController }
 * @returns {StreamStaleDetector}
 */
function attachStaleDetector(stream, options = {}) {
  const ac = options.abortController || null;
  const detector = new StreamStaleDetector({
    ...options,
    onStale: (elapsed) => {
      if (ac) {
        try { ac.abort(`Stream stale: no data for ${Math.round(elapsed / 1000)}s`); } catch { /* ignore */ }
      }
      if (options.onStale) {
        try { options.onStale(elapsed); } catch { /* ignore */ }
      }
    },
  });
  stream.on('data', (chunk) => detector.touch(chunk ? chunk.length : 0));
  stream.on('end', () => detector.stop());
  stream.on('error', () => detector.stop());
  stream.on('close', () => detector.stop());
  detector.start();
  return detector;
}

module.exports = {
  StreamStaleDetector,
  attachStaleDetector,
  PROVIDER_STALE_MS,
};
