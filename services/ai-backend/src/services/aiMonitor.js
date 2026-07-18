/**
 * AI Monitor — request/response tracing and real-time monitoring.
 *
 * Features:
 * - Full request/response logging (prompt, response, tokens, latency)
 * - Cascade tracking (which adapters tried, why they failed)
 * - Ring buffer for memory efficiency (configurable max traces)
 * - SSE event stream for real-time monitoring
 * - Stats aggregation (total, success rate, avg latency)
 */
const { EventEmitter } = require('events');
const crypto = require('crypto');

const MAX_TRACES = parseInt(process.env.AI_MONITOR_MAX_TRACES, 10) || 100;
const ENABLED = process.env.AI_MONITOR_ENABLED !== 'false';

// Ring buffer for traces
const _traces = [];
const _traceMap = new Map(); // O(1) lookup by traceId
let _totalCount = 0;
let _successCount = 0;
let _failureCount = 0;
let _totalLatencyMs = 0;

// SSE event emitter
const _events = new EventEmitter();
_events.setMaxListeners(50);

/**
 * Start a new trace for an AI request.
 * @param {object} request - { prompt, model, adapter, options }
 * @returns {string} traceId
 */
function startTrace(request) {
  if (!ENABLED) return null;

  const traceId = `trace_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const trace = {
    id: traceId,
    startTime: Date.now(),
    endTime: null,
    latencyMs: null,
    request: {
      prompt: truncate(request.prompt, 500),
      model: request.model || null,
      adapter: request.adapter || null,
      options: request.options ? { ...request.options, onChunk: undefined } : null,
    },
    response: null,
    cascade: [],
    success: null,
    error: null,
    tokens: null,
  };

  // Add to ring buffer
  if (_traces.length >= MAX_TRACES) {
    const removed = _traces.shift();
    _traceMap.delete(removed.id);
  }
  _traces.push(trace);
  _traceMap.set(traceId, trace);
  _totalCount++;

  _events.emit('trace:start', trace);
  return traceId;
}

/**
 * Record a cascade attempt (adapter tried during fallback).
 * @param {string} traceId
 * @param {object} attempt - { adapter, success, latencyMs, error, model }
 */
function addCascadeAttempt(traceId, attempt) {
  if (!ENABLED || !traceId) return;

  const trace = _traceMap.get(traceId);
  if (!trace) return;

  trace.cascade.push({
    adapter: attempt.adapter,
    success: attempt.success,
    latencyMs: attempt.latencyMs || 0,
    error: attempt.error || null,
    model: attempt.model || null,
    timestamp: Date.now(),
  });

  _events.emit('trace:cascade', { traceId, attempt });
}

/**
 * End a trace with the final response.
 * @param {string} traceId
 * @param {object} response - { content, model, provider, tokens }
 * @param {object} [meta] - Additional metadata
 */
function endTrace(traceId, response, meta = {}) {
  if (!ENABLED || !traceId) return;

  const trace = _traceMap.get(traceId);
  if (!trace) return;

  trace.endTime = Date.now();
  trace.latencyMs = trace.endTime - trace.startTime;

  if (response) {
    trace.success = true;
    trace.response = {
      content: truncate(response.content, 500),
      model: response.model || null,
      provider: response.provider || null,
    };
    trace.tokens = response.tokens || meta.tokens || null;
    _successCount++;
    _totalLatencyMs += trace.latencyMs;
  } else {
    trace.success = false;
    trace.error = meta.error || 'No response';
    _failureCount++;
  }

  _events.emit('trace:end', trace);
}

/**
 * Query traces with optional filters.
 * @param {object} filter - { limit, offset, provider, success, since }
 * @returns {{ traces: object[], total: number }}
 */
function getTraces(filter = {}) {
  let results = [..._traces];

  if (filter.provider) {
    results = results.filter(t => t.request?.adapter === filter.provider || t.response?.provider === filter.provider);
  }
  if (filter.success !== undefined) {
    results = results.filter(t => t.success === filter.success);
  }
  if (filter.since) {
    const since = typeof filter.since === 'number' ? filter.since : new Date(filter.since).getTime();
    results = results.filter(t => t.startTime >= since);
  }

  // Sort newest first
  results.sort((a, b) => b.startTime - a.startTime);

  const total = results.length;
  const offset = filter.offset || 0;
  const limit = filter.limit || 20;
  results = results.slice(offset, offset + limit);

  return { traces: results, total };
}

/**
 * Get aggregated statistics.
 */
function getStats() {
  const total = _totalCount;
  const successRate = total > 0 ? (_successCount / total * 100).toFixed(1) : '0.0';
  const avgLatency = _successCount > 0 ? Math.round(_totalLatencyMs / _successCount) : 0;

  // Per-provider breakdown
  const providers = {};
  for (const trace of _traces) {
    const key = trace.response?.provider || trace.request?.adapter || 'unknown';
    if (!providers[key]) providers[key] = { total: 0, success: 0, failure: 0, totalLatency: 0 };
    providers[key].total++;
    if (trace.success) {
      providers[key].success++;
      providers[key].totalLatency += trace.latencyMs || 0;
    } else {
      providers[key].failure++;
    }
  }

  for (const key of Object.keys(providers)) {
    providers[key].avgLatency = providers[key].success > 0
      ? Math.round(providers[key].totalLatency / providers[key].success) : 0;
    providers[key].successRate = providers[key].total > 0
      ? (providers[key].success / providers[key].total * 100).toFixed(1) : '0.0';
  }

  return {
    total,
    success: _successCount,
    failure: _failureCount,
    successRate: `${successRate}%`,
    avgLatencyMs: avgLatency,
    bufferSize: _traces.length,
    maxBufferSize: MAX_TRACES,
    providers,
  };
}

/**
 * Create an SSE event stream for real-time monitoring.
 * @returns {EventEmitter}
 */
function createEventStream() {
  return _events;
}

/**
 * Clear all traces and reset stats.
 */
function clearTraces() {
  _traces.length = 0;
  _traceMap.clear();
  _totalCount = 0;
  _successCount = 0;
  _failureCount = 0;
  _totalLatencyMs = 0;
  _events.emit('trace:clear');
}

/**
 * Get the latest N traces (for quick display).
 */
function getRecent(n = 10) {
  return _traces.slice(-n).reverse();
}

// ── Helpers ──

function truncate(str, maxLen) {
  if (!str) return '';
  if (typeof str !== 'string') str = String(str);
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

module.exports = {
  startTrace,
  addCascadeAttempt,
  endTrace,
  getTraces,
  getStats,
  createEventStream,
  clearTraces,
  getRecent,
  ENABLED,
};
