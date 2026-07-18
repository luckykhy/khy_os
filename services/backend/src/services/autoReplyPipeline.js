'use strict';

/**
 * autoReplyPipeline.js — Automated reply pipeline for inbound message handling.
 *
 * Ported from OpenClaw's auto-reply system (700+ lines).
 * Generalized from IM-specific to a provider-agnostic message routing pipeline.
 * Handles debouncing, context building, response generation, and chunked delivery.
 *
 * Pipeline stages:
 * 1. Inbound dispatch — route message to correct handler
 * 2. Debounce — group rapid messages within a window
 * 3. Context build — assemble conversation context
 * 4. Generate — call AI for response
 * 5. Deliver — chunk and send response
 *
 * Key features:
 * - Configurable debounce window (default 2s)
 * - Context assembly from message history
 * - Response chunking for long outputs
 * - Per-channel/conversation state tracking
 * - Error recovery with graceful degradation
 */

/**
 * @typedef {object} InboundMessage
 * @property {string} channelId - Conversation/channel identifier
 * @property {string} senderId - Sender identifier
 * @property {string} content - Message text
 * @property {number} timestamp - Unix ms
 * @property {string} [replyTo] - ID of message being replied to
 * @property {object} [metadata] - Provider-specific metadata
 */

/**
 * @typedef {object} OutboundChunk
 * @property {string} channelId
 * @property {string} content - Chunk text
 * @property {number} index - Chunk index (0-based)
 * @property {number} total - Total chunks
 * @property {boolean} final - Is this the last chunk?
 */

// ── Default configuration ──

const DEFAULT_CONFIG = {
  debounceMs: 2000,          // Group messages within 2 seconds
  maxContextMessages: 20,    // Max messages to include in context
  maxResponseLength: 4000,   // Max response length before chunking
  chunkSize: 2000,           // Characters per chunk
  maxPendingPerChannel: 50,  // Max pending messages per channel
  cooldownMs: 1000,          // Minimum time between responses to same channel
};

class AutoReplyPipeline {
  /**
   * @param {object} opts
   * @param {function} opts.generateFn - (prompt, context) => Promise<string>
   * @param {function} [opts.deliverFn] - (chunk: OutboundChunk) => Promise<void>
   * @param {function} [opts.contextBuilderFn] - (messages: InboundMessage[], channelId: string) => string
   * @param {object} [opts.config]
   */
  constructor(opts = {}) {
    if (!opts.generateFn) throw new Error('generateFn is required');

    this._generateFn = opts.generateFn;
    this._deliverFn = opts.deliverFn || (async () => {});
    this._contextBuilderFn = opts.contextBuilderFn || defaultContextBuilder;
    this._config = { ...DEFAULT_CONFIG, ...opts.config };

    /** @type {Map<string, InboundMessage[]>} channelId → buffered messages */
    this._messageBuffer = new Map();

    /** @type {Map<string, NodeJS.Timeout>} channelId → debounce timer */
    this._debounceTimers = new Map();

    /** @type {Map<string, number>} channelId → last response timestamp */
    this._lastResponse = new Map();

    /** @type {Map<string, InboundMessage[]>} channelId → message history */
    this._history = new Map();

    /** @type {Map<string, boolean>} channelId → currently processing */
    this._processing = new Map();

    this._enabled = true;
    this._stats = { received: 0, processed: 0, errors: 0, chunked: 0 };
  }

  /**
   * Handle an inbound message.
   * Buffers the message and starts/resets the debounce timer.
   *
   * @param {InboundMessage} message
   * @returns {{ buffered: boolean, reason?: string }}
   */
  receive(message) {
    if (!this._enabled) {
      return { buffered: false, reason: 'Pipeline disabled' };
    }

    if (!message?.channelId || !message?.content) {
      return { buffered: false, reason: 'Invalid message' };
    }

    this._stats.received++;

    // Add to buffer
    if (!this._messageBuffer.has(message.channelId)) {
      this._messageBuffer.set(message.channelId, []);
    }

    const buffer = this._messageBuffer.get(message.channelId);

    // Enforce max pending
    if (buffer.length >= this._config.maxPendingPerChannel) {
      buffer.shift(); // drop oldest
    }

    buffer.push({
      channelId: message.channelId,
      senderId: message.senderId,
      content: message.content,
      timestamp: message.timestamp || Date.now(),
      replyTo: message.replyTo || null,
      metadata: message.metadata || {},
    });

    // Reset debounce timer
    this._resetDebounce(message.channelId);

    return { buffered: true };
  }

  /**
   * Process buffered messages for a channel immediately (skip debounce).
   */
  async flush(channelId) {
    this._clearDebounce(channelId);
    return this._processChannel(channelId);
  }

  /**
   * Enable or disable the pipeline.
   */
  setEnabled(enabled) {
    this._enabled = enabled;
    if (!enabled) {
      // Clear all debounce timers
      for (const [chId] of this._debounceTimers) {
        this._clearDebounce(chId);
      }
    }
  }

