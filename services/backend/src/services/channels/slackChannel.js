'use strict';

/**
 * Slack Channel — Slack integration via Web API + Socket Mode.
 *
 * Environment variables:
 *   SLACK_BOT_TOKEN     — Bot User OAuth Token (xoxb-...)
 *   SLACK_SIGNING_SECRET — Signing secret for webhook verification
 *   SLACK_APP_TOKEN      — App-Level Token for Socket Mode (xapp-...)
 *
 * Modes:
 *   - Socket Mode (preferred): real-time events via WebSocket, no public endpoint needed
 *   - Webhook Mode: receive Events API callbacks at POST /webhooks/slack
 */

const { BaseChannel } = require('./_baseChannel');
const log = require('../../utils/logger');

class SlackChannel extends BaseChannel {
  /**
   * @param {object} [config]
   * @param {string} [config.botToken] - Override SLACK_BOT_TOKEN env var
   * @param {string} [config.signingSecret] - Override SLACK_SIGNING_SECRET env var
   * @param {string} [config.appToken] - Override SLACK_APP_TOKEN env var
   * @param {'socket'|'webhook'} [config.mode='socket']
   */
  constructor(config = {}) {
    super({ name: 'slack', config });
    this.botToken = config.botToken || process.env.SLACK_BOT_TOKEN || '';
    this.signingSecret = config.signingSecret || process.env.SLACK_SIGNING_SECRET || '';
    this.appToken = config.appToken || process.env.SLACK_APP_TOKEN || '';
    this.mode = config.mode || 'socket';
    this._ws = null;
    this._botUserId = null;
  }

  async connect() {
    if (!this.botToken) throw new Error('SLACK_BOT_TOKEN is required');

    // Verify token and get bot user ID
    const authResult = await this._apiCall('auth.test', {});
    this._botUserId = authResult.user_id;
    log.info(`Slack connected as ${authResult.user} (${this._botUserId})`);

    if (this.mode === 'socket' && this.appToken) {
      await this._connectSocketMode();
    }

    this._connected = true;
    this.emit('connected');
  }

  async disconnect() {
    if (this._ws) {
      try { this._ws.close(); } catch { /* ignore */ }
      this._ws = null;
    }
    await super.disconnect();
  }

  async sendMessage(channelId, text, opts = {}) {
    const payload = {
      channel: channelId,
      text,
      ...(opts.blocks ? { blocks: opts.blocks } : {}),
      ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}),
    };
    return this._apiCall('chat.postMessage', payload);
  }

  async sendReply(channelId, threadTs, text, opts = {}) {
    return this.sendMessage(channelId, text, { ...opts, thread_ts: threadTs });
  }

  /**
   * Handle an incoming webhook event (Events API).
   * Called by the webhook route handler.
   * @param {object} event - Slack event payload
   */
  handleWebhookEvent(event) {
    if (!event || !event.type) return;

    // Skip bot's own messages
    if (event.bot_id || event.user === this._botUserId) return;

    if (event.type === 'message' || event.type === 'app_mention') {
      let text = event.text || '';
      // Strip bot mention prefix
      if (this._botUserId) {
        text = text.replace(new RegExp(`<@${this._botUserId}>\\s*`, 'g'), '').trim();
      }

      this.emit('message', {
        channelId: event.channel,
        userId: event.user,
        text,
        threadId: event.thread_ts || event.ts,
        timestamp: event.ts,
        raw: event,
      });
    }
  }

  /**
   * Verify a webhook request signature.
   * @param {string} signature - X-Slack-Signature header
   * @param {string} timestamp - X-Slack-Request-Timestamp header
   * @param {string} body - Raw request body
   * @returns {boolean}
   */
  verifySignature(signature, timestamp, body) {
    if (!this.signingSecret) return false;
    const crypto = require('crypto');
    const sigBasestring = `v0:${timestamp}:${body}`;
    const mySignature = 'v0=' + crypto.createHmac('sha256', this.signingSecret)
      .update(sigBasestring, 'utf8')
      .digest('hex');
    const a = Buffer.from(mySignature, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  // ── Socket Mode ──

  async _connectSocketMode() {
    // Request WebSocket URL
    const http = require('http');
    const result = await new Promise((resolve, reject) => {
      const postData = '';
      const req = http.request({
        hostname: 'slack.com',
        port: 443,
        path: '/api/apps.connections.open',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.appToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': 0,
        },
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.end();
    });

    if (!result.ok || !result.url) {
      log.warn('Slack Socket Mode connection failed, falling back to webhook mode');
      this.mode = 'webhook';
      return;
    }

    try {
      const WebSocket = require('ws');
      this._ws = new WebSocket(result.url);
      this._ws.on('message', (data) => this._onSocketMessage(data));
      this._ws.on('close', () => {
        log.info('Slack Socket Mode disconnected');
        this._ws = null;
      });
      this._ws.on('error', (err) => {
        log.error('Slack Socket Mode error:', err.message);
        this.emit('error', { error: err });
      });
      log.info('Slack Socket Mode connected');
    } catch {
      log.warn('ws module not available, using webhook mode only');
      this.mode = 'webhook';
    }
  }

  _onSocketMessage(data) {
    try {
      const envelope = JSON.parse(data.toString());

      // Acknowledge immediately
      if (envelope.envelope_id && this._ws) {
        this._ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      }

      if (envelope.payload?.event) {
        this.handleWebhookEvent(envelope.payload.event);
      }
    } catch (err) {
      log.debug('Slack socket parse error:', err.message);
    }
  }

  // ── Slack Web API ──

  async _apiCall(method, payload) {
    const https = require('https');
    const body = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'slack.com',
        path: `/api/${method}`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (!result.ok) reject(new Error(`Slack API ${method}: ${result.error || 'unknown'}`));
            else resolve(result);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  toJSON() {
    return {
      ...super.toJSON(),
      mode: this.mode,
      botUserId: this._botUserId,
      hasToken: !!this.botToken,
      hasAppToken: !!this.appToken,
    };
  }
}

module.exports = { SlackChannel };
