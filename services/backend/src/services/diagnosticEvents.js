'use strict';

/**
 * diagnosticEvents.js — Structured diagnostic event system with trace context.
 *
 * Ported from OpenClaw's diagnostic-events.ts.
 * Provides structured event emission for AI tool calls, session state
 * transitions, and model interactions. Uses W3C trace context for
 * distributed tracing.
 *
 * Event types: tool_call, tool_result, model_request, model_response,
 *   session_state, attention, error
 *
 * Constants:
 *   ATTENTION_LONG_RUNNING_MS = 30000
 *   ATTENTION_STALLED_MS = 120000
 *   MAX_EVENT_BUFFER = 500
 *   FLUSH_INTERVAL_MS = 5000
 */

const crypto = require('crypto');

const ATTENTION_LONG_RUNNING_MS = 30_000;
const ATTENTION_STALLED_MS = 120_000;
const MAX_EVENT_BUFFER = 500;
const FLUSH_INTERVAL_MS = 5_000;

// Global sequence counter for event ordering
let _globalSeq = 0;

/**
 * Generate a W3C-compatible trace ID (32 hex chars).
 */
function generateTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate a span ID (16 hex chars).
 */
function generateSpanId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Structured diagnostic event.
 *
 * @typedef {object} DiagnosticEvent
 * @property {string} type - Event type
 * @property {number} seq - Global sequence number
 * @property {string} traceId - W3C trace ID
 * @property {string} spanId - Span ID
 * @property {string} [parentSpanId] - Parent span ID
 * @property {number} timestamp - Unix ms
 * @property {object} data - Event-specific payload
 * @property {string} [attention] - Attention classification
 */

class DiagnosticEventEmitter {
  /**
   * @param {object} [opts]
   * @param {function} [opts.onFlush] - (events: DiagnosticEvent[]) => void
   * @param {number} [opts.maxBuffer=500] - Max events before auto-flush
   * @param {number} [opts.flushIntervalMs=5000] - Auto-flush interval
   */
  constructor(opts = {}) {
    this._buffer = [];
    this._maxBuffer = opts.maxBuffer || MAX_EVENT_BUFFER;
    this._onFlush = opts.onFlush || null;
    this._flushIntervalMs = opts.flushIntervalMs || FLUSH_INTERVAL_MS;
    this._flushTimer = null;
    this._listeners = new Map(); // type → Set<callback>

    // Active spans for attention tracking
    this._activeSpans = new Map(); // spanId → { type, startTime, traceId }

    // Start auto-flush timer
    this._startFlushTimer();
  }

  /**
   * Emit a diagnostic event.
   *
   * @param {string} type - Event type
   * @param {object} data - Event payload
   * @param {object} [ctx] - Trace context
   * @param {string} [ctx.traceId]
   * @param {string} [ctx.parentSpanId]
   * @returns {DiagnosticEvent}
   */
  emit(type, data, ctx = {}) {
    const event = {
      type,
      seq: ++_globalSeq,
      traceId: ctx.traceId || generateTraceId(),
      requestId: ctx.requestId || ctx.traceId || null,
      spanId: generateSpanId(),
      parentSpanId: ctx.parentSpanId || null,
      timestamp: Date.now(),
      data,
      attention: null,
    };

    this._buffer.push(event);

    // Notify type-specific listeners
    const listeners = this._listeners.get(type);
    if (listeners) {
      for (const cb of listeners) {
        try { cb(event); } catch { /* swallow listener errors */ }
      }
    }

    // Notify wildcard listeners
    const wildcardListeners = this._listeners.get('*');
    if (wildcardListeners) {
      for (const cb of wildcardListeners) {
        try { cb(event); } catch { /* swallow */ }
      }
    }

    // Auto-flush if buffer full
    if (this._buffer.length >= this._maxBuffer) {
      this.flush();
    }

    return event;
  }

  // ── Convenience emitters ──

  /**
   * Emit a tool call start event.
   * Returns spanId for correlation with result.
   */
  emitToolCall(toolName, params, ctx = {}) {
    const event = this.emit('tool_call', {
      toolName,
      paramsSize: JSON.stringify(params || {}).length,
      paramKeys: Object.keys(params || {}),
    }, ctx);

    // Track as active span
    this._activeSpans.set(event.spanId, {
      type: 'tool_call',
      startTime: event.timestamp,
      traceId: event.traceId,
      toolName,
    });

    return event.spanId;
  }

  /**
   * Emit a tool result event, linked to a tool call span.
   */
  emitToolResult(spanId, result, error, ctx = {}) {
    const activeSpan = this._activeSpans.get(spanId);
    const durationMs = activeSpan ? Date.now() - activeSpan.startTime : 0;

    const event = this.emit('tool_result', {
      toolName: activeSpan?.toolName || 'unknown',
      success: !error,
      durationMs,
      resultSize: result ? JSON.stringify(result).length : 0,
      error: error ? String(error).slice(0, 500) : null,
    }, {
      traceId: ctx.traceId || activeSpan?.traceId,
      parentSpanId: spanId,
    });

    // Classify attention
    if (durationMs > ATTENTION_STALLED_MS) {
      event.attention = 'stalled';
    } else if (durationMs > ATTENTION_LONG_RUNNING_MS) {
      event.attention = 'long_running';
    }

    this._activeSpans.delete(spanId);
    return event;
  }

