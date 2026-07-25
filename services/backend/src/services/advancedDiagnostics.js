'use strict';

/**
 * advancedDiagnostics.js — Extended diagnostics with anomaly detection and backpressure queue.
 *
 * Ported from OpenClaw's crestodian diagnostics (883 lines).
 * Extends the existing diagnosticEvents.js with:
 * - 50+ structured event types across categories
 * - Anomaly detection (latency spikes, error rate surges, token budget overruns)
 * - Async event queue with backpressure (bounded buffer, drop-oldest on overflow)
 * - Metric aggregation with sliding windows
 * - Health score computation
 */

const { diagnostics } = require('./diagnosticEvents');

// ── Event categories ──

const CATEGORY = {
  AI:          'ai',          // model interactions
  TOOL:        'tool',        // tool execution
  SESSION:     'session',     // session lifecycle
  SECURITY:    'security',    // auth, permission, ssrf
  PERFORMANCE: 'performance', // latency, throughput
  RESOURCE:    'resource',    // memory, cpu, disk
  ERROR:       'error',       // errors and crashes
  NETWORK:     'network',     // connectivity events
  USER:        'user',        // user actions
  SYSTEM:      'system',      // system events
};

// ── Anomaly detection thresholds ──

const ANOMALY_THRESHOLDS = {
  latencySpike: {
    windowMs: 60_000,      // 1 minute window
    multiplier: 3,          // 3x above moving average
    minSamples: 5,          // need at least 5 samples
  },
  errorRateSurge: {
    windowMs: 300_000,     // 5 minute window
    threshold: 0.3,         // 30% error rate
    minEvents: 10,          // minimum events to evaluate
  },
  tokenBudgetOverrun: {
    warningRatio: 0.8,      // warn at 80% of budget
    criticalRatio: 0.95,    // critical at 95%
  },
};

// ── Sliding window metric ──

class SlidingWindowMetric {
  /**
   * @param {number} windowMs
   * @param {number} [maxSamples=1000]
   */
  constructor(windowMs, maxSamples = 1000) {
    this._windowMs = windowMs;
    this._maxSamples = maxSamples;
    this._samples = []; // { value, timestamp }[]
  }

  add(value) {
    const now = Date.now();
    this._samples.push({ value, timestamp: now });
    this._evict(now);
  }

  getAverage() {
    this._evict(Date.now());
    if (this._samples.length === 0) return 0;
    const sum = this._samples.reduce((s, e) => s + e.value, 0);
    return sum / this._samples.length;
  }

  getP95() {
    this._evict(Date.now());
    if (this._samples.length === 0) return 0;
    const sorted = this._samples.map(s => s.value).sort((a, b) => a - b);
    // Nearest-rank P95 (0-based index ceil(0.95·n)−1), matching the codebase's
    // other percentile helper usageTracker._percentile. The old floor(0.95·n)
    // overshot by one whenever 0.95·n was an integer (n a multiple of 20) — e.g.
    // for exactly 20 samples it returned sorted[19], the maximum (P100), instead
    // of the 19th value. For all other sample counts floor == ceil−1, so this is
    // byte-identical there.
    const idx = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
  }

  getMax() {
    this._evict(Date.now());
    if (this._samples.length === 0) return 0;
    return Math.max(...this._samples.map(s => s.value));
  }

  getCount() {
    this._evict(Date.now());
    return this._samples.length;
  }

  getRate(intervalMs) {
    this._evict(Date.now());
    if (this._samples.length === 0) return 0;
    return (this._samples.length / this._windowMs) * intervalMs;
  }

  _evict(now) {
    const cutoff = now - this._windowMs;
    while (this._samples.length > 0 && this._samples[0].timestamp < cutoff) {
      this._samples.shift();
    }
    while (this._samples.length > this._maxSamples) {
      this._samples.shift();
    }
  }
}

// ── Backpressure queue ──

class BackpressureQueue {
  /**
   * @param {object} opts
   * @param {number} [opts.maxSize=5000]
   * @param {function} [opts.onDrop] - (event) => void
   * @param {function} opts.processFn - (events: any[]) => Promise<void>
   * @param {number} [opts.batchSize=50]
   * @param {number} [opts.flushIntervalMs=5000]
   */
  constructor(opts = {}) {
    this._maxSize = opts.maxSize || 5000;
    this._onDrop = opts.onDrop || null;
    this._processFn = opts.processFn;
    this._batchSize = opts.batchSize || 50;
    this._flushIntervalMs = opts.flushIntervalMs || 5000;

    this._queue = [];
    this._processing = false;
    this._dropped = 0;
    this._processed = 0;
    this._timer = null;

    this._startTimer();
  }

