'use strict';

/**
 * SSE Keepalive — heartbeat for streaming connections.
 *
 * Prevents proxies and load balancers from killing idle SSE connections
 * by sending periodic comment events (`: keepalive`).
 *
 * Also supports client-side reconnection with event ID tracking.
 *
 * Inspired by LibreChat's SSE reconnection + Redis event sequencing.
 *
 * @module sseKeepalive
 */

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 15000;  // 15s — typical proxy timeout is 60s
const COMMENT_EVENT = ': keepalive\n\n';

// ── Keepalive Class ────────────────────────────────────────────────

class SSEKeepalive {
  /**
   * @param {object} res - HTTP response (writable stream)
   * @param {object} [options]
   * @param {number} [options.intervalMs]
   * @param {Function} [options.onError]
   */
  constructor(res, options = {}) {
    this._res = res;
    this._intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    this._onError = options.onError || null;
    this._timer = null;
    this._eventSeq = 0;
    this._active = true;
    this._backpressure = null;

    // 背压控制器（可选启用）
    if (options.backpressure !== false) {
      try {
        const { SSEBackpressure } = require('./sseBackpressure');
        this._backpressure = new SSEBackpressure(res, {
          highWaterMark: options.highWaterMark || undefined,
        });
      } catch { /* sseBackpressure 模块不可用时降级为直写 */ }
    }
  }

  _nextEventId(providedId = null) {
    const parsed = Number.parseInt(providedId, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      if (parsed > this._eventSeq) this._eventSeq = parsed;
      return parsed;
    }
    this._eventSeq += 1;
    return this._eventSeq;
  }

  _writeSseEvent({ event = null, data, eventId = null }) {
    if (!this._active || this._res.writableEnded) return -1;
    const seq = this._nextEventId(eventId);
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    const formatted = event
      ? `id: ${seq}\nevent: ${event}\ndata: ${payload}\n\n`
      : `id: ${seq}\ndata: ${payload}\n\n`;
    try {
      // 背压感知：如果有背压控制器则用 writeSync（非阻塞尽力写入）
      if (this._backpressure) {
        this._backpressure.writeSync(formatted);
      } else {
        this._res.write(formatted);
      }
    } catch {
      /* connection closed */
    }
    return seq;
  }

  async _flushPending() {
    if (!this._backpressure) return;
    try {
      await this._backpressure.flushAll();
    } catch {
      /* connection closed */
    }
  }

  /**
   * 带背压的异步写入（供流式 AI 输出使用）。
   * 当下游消费慢时自动等待 drain，避免内存膨胀。
   * @param {string} event
   * @param {string|object} data
   * @returns {Promise<number>} Event sequence number
   */
  async sendAsync(event, data) {
    if (!this._active || this._res.writableEnded) return -1;
    const seq = this._nextEventId();
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    const formatted = event
      ? `id: ${seq}\nevent: ${event}\ndata: ${payload}\n\n`
      : `id: ${seq}\ndata: ${payload}\n\n`;
    try {
      if (this._backpressure) {
        await this._backpressure.write(formatted);
      } else {
        this._res.write(formatted);
      }
    } catch {
      /* connection closed */
    }
    return seq;
  }

  /**
   * Start the keepalive timer.
   * @returns {this}
   */
  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => {
      if (!this._active) return;
      try {
        if (!this._res.writableEnded && !this._res.destroyed) {
          this._res.write(COMMENT_EVENT);
        } else {
          void this.stop();
        }
      } catch (err) {
        if (this._onError) try { this._onError(err); } catch { /* ignore */ }
        void this.stop();
      }
    }, this._intervalMs);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  /**
   * Send a named SSE event with auto-incrementing ID.
   * @param {string} event - Event name
   * @param {string|object} data - Event data
   * @returns {number} Event sequence number
   */
  send(event, data) {
    return this._writeSseEvent({ event, data });
  }

  /**
   * Send a named SSE event using a caller-provided ID.
   * Primarily used for replay where event IDs must remain stable across reconnects.
   *
   * @param {string} event - Event name
   * @param {string|object} data - Event data
   * @param {number} eventId - Event sequence ID
   * @returns {number} Event sequence number
   */
  sendWithId(event, data, eventId) {
    return this._writeSseEvent({ event, data, eventId });
  }

  /**
   * Send a data-only SSE event (default event type).
   * @param {string|object} data
   * @returns {number}
   */
  sendData(data) {
    return this._writeSseEvent({ data });
  }

  /**
   * Send a terminal "done" event (with optional abort flag).
   * @param {boolean} [aborted=false]
   */
  async done(aborted = false) {
    if (!this._active) return;
    await this._flushPending();
    this.send('done', { aborted, seq: this._eventSeq });
    await this._flushPending();
    await this.stop();
  }

  /**
   * Get the current event sequence number.
   * Used for client-side reconnection (Last-Event-ID).
   * @returns {number}
   */
  getSeq() {
    return this._eventSeq;
  }

  /**
   * Stop the keepalive timer.
   */
  async stop() {
    await this._flushPending();
    this._active = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._backpressure) {
      this._backpressure.destroy();
    }
  }
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Attach SSE keepalive to an HTTP response.
 * Sets appropriate headers and starts the timer.
 *
 * @param {object} res - Express/Node HTTP response
 * @param {object} [options]
 * @param {number} [options.intervalMs]
 * @param {Function} [options.onError]
 * @returns {SSEKeepalive}
 */
function attach(res, options = {}) {
  // Set SSE headers
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx buffering bypass
    });
  }

  const keepalive = new SSEKeepalive(res, options);

  // Guard: if response is already closed/destroyed, don't start keepalive
  if (res.destroyed || res.writableEnded || res.writableFinished) {
    return keepalive; // never started, no timer leak
  }

  keepalive.start();

  // Auto-stop on close
  res.on('close', () => { void keepalive.stop(); });

  return keepalive;
}

module.exports = {
  SSEKeepalive,
  attach,
  DEFAULT_INTERVAL_MS,
};
