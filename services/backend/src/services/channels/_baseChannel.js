'use strict';

/**
 * Base Channel — abstract base class for external messaging channels.
 *
 * Subclasses implement connect/disconnect/sendMessage/sendReply for specific
 * platforms (Slack, Discord, Telegram, etc.).
 *
 * Emits:
 *   'message'  — incoming user message { channelId, userId, text, raw, timestamp }
 *   'command'  — slash command from external platform { channelId, userId, command, args, raw }
 *   'error'    — channel error { error }
 *   'connected' — channel connected
 *   'disconnected' — channel disconnected
 */

const EventEmitter = require('events');

class BaseChannel extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.name - Channel name (e.g. 'slack', 'discord')
   * @param {object} [opts.config] - Channel-specific configuration
   */
  constructor(opts) {
    super();
    this.name = opts.name;
    this.config = opts.config || {};
    this._connected = false;
  }

  /** @returns {boolean} */
  get connected() { return this._connected; }

  /**
   * Connect to the external service.
   * @returns {Promise<void>}
   */
  async connect() {
    throw new Error(`${this.name}: connect() not implemented`);
  }

  /**
   * Disconnect from the external service.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this._connected = false;
    this.emit('disconnected');
  }

  /**
   * Send a message to a specific channel/conversation.
   * @param {string} channelId - Target channel or conversation ID
   * @param {string} text - Message text
   * @param {object} [opts] - Platform-specific options (attachments, blocks, etc.)
   * @returns {Promise<object>} Platform-specific response
   */
  async sendMessage(channelId, text, opts) {
    throw new Error(`${this.name}: sendMessage() not implemented`);
  }

  /**
   * Reply to a specific message (threaded if supported).
   * @param {string} channelId
   * @param {string} threadId - Thread/message ID to reply to
   * @param {string} text
   * @param {object} [opts]
   * @returns {Promise<object>}
   */
  async sendReply(channelId, threadId, text, opts) {
    // Default: fall back to sendMessage (no threading)
    return this.sendMessage(channelId, text, opts);
  }

  /**
   * Get channel info for diagnostics.
   * @returns {object}
   */
  toJSON() {
    return {
      name: this.name,
      connected: this._connected,
    };
  }
}

module.exports = { BaseChannel };