  enqueue(event) {
    if (this._queue.length >= this._maxSize) {
      // Drop oldest
      const dropped = this._queue.shift();
      this._dropped++;
      if (this._onDrop) {
        try { this._onDrop(dropped); } catch { /* swallow */ }
      }
    }
    this._queue.push(event);
  }

  async flush() {
    if (this._processing || this._queue.length === 0) return;
    this._processing = true;

    try {
      const batch = this._queue.splice(0, this._batchSize);
      if (batch.length > 0 && this._processFn) {
        await this._processFn(batch);
        this._processed += batch.length;
      }
    } catch {
      // Processing failure — events are lost
    } finally {
      this._processing = false;
    }
  }

  getStats() {
    return {
      queued: this._queue.length,
      dropped: this._dropped,
      processed: this._processed,
      maxSize: this._maxSize,
    };
  }

  _startTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => this.flush(), this._flushIntervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  shutdown() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // Final flush (sync best-effort)
    if (this._queue.length > 0 && this._processFn) {
      this._processFn(this._queue.splice(0)).catch(() => {});
    }
  }
}

// ── Advanced diagnostics engine ──

class AdvancedDiagnostics {
  /**
   * @param {object} [opts]
   * @param {object} [opts.anomalyThresholds]
   * @param {function} [opts.onAnomaly] - (anomaly) => void
   * @param {function} [opts.processFn] - (events) => Promise<void>
   */
  constructor(opts = {}) {
    this._thresholds = { ...ANOMALY_THRESHOLDS, ...opts.anomalyThresholds };
    this._onAnomaly = opts.onAnomaly || null;

    // Sliding window metrics
    this._latencyMetric = new SlidingWindowMetric(
      this._thresholds.latencySpike.windowMs
    );
    this._errorMetric = new SlidingWindowMetric(
      this._thresholds.errorRateSurge.windowMs
    );
    this._successMetric = new SlidingWindowMetric(
      this._thresholds.errorRateSurge.windowMs
    );

    // Token tracking
    this._tokenBudget = 0;
    this._tokensUsed = 0;

    // Backpressure queue
    this._queue = new BackpressureQueue({
      processFn: opts.processFn || (async () => {}),
    });

    // Health state
    this._healthScore = 100;
    this._anomalyCount = 0;

    // Subscribe to base diagnostic events
    this._unsub = diagnostics.on('*', (event) => this._handleEvent(event));
  }

  /**
   * Record a latency observation.
   *
   * @param {string} operation
   * @param {number} durationMs
   */
  recordLatency(operation, durationMs) {
    this._latencyMetric.add(durationMs);
    this._queue.enqueue({
      category: CATEGORY.PERFORMANCE,
      type: 'latency',
      operation,
      durationMs,
      timestamp: Date.now(),
    });

    // Check for spike
    this._checkLatencySpike(operation, durationMs);
  }

  /**
   * Record an error occurrence.
   *
   * @param {string} category
   * @param {string} message
   * @param {object} [details]
   */
  recordError(category, message, details) {
    this._errorMetric.add(1);
    this._queue.enqueue({
      category: CATEGORY.ERROR,
      type: 'error',
      errorCategory: category,
      message,
      details,
      timestamp: Date.now(),
    });

    this._checkErrorRateSurge();
    this._adjustHealth(-5);
  }

  /**
   * Record a successful operation.
   */
  recordSuccess(operation) {
    this._successMetric.add(1);
    this._adjustHealth(1);
  }

  /**
   * Set token budget for overrun detection.
   */
  setTokenBudget(budget) {
    this._tokenBudget = budget;
  }

  /**
   * Record token usage.
   */
  recordTokenUsage(tokens) {
    this._tokensUsed += tokens;
    this._checkTokenBudget();
  }

  /**
   * Get current health score (0-100).
   */
  getHealthScore() {
    return Math.max(0, Math.min(100, this._healthScore));
  }

