'use strict';

/**
 * permissionBroker.js — Centralized permission serialization broker.
 *
 * Inspired by Y-code's PermissionBroker with deque-based concurrent
 * permission request serialization. Ensures only one permission
 * prompt is active at a time while preserving each caller's Future.
 *
 * Architecture:
 *   - PermissionBroker: serializes concurrent permission requests
 *   - PermissionRequest: queued request with Promise resolution
 *   - PermissionResult: outcome of a permission request
 *
 * Key capabilities:
 *   1. Serialize concurrent permission prompts (one at a time)
 *   2. Preserve each caller's Promise/Future
 *   3. Timeout handling for stale requests
 *   4. Priority-based ordering (critical > normal > background)
 *   5. Batch approval support (approve similar requests)
 *
 * @module permissionBroker
 */

const { EventEmitter } = require('events');

// ── Permission Result ────────────────────────────────────────────────────

const PermissionVerdict = Object.freeze({
  APPROVED: 'approved',
  DENIED: 'denied',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
});

// ── Permission Request ───────────────────────────────────────────────────

/**
 * A pending permission request.
 */
class PermissionRequest {
  /**
   * @param {object} config
   * @param {string} config.id - Unique request ID
   * @param {string} config.toolName - Tool requesting permission
   * @param {string} config.reason - Human-readable reason
   * @param {function} config.promptFn - Async function to prompt user
   * @param {number} [config.priority=5] - Priority (lower = higher)
   * @param {number} [config.timeoutMs=60000] - Request timeout
   * @param {object} [config.metadata={}] - Additional context
   */
  constructor(config) {
    this.id = config.id;
    this.toolName = config.toolName;
    this.reason = config.reason;
    this.promptFn = config.promptFn;
    this.priority = config.priority || 5;
    this.timeoutMs = config.timeoutMs || 60000;
    this.metadata = config.metadata || {};

    this.createdAt = Date.now();
    this.resolved = false;
    this.verdict = null;
    this.error = null;

    // Promise resolution callbacks
    this._resolve = null;
    this._reject = null;
    this._promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  get promise() {
    return this._promise;
  }

  /**
   * Resolve the request with a verdict.
   * @param {string} verdict
   * @param {object} [details]
   */
  resolve(verdict, details = {}) {
    if (this.resolved) return;
    this.resolved = true;
    this.verdict = verdict;
    this._resolve({ verdict, ...details });
  }

  /**
   * Reject the request with an error.
   * @param {Error} error
   */
  reject(error) {
    if (this.resolved) return;
    this.resolved = true;
    this.error = error;
    this._reject(error);
  }

  /**
   * Check if this request has timed out.
   * @returns {boolean}
   */
  get isTimedOut() {
    return Date.now() - this.createdAt > this.timeoutMs;
  }

  /**
   * Get wait time so far.
   * @returns {number}
   */
  get waitTime() {
    return Date.now() - this.createdAt;
  }
}

// ── Permission Broker ─────────────────────────────────────────────────────

/**
 * Centralized permission serialization broker.
 *
 * Ensures only one permission prompt is active at a time.
 * Requests are processed in priority order (FIFO within same priority).
 */
class PermissionBroker extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.defaultTimeoutMs=60000] - Default request timeout
   * @param {number} [options.maxQueueSize=100] - Max pending requests
   * @param {function} [options.onPrompt] - Custom prompt handler
   */
  constructor(options = {}) {
    super();
    this._defaultTimeoutMs = options.defaultTimeoutMs || 60000;
    this._maxQueueSize = options.maxQueueSize || 100;
    this._onPrompt = options.onPrompt || null;

    /** @type {PermissionRequest[]} */
    this._queue = [];
    /** @type {Map<string, PermissionRequest>} */
    this._pending = new Map();
    this._processing = false;
    this._stats = {
      totalRequests: 0,
      approved: 0,
      denied: 0,
      timedOut: 0,
      cancelled: 0,
    };
  }

  // ── Properties ──────────────────────────────────────────────────────

  get queueSize() { return this._queue.length; }
  get isProcessing() { return this._processing; }
  get stats() { return { ...this._stats }; }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Request permission for a tool action.
   *
   * @param {object} request
   * @param {string} request.toolName
   * @param {string} request.reason
   * @param {function} [request.promptFn] - Custom prompt function
   * @param {number} [request.priority]
   * @param {number} [request.timeoutMs]
   * @param {object} [request.metadata]
   * @returns {Promise<{verdict: string, ...}>}
   */
  async request(request) {
    if (!request || !request.toolName) {
      throw new TypeError('Permission request requires toolName');
    }

    if (this._queue.length >= this._maxQueueSize) {
      throw new Error(`Permission queue full (${this._maxQueueSize})`);
    }

    const id = this._generateId();
    const permRequest = new PermissionRequest({
      id,
      toolName: request.toolName,
      reason: request.reason || `${request.toolName} 需要权限`,
      promptFn: request.promptFn || this._onPrompt,
      priority: request.priority ?? 5,
      timeoutMs: request.timeoutMs || this._defaultTimeoutMs,
      metadata: request.metadata || {},
    });

    this._stats.totalRequests++;

    // Add to queue in priority order
    this._enqueue(permRequest);

    this.emit('request:queued', permRequest);

    // Start processing if not already
    this._processNext();

    return permRequest.promise;
  }

  /**
   * Approve all pending requests matching a tool name.
   * @param {string} toolName
   * @param {object} [details]
   * @returns {number} Number of requests approved
   */
  approveAll(toolName, details = {}) {
    let count = 0;
    for (const req of this._queue) {
      if (req.toolName === toolName && !req.resolved) {
        req.resolve(PermissionVerdict.APPROVED, { batch: true, ...details });
        count++;
      }
    }
    this._stats.approved += count;
    return count;
  }

  /**
   * Deny all pending requests matching a tool name.
   * @param {string} toolName
   * @returns {number} Number of requests denied
   */
  denyAll(toolName) {
    let count = 0;
    for (const req of this._queue) {
      if (req.toolName === toolName && !req.resolved) {
        req.resolve(PermissionVerdict.DENIED, { batch: true });
        count++;
      }
    }
    this._stats.denied += count;
    return count;
  }

  /**
   * Cancel a specific request by ID.
   * @param {string} requestId
   * @returns {boolean}
   */
  cancel(requestId) {
    const req = this._pending.get(requestId);
    if (req && !req.resolved) {
      req.resolve(PermissionVerdict.CANCELLED);
      this._stats.cancelled++;
      return true;
    }

    // Also check queue
    const idx = this._queue.findIndex(r => r.id === requestId);
    if (idx !== -1) {
      const req = this._queue[idx];
      if (!req.resolved) {
        req.resolve(PermissionVerdict.CANCELLED);
        this._queue.splice(idx, 1);
        this._stats.cancelled++;
        return true;
      }
    }

    return false;
  }

  /**
   * Cancel all pending requests.
   */
  cancelAll() {
    for (const req of this._queue) {
      if (!req.resolved) {
        req.resolve(PermissionVerdict.CANCELLED);
        this._stats.cancelled++;
      }
    }
    this._queue = [];
  }

  // ── Queue Management ────────────────────────────────────────────────

  /**
   * Add request to queue in priority order.
   * @private
   */
  _enqueue(request) {
    // Insert in priority order (lower priority number = higher priority)
    let inserted = false;
    for (let i = 0; i < this._queue.length; i++) {
      if (request.priority < this._queue[i].priority) {
        this._queue.splice(i, 0, request);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this._queue.push(request);
    }
  }

  /**
   * Process the next request in queue.
   * @private
   */
  async _processNext() {
    if (this._processing || this._queue.length === 0) return;

    this._processing = true;

    while (this._queue.length > 0) {
      // Clean up timed-out requests
      this._cleanupTimedOut();

      // Get next request
      const request = this._queue.shift();
      if (!request || request.resolved) continue;

      this._pending.set(request.id, request);
      this.emit('request:processing', request);

      try {
        await this._processRequest(request);
      } catch (err) {
        request.reject(err);
      } finally {
        this._pending.delete(request.id);
      }
    }

    this._processing = false;
  }

  /**
   * Process a single permission request.
   * @private
   */
  async _processRequest(request) {
    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      if (!request.resolved) {
        request.resolve(PermissionVerdict.TIMEOUT);
        this._stats.timedOut++;
      }
    }, request.timeoutMs);

    try {
      let verdict;

      if (request.promptFn) {
        // Use custom prompt function
        verdict = await request.promptFn(request);
      } else {
        // Default: auto-approve (override for actual UI)
        verdict = PermissionVerdict.APPROVED;
      }

      if (!request.resolved) {
        request.resolve(verdict);
        if (verdict === PermissionVerdict.APPROVED) {
          this._stats.approved++;
        } else if (verdict === PermissionVerdict.DENIED) {
          this._stats.denied++;
        }
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Remove timed-out requests from queue.
   * @private
   */
  _cleanupTimedOut() {
    const now = Date.now();
    this._queue = this._queue.filter(req => {
      if (req.timeoutMs > 0 && now - req.createdAt > req.timeoutMs) {
        req.resolve(PermissionVerdict.TIMEOUT);
        this._stats.timedOut++;
        return false;
      }
      return true;
    });
  }

  // ── Utility ─────────────────────────────────────────────────────────

  /**
   * Generate unique request ID.
   * @private
   */
  _generateId() {
    return `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Reset broker state.
   */
  reset() {
    this.cancelAll();
    this._stats = {
      totalRequests: 0,
      approved: 0,
      denied: 0,
      timedOut: 0,
      cancelled: 0,
    };
  }
}

// ── Module Exports ────────────────────────────────────────────────────────

module.exports = {
  PermissionBroker,
  PermissionRequest,
  PermissionVerdict,
};