  /**
   * Get pipeline statistics.
   */
  getStats() {
    return {
      ...this._stats,
      activeChannels: this._messageBuffer.size,
      processingChannels: Array.from(this._processing.values()).filter(Boolean).length,
      enabled: this._enabled,
    };
  }

  /**
   * Clear history for a channel.
   */
  clearHistory(channelId) {
    this._history.delete(channelId);
    this._messageBuffer.delete(channelId);
    this._clearDebounce(channelId);
  }

  /**
   * Get message history for a channel.
   */
  getHistory(channelId) {
    return [...(this._history.get(channelId) || [])];
  }

  // ── Internal ──

  _resetDebounce(channelId) {
    this._clearDebounce(channelId);
    const timer = setTimeout(() => {
      this._debounceTimers.delete(channelId);
      this._processChannel(channelId).catch(() => {});
    }, this._config.debounceMs);
    if (timer.unref) timer.unref();
    this._debounceTimers.set(channelId, timer);
  }

  _clearDebounce(channelId) {
    const timer = this._debounceTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      this._debounceTimers.delete(channelId);
    }
  }

  async _processChannel(channelId) {
    // Prevent concurrent processing for same channel
    if (this._processing.get(channelId)) return;

    const buffer = this._messageBuffer.get(channelId);
    if (!buffer || buffer.length === 0) return;

    // Cooldown check
    const lastResp = this._lastResponse.get(channelId) || 0;
    const elapsed = Date.now() - lastResp;
    if (elapsed < this._config.cooldownMs) {
      // Re-schedule after cooldown
      setTimeout(() => this._processChannel(channelId).catch(() => {}),
        this._config.cooldownMs - elapsed);
      return;
    }

    this._processing.set(channelId, true);

    // Take messages from buffer
    const messages = buffer.splice(0);

    // Add to history
    if (!this._history.has(channelId)) {
      this._history.set(channelId, []);
    }
    const history = this._history.get(channelId);
    history.push(...messages);

    // Trim history
    if (history.length > this._config.maxContextMessages * 2) {
      this._history.set(channelId, history.slice(-this._config.maxContextMessages * 2));
    }

    try {
      // Build context from history
      const contextMessages = history.slice(-this._config.maxContextMessages);
      const contextPrompt = this._contextBuilderFn(contextMessages, channelId);

      // Combine new messages into prompt
      const newContent = messages.map(m => m.content).join('\n');
      const fullPrompt = contextPrompt
        ? `${contextPrompt}\n\nUser: ${newContent}`
        : newContent;

      // Generate response
      const response = await this._generateFn(fullPrompt, {
        channelId,
        messageCount: messages.length,
      });

      if (!response || typeof response !== 'string') {
        this._stats.errors++;
        return;
      }

      // Chunk and deliver
      const chunks = this._chunkResponse(response, channelId);
      for (const chunk of chunks) {
        await this._deliverFn(chunk);
      }

      if (chunks.length > 1) this._stats.chunked++;
      this._stats.processed++;
      this._lastResponse.set(channelId, Date.now());

      // Add response to history
      history.push({
        channelId,
        senderId: '__assistant__',
        content: response,
        timestamp: Date.now(),
      });

    } catch (err) {
      this._stats.errors++;
      // Re-buffer messages on failure (at front)
      const currentBuffer = this._messageBuffer.get(channelId) || [];
      this._messageBuffer.set(channelId, [...messages, ...currentBuffer]);
    } finally {
      this._processing.set(channelId, false);
    }
  }

  _chunkResponse(response, channelId) {
    if (response.length <= this._config.maxResponseLength) {
      return [{
        channelId,
        content: response,
        index: 0,
        total: 1,
        final: true,
      }];
    }

    const chunks = [];
    let offset = 0;
    const chunkSize = this._config.chunkSize;

    while (offset < response.length) {
      let end = Math.min(offset + chunkSize, response.length);

      // Try to break at a sentence/paragraph boundary
      if (end < response.length) {
        const slice = response.slice(offset, end);
        const lastBreak = Math.max(
          slice.lastIndexOf('\n\n'),
          slice.lastIndexOf('。'),
          slice.lastIndexOf('. '),
          slice.lastIndexOf('! '),
          slice.lastIndexOf('? '),
        );
        if (lastBreak > chunkSize * 0.5) {
          end = offset + lastBreak + 1;
        }
      }

      chunks.push({
        channelId,
        content: response.slice(offset, end),
        index: chunks.length,
        total: -1, // set after loop
        final: false,
      });

      offset = end;
    }

    // Fix totals
    for (const chunk of chunks) {
      chunk.total = chunks.length;
    }
    if (chunks.length > 0) {
      chunks[chunks.length - 1].final = true;
    }

    return chunks;
  }
}

/**
 * Default context builder — concatenates recent messages.
 */
function defaultContextBuilder(messages, _channelId) {
  if (!messages || messages.length === 0) return '';

  const lines = [];
  for (const msg of messages) {
    const role = msg.senderId === '__assistant__' ? 'Assistant' : 'User';
    lines.push(`${role}: ${msg.content}`);
  }

  return lines.join('\n');
}

module.exports = {
  AutoReplyPipeline,
  defaultContextBuilder,
  DEFAULT_CONFIG,
};