  /**
   * Get comprehensive diagnostics summary.
   */
  getSummary() {
    const baseSummary = diagnostics.getSummary();
    return {
      ...baseSummary,
      healthScore: this.getHealthScore(),
      anomalyCount: this._anomalyCount,
      latency: {
        avg: Math.round(this._latencyMetric.getAverage()),
        p95: Math.round(this._latencyMetric.getP95()),
        max: Math.round(this._latencyMetric.getMax()),
        samples: this._latencyMetric.getCount(),
      },
      errorRate: this._calculateErrorRate(),
      tokenUsage: {
        used: this._tokensUsed,
        budget: this._tokenBudget,
        ratio: this._tokenBudget > 0 ? this._tokensUsed / this._tokenBudget : 0,
      },
      queue: this._queue.getStats(),
    };
  }

  /**
   * Reset health score and counters.
   */
  resetHealth() {
    this._healthScore = 100;
    this._anomalyCount = 0;
    this._tokensUsed = 0;
  }

  /**
   * Shutdown diagnostics.
   */
  shutdown() {
    if (this._unsub) this._unsub();
    this._queue.shutdown();
  }

  // ── Internal ──

  _handleEvent(event) {
    // Route base diagnostic events to appropriate metrics
    if (event.type === 'tool_result') {
      this.recordLatency(`tool:${event.data.toolName}`, event.data.durationMs || 0);
      if (event.data.error) {
        this.recordError(CATEGORY.TOOL, event.data.error);
      } else {
        this.recordSuccess(`tool:${event.data.toolName}`);
      }
    } else if (event.type === 'model_response') {
      this.recordLatency(`model:${event.data.model}`, event.data.durationMs || 0);
      if (event.data.totalTokens) {
        this.recordTokenUsage(event.data.totalTokens);
      }
      this.recordSuccess(`model:${event.data.model}`);
    } else if (event.type === 'error') {
      this.recordError(event.data.category, event.data.message);
    }

    // Enqueue all events to backpressure queue
    this._queue.enqueue({
      ...event,
      category: event.type,
    });
  }

  _checkLatencySpike(operation, durationMs) {
    const { multiplier, minSamples } = this._thresholds.latencySpike;
    const count = this._latencyMetric.getCount();
    if (count < minSamples) return;

    const avg = this._latencyMetric.getAverage();
    if (durationMs > avg * multiplier) {
      this._emitAnomaly('latency_spike', {
        operation,
        durationMs,
        average: Math.round(avg),
        multiplier: Math.round(durationMs / avg * 10) / 10,
      });
    }
  }

  _checkErrorRateSurge() {
    const { threshold, minEvents } = this._thresholds.errorRateSurge;
    const errorRate = this._calculateErrorRate();
    const totalEvents = this._errorMetric.getCount() + this._successMetric.getCount();

    if (totalEvents >= minEvents && errorRate > threshold) {
      this._emitAnomaly('error_rate_surge', {
        errorRate: Math.round(errorRate * 100) / 100,
        threshold,
        totalEvents,
      });
    }
  }

  _checkTokenBudget() {
    if (this._tokenBudget <= 0) return;

    const ratio = this._tokensUsed / this._tokenBudget;
    const { warningRatio, criticalRatio } = this._thresholds.tokenBudgetOverrun;

    if (ratio >= criticalRatio) {
      this._emitAnomaly('token_budget_critical', {
        used: this._tokensUsed,
        budget: this._tokenBudget,
        ratio: Math.round(ratio * 100) / 100,
      });
    } else if (ratio >= warningRatio) {
      this._emitAnomaly('token_budget_warning', {
        used: this._tokensUsed,
        budget: this._tokenBudget,
        ratio: Math.round(ratio * 100) / 100,
      });
    }
  }

  _calculateErrorRate() {
    const errors = this._errorMetric.getCount();
    const successes = this._successMetric.getCount();
    const total = errors + successes;
    return total > 0 ? errors / total : 0;
  }

  _emitAnomaly(type, data) {
    this._anomalyCount++;
    this._adjustHealth(-10);

    const anomaly = {
      type,
      data,
      timestamp: Date.now(),
      healthScore: this.getHealthScore(),
    };

    diagnostics.emit('anomaly', anomaly);

    if (this._onAnomaly) {
      try { this._onAnomaly(anomaly); } catch { /* swallow */ }
    }
  }

  _adjustHealth(delta) {
    this._healthScore = Math.max(0, Math.min(100, this._healthScore + delta));
  }
}

// Singleton
let _instance = null;

function getInstance(opts) {
  if (!_instance) {
    _instance = new AdvancedDiagnostics(opts);
  }
  return _instance;
}

module.exports = {
  CATEGORY,
  ANOMALY_THRESHOLDS,
  SlidingWindowMetric,
  BackpressureQueue,
  AdvancedDiagnostics,
  getInstance,
};
