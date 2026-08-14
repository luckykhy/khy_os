/**
 * TaskQueue — manages concurrent delivery task processing.
 *
 * Features:
 * - Max concurrency limit (default: 3 simultaneous deliveries)
 * - Automatic retry with exponential backoff
 * - Priority ordering (higher priority = processed first)
 * - Event emission for status changes
 */

const EventEmitter = require('events');

class TaskQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxConcurrency = options.maxConcurrency || 3;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelayMs = options.retryDelayMs || 2000;
    this._queue = [];      // pending tasks (sorted by priority)
    this._active = 0;      // currently processing count
    this._processing = new Map(); // id → { resolve, reject, task, attempt }
    this._closed = false;
  }

  /**
   * Enqueue a delivery task.
   * @param {object} task — { id, platforms, content, format, priority }
   * @returns {Promise<DeliveryResult>}
   */
  enqueue(task) {
    if (this._closed) return Promise.reject(new Error('Queue is closed.'));

    task.priority = task.priority || 5; // 1=highest, 10=lowest
    task.status = task.status || 'pending';
    task.retries = task.retries || 0;

    return new Promise((resolve, reject) => {
      this._queue.push({ ...task, _resolve: resolve, _reject: reject });
      this._queue.sort((a, b) => a.priority - b.priority); // lower = higher priority
      this.emit('task:enqueued', { id: task.id, queueLength: this._queue.length });
      this._processNext();
    });
  }

  /**
   * Cancel a pending task.
   */
  cancel(taskId) {
    this._queue = this._queue.filter((t) => {
      if (t.id === taskId) {
        t._reject(new Error('Task cancelled.'));
        return false;
      }
      return true;
    });
  }

  /**
   * Get current queue status.
   */
  getStatus() {
    return {
      pending: this._queue.length,
      active: this._active,
      maxConcurrency: this.maxConcurrency,
      closed: this._closed,
    };
  }

  /**
   * Close the queue — no new tasks accepted.
   */
  close() {
    this._closed = true;
    this.emit('closed');
  }

  // ── Internal ──────────────────────────────────────────────────────────

  async _processNext() {
    if (this._active >= this.maxConcurrency || this._queue.length === 0) return;

    const entry = this._queue.shift();
    if (!entry) return;

    this._active++;
    this.emit('task:started', { id: entry.id });

    try {
      const result = await entry._handler(entry.task);
      entry._resolve(result);
      this.emit('task:completed', { id: entry.id, success: result?.success });
    } catch (err) {
      // Retry logic
      const attempt = (entry.task.retries || 0) + 1;
      if (attempt <= this.maxRetries && this._isRetryable(err)) {
        entry.task.retries = attempt;
        const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
        this.emit('task:retrying', { id: entry.id, attempt, delay });
        await new Promise((r) => setTimeout(r, delay));
        this._queue.unshift(entry); // re-insert at front
        this.emit('task:retry_scheduled', { id: entry.id });
      } else {
        entry._reject(err);
        this.emit('task:failed', { id: entry.id, error: err.message });
      }
    } finally {
      this._active--;
      this._processNext();
    }
  }

  _isRetryable(err) {
    const retryableCodes = ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', '429', '500', '502', '503', '529'];
    return retryableCodes.some(
      (code) => err.message.includes(code) || (err.status && String(err.status).startsWith(code))
    );
  }
}

module.exports = { TaskQueue };
