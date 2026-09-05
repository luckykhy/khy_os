'use strict';

/**
 * A2A Message Router — Routes messages between agents.
 *
 * Provides:
 * - Message routing based on capabilities
 * - Load balancing
 * - Message queuing
 * - Retry logic
 * - Dead letter queue
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── Message Priority ──────────────────────────────────────────────────────

const MESSAGE_PRIORITY = Object.freeze({
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
});

// ── Message Status ────────────────────────────────────────────────────────

const MESSAGE_STATUS = Object.freeze({
  PENDING: 'pending',
  ROUTING: 'routing',
  DELIVERED: 'delivered',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  RETRYING: 'retrying',
  DEAD_LETTER: 'dead_letter',
});

// ── A2A Message Router ────────────────────────────────────────────────────

class A2AMessageRouter extends EventEmitter {
  constructor(options = {}) {
    super();
    this._options = {
      maxRetries: options.maxRetries || 3,
      retryDelayMs: options.retryDelayMs || 1000,
      maxQueueSize: options.maxQueueSize || 1000,
      messageTimeoutMs: options.messageTimeoutMs || 30000,
      deadLetterEnabled: options.deadLetterEnabled !== false,
      ...options,
    };
    
    this._queues = new Map(); // priority → Array<message>
    this._processing = new Map(); // messageId → {message, agentId, timer}
    this._deadLetter = [];
    this._stats = {
      totalRouted: 0,
      totalDelivered: 0,
      totalFailed: 0,
      totalRetried: 0,
      totalDeadLetter: 0,
    };

    // Start processing loop
    this._processInterval = setInterval(() => this._processQueues(), 100);
    if (this._processInterval.unref) {
      this._processInterval.unref();
    }
  }

  // ── Routing ───────────────────────────────────────────────────────────

  /**
   * Route a message to the best available agent.
   * @param {object} message
   * @param {object} [options]
   * @returns {Promise<object>} Routing result
   */
  async route(message, options = {}) {
    const messageId = message.id || `msg-${crypto.randomBytes(8).toString('hex')}`;
    const priority = message.priority ?? MESSAGE_PRIORITY.NORMAL;
    
    const envelope = {
      id: messageId,
      type: message.type || 'message',
      priority,
      payload: message.payload || message,
      metadata: {
        source: message.source || 'system',
        target: message.target || null,
        capability: message.capability || null,
        traceId: message.traceId || crypto.randomBytes(8).toString('hex'),
        createdAt: Date.now(),
        attempts: 0,
        maxAttempts: options.maxAttempts || this._options.maxRetries + 1,
        ...message.metadata,
      },
      status: MESSAGE_STATUS.PENDING,
    };

    // Check queue size
    const queueSize = this._getTotalQueueSize();
    if (queueSize >= this._options.maxQueueSize) {
      throw new Error(`Message queue full (${this._options.maxQueueSize})`);
    }

    // Add to queue
    if (!this._queues.has(priority)) {
      this._queues.set(priority, []);
    }
    this._queues.get(priority).push(envelope);
    envelope.status = MESSAGE_STATUS.ROUTING;
    
    this.emit('message:queued', envelope);
    this._stats.totalRouted++;

    return envelope;
  }

  /**
   * Route a message to a specific agent.
   * @param {string} agentId
   * @param {object} message
   * @returns {Promise<object>}
   */
  async routeTo(agentId, message) {
    return this.route({ ...message, target: agentId });
  }

  /**
   * Broadcast a message to all agents with a capability.
   * @param {string} capability
   * @param {object} message
   * @returns {Promise<object[]>}
   */
  async broadcast(capability, message) {
    const registry = require('./a2aRegistry');
    const agents = registry.getRegistry().getAgentsByCapability(capability);
    
    const results = [];
    for (const agent of agents) {
      const result = await this.routeTo(agent.id, {
        ...message,
        capability,
      });
      results.push(result);
    }
    
    return results;
  }

  // ── Queue Processing ──────────────────────────────────────────────────

  /**
   * Process message queues.
   * @private
   */
  _processQueues() {
    for (const priority of Object.keys(MESSAGE_PRIORITY).sort()) {
      const queue = this._queues.get(MESSAGE_PRIORITY[priority]);
      if (!queue || queue.length === 0) {
        continue;
      }

      const message = queue.shift();
      this._deliverMessage(message);
    }
  }

  /**
   * Deliver a message to its target.
   * @param {object} envelope
   * @private
   */
  async _deliverMessage(envelope) {
    envelope.status = MESSAGE_STATUS.DELIVERED;
    envelope.metadata.attempts++;
    
    this.emit('message:delivered', envelope);
    this._stats.totalDelivered++;

    // Find target agent
    let agentId = envelope.metadata.target;
    
    if (!agentId && envelope.metadata.capability) {
      const registry = require('./a2aRegistry');
      const agent = registry.getRegistry().findBestAgent(envelope.metadata.capability);
      if (agent) {
        agentId = agent.id;
      }
    }

    if (!agentId) {
      this._handleFailedDelivery(envelope, 'No target agent found');
      return;
    }

    // Set processing timeout
    const timer = setTimeout(() => {
      this._handleTimeout(envelope, agentId);
    }, this._options.messageTimeoutMs);
    
    if (timer.unref) {
      timer.unref();
    }

    this._processing.set(envelope.id, { envelope, agentId, timer });
    envelope.status = MESSAGE_STATUS.PROCESSING;
    
    this.emit('message:processing', { envelope, agentId });
  }

  /**
   * Handle message processing completion.
   * @param {string} messageId
   * @param {object} result
   */
  completeMessage(messageId, result) {
    const entry = this._processing.get(messageId);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    this._processing.delete(messageId);
    
    entry.envelope.status = MESSAGE_STATUS.COMPLETED;
    entry.envelope.result = result;
    entry.envelope.metadata.completedAt = Date.now();
    
    this.emit('message:completed', entry.envelope);
  }

  /**
   * Handle message processing failure.
   * @param {string} messageId
   * @param {string} error
   */
  failMessage(messageId, error) {
    const entry = this._processing.get(messageId);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    this._processing.delete(messageId);
    
    entry.envelope.metadata.attempts++;
    
    if (entry.envelope.metadata.attempts < entry.envelope.metadata.maxAttempts) {
      // Retry
      entry.envelope.status = MESSAGE_STATUS.RETRYING;
      this._stats.totalRetried++;
      
      setTimeout(() => {
        this._deliverMessage(entry.envelope);
      }, this._options.retryDelayMs);
      
      this.emit('message:retrying', entry.envelope);
    } else {
      // Max retries exceeded
      this._handleFailedDelivery(entry.envelope, error);
    }
  }

  /**
   * Handle failed delivery.
   * @param {object} envelope
   * @param {string} error
   * @private
   */
  _handleFailedDelivery(envelope, error) {
    envelope.status = MESSAGE_STATUS.FAILED;
    envelope.error = error;
    envelope.metadata.failedAt = Date.now();
    
    this._stats.totalFailed++;

    if (this._options.deadLetterEnabled) {
      envelope.status = MESSAGE_STATUS.DEAD_LETTER;
      this._deadLetter.push(envelope);
      this._stats.totalDeadLetter++;
      
      this.emit('message:deadLetter', envelope);
    } else {
      this.emit('message:failed', envelope);
    }
  }

  /**
   * Handle message timeout.
   * @param {object} envelope
   * @param {string} agentId
   * @private
   */
  _handleTimeout(envelope, agentId) {
    this._processing.delete(envelope.id);
    this.failMessage(envelope.id, `Processing timeout after ${this._options.messageTimeoutMs}ms`);
  }

  // ── Queue Management ──────────────────────────────────────────────────

  /**
   * Get total queue size.
   * @returns {number}
   * @private
   */
  _getTotalQueueSize() {
    let size = 0;
    for (const queue of this._queues.values()) {
      size += queue.length;
    }
    return size;
  }

  /**
   * Get queue statistics.
   * @returns {object}
   */
  getQueueStats() {
    const queueStats = {};
    for (const [priority, queue] of this._queues) {
      queueStats[priority] = queue.length;
    }
    
    return {
      queues: queueStats,
      totalQueued: this._getTotalQueueSize(),
      processing: this._processing.size,
      deadLetter: this._deadLetter.length,
      ...this._stats,
    };
  }

  /**
   * Get dead letter messages.
   * @returns {object[]}
   */
  getDeadLetterMessages() {
    return [...this._deadLetter];
  }

  /**
   * Retry dead letter messages.
   * @param {number} [count] - Number of messages to retry (default: all)
   */
  retryDeadLetter(count) {
    const messages = this._deadLetter.splice(0, count || this._deadLetter.length);
    
    for (const message of messages) {
      message.status = MESSAGE_STATUS.PENDING;
      message.metadata.attempts = 0;
      
      if (!this._queues.has(message.priority)) {
        this._queues.set(message.priority, []);
      }
      this._queues.get(message.priority).push(message);
    }
    
    return messages.length;
  }

  /**
   * Clear dead letter queue.
   */
  clearDeadLetter() {
    this._deadLetter = [];
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /**
   * Stop the router and clean up resources.
   */
  destroy() {
    if (this._processInterval) {
      clearInterval(this._processInterval);
      this._processInterval = null;
    }

    // Clear all queues
    this._queues.clear();
    
    // Clear processing timers
    for (const [, entry] of this._processing) {
      clearTimeout(entry.timer);
    }
    this._processing.clear();
    
    this.removeAllListeners();
  }
}

// ── Singleton Instance ────────────────────────────────────────────────────

let _instance = null;

function getRouter(options) {
  if (!_instance) {
    _instance = new A2AMessageRouter(options);
  }
  return _instance;
}

function resetRouter() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}

module.exports = {
  A2AMessageRouter,
  MESSAGE_PRIORITY,
  MESSAGE_STATUS,
  getRouter,
  resetRouter,
};