  /**
   * Emit a model request event.
   */
  emitModelRequest(model, provider, tokenEstimate, ctx = {}) {
    return this.emit('model_request', {
      model,
      provider,
      tokenEstimate,
    }, ctx);
  }

  /**
   * Emit a model response event.
   */
  emitModelResponse(model, provider, tokenUsage, durationMs, ctx = {}) {
    const event = this.emit('model_response', {
      model,
      provider,
      inputTokens: tokenUsage?.inputTokens || 0,
      outputTokens: tokenUsage?.outputTokens || 0,
      totalTokens: (tokenUsage?.inputTokens || 0) + (tokenUsage?.outputTokens || 0),
      durationMs,
      tokensPerSecond: durationMs > 0
        ? Math.round((tokenUsage?.outputTokens || 0) / (durationMs / 1000))
        : 0,
    }, ctx);

    if (durationMs > ATTENTION_STALLED_MS) {
      event.attention = 'stalled';
    } else if (durationMs > ATTENTION_LONG_RUNNING_MS) {
      event.attention = 'long_running';
    }

    return event;
  }

  /**
   * Emit a session state transition.
   */
  emitSessionState(from, to, reason, ctx = {}) {
    return this.emit('session_state', { from, to, reason }, ctx);
  }

  /**
   * Emit an error event.
   */
  emitError(category, error, ctx = {}) {
    return this.emit('error', {
      category,
      message: error?.message || String(error),
      code: error?.code || error?.status || null,
      stack: error?.stack?.split('\n').slice(0, 5).join('\n') || null,
    }, ctx);
  }

  // ── Listener management ──

  /**
   * Subscribe to events of a specific type (or '*' for all).
   * @returns {function} unsubscribe function
   */
  on(type, callback) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set());
    }
    this._listeners.get(type).add(callback);
    return () => this._listeners.get(type)?.delete(callback);
  }

  // ── Attention tracking ──

  /**
   * Check for stale active spans and emit attention events.
   */
  checkAttention() {
    const now = Date.now();
    const stale = [];

    for (const [spanId, span] of this._activeSpans) {
      const elapsed = now - span.startTime;
      if (elapsed > ATTENTION_STALLED_MS) {
        stale.push({ spanId, span, attention: 'stalled', elapsed });
      } else if (elapsed > ATTENTION_LONG_RUNNING_MS) {
        stale.push({ spanId, span, attention: 'long_running', elapsed });
      }
    }

    for (const { spanId, span, attention, elapsed } of stale) {
      this.emit('attention', {
        spanId,
        toolName: span.toolName,
        attention,
        elapsedMs: elapsed,
      }, { traceId: span.traceId });
    }

    return stale;
  }

  // ── Buffer management ──

  /**
   * Flush buffered events.
   */
  flush() {
    if (this._buffer.length === 0) return;

    const events = this._buffer.splice(0);
    if (this._onFlush) {
      try { this._onFlush(events); } catch { /* swallow */ }
    }
    return events;
  }

  /**
   * Get buffered events without flushing.
   */
  getBuffer() {
    return [...this._buffer];
  }

  /**
   * Get summary statistics from buffer.
   */
  getSummary() {
    const byType = {};
    let totalDuration = 0;
    let toolCalls = 0;
    let errors = 0;

    for (const event of this._buffer) {
      byType[event.type] = (byType[event.type] || 0) + 1;
      if (event.type === 'tool_result') {
        totalDuration += event.data.durationMs || 0;
        toolCalls++;
        if (event.data.error) errors++;
      }
    }

    // Use timeFormat for human-friendly display
    let avgToolDurationFormatted;
    try {
      const { formatDurationPrecise } = require('./timeFormat');
      avgToolDurationFormatted = toolCalls > 0
        ? formatDurationPrecise(Math.round(totalDuration / toolCalls))
        : '0ms';
    } catch {
      avgToolDurationFormatted = undefined;
    }

    return {
      eventCount: this._buffer.length,
      byType,
      toolCalls,
      errors,
      avgToolDurationMs: toolCalls > 0 ? Math.round(totalDuration / toolCalls) : 0,
      avgToolDurationFormatted,
      activeSpans: this._activeSpans.size,
    };
  }

  _startFlushTimer() {
    if (this._flushTimer) return;
    this._flushTimer = setInterval(() => this.flush(), this._flushIntervalMs);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  /**
   * Shutdown: flush remaining events and stop timer.
   */
  shutdown() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this.flush();
    this._activeSpans.clear();
  }
}

// Singleton instance
const diagnostics = new DiagnosticEventEmitter();

module.exports = {
  DiagnosticEventEmitter,
  diagnostics,
  generateTraceId,
  generateSpanId,
  ATTENTION_LONG_RUNNING_MS,
  ATTENTION_STALLED_MS,
  MAX_EVENT_BUFFER,
  FLUSH_INTERVAL_MS,
};
