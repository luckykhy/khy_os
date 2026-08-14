/**
 * SlackAdapter — deliver content to Slack via Web API.
 *
 * Configuration (from config.json):
 *   slack.botToken       — xoxb- token (Bot Token)
 *   slack.channel        — default channel (e.g. #general)
 *   slack.defaultUsername — bot display name
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const { BaseAdapter } = require('./baseAdapter');

// ── Slack Block Kit helpers ────────────────────────────────────────────

function buildBlocks(text, maxLen = 3000) {
  const blocks = [];
  const paragraphs = text.split(/\n\n+/);

  for (const para of paragraphs) {
    if (para.length > maxLen) {
      // Split long paragraphs into chunks
      const chunks = splitIntoChunks(para, maxLen);
      for (const chunk of chunks) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: chunk },
        });
      }
    } else {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: para || ' ' },
      });
    }
  }
  return blocks.slice(0, 50); // Slack limit: 50 blocks per message
}

function splitIntoChunks(text, maxLen) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, maxLen);
    const lastNewline = chunk.lastIndexOf('\n');
    const splitPoint = lastNewline > maxLen * 0.5 ? lastNewline : maxLen;
    chunks.push(remaining.slice(0, splitPoint).trim());
    remaining = remaining.slice(splitPoint).trim();
  }
  return chunks;
}

// ── Adapter ────────────────────────────────────────────────────────────

class SlackAdapter extends BaseAdapter {
  constructor(config = {}, logger = console) {
    super(config, logger);
    this._available = null;
  }

  getPlatform() {
    return 'slack';
  }

  getSupportedFormats() {
    return ['text', 'blocks', 'markdown', 'rich'];
  }

  detect() {
    if (this._available !== null) return this._available;
    const hasToken = !!(this.config.botToken || this.config.slack?.botToken);
    this._available = hasToken;
    return this._available;
  }

  validateConfig() {
    const token = this.config.botToken || this.config.slack?.botToken;
    const errors = [];
    if (!token) errors.push('Missing slack.botToken in config');
    if (!this.config.channel && !this.config.slack?.channel) {
      errors.push('Missing default channel (slack.channel)');
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  /**
   * Deliver a task to Slack.
   * @param {object} task — { text, channel, thread_ts, blocks, username }
   */
  async deliver(task) {
    const token = this.config.botToken || this.config.slack?.botToken;
    const channel = task.channel || this.config.channel || this.config.slack?.channel;

    if (!channel) {
      return this.buildResult(false, {
        error: 'no_channel',
        message: 'No channel specified and no default channel in config.',
      });
    }

    const blocks = task.blocks || buildBlocks(task.text);
    const payload = {
      channel,
      text: task.text?.slice(0, 40000) || '',
      blocks,
    };

    if (task.thread_ts) payload.thread_ts = task.thread_ts;
    if (task.username) payload.username = task.username;
    if (task.icon_emoji) payload.icon_emoji = task.icon_emoji;

    try {
      const response = await this._callSlackAPI('chat.postMessage', payload, token);
      return this.buildResult(true, {
        message_ts: response.ts,
        channel: response.channel,
        url: this._buildMessageURL(response.channel, response.ts),
        segments_sent: 1,
        raw: response,
      });
    } catch (err) {
      this.logger.error(`[slack] Delivery failed: ${err.message}`);
      const errorCode = this._mapError(err.message);
      return this.buildResult(false, { error: errorCode, message: err.message });
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────

  _callSlackAPI(method, payload, token) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const options = {
        hostname: 'slack.com',
        path: `/api/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': `Bearer ${token}`,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 30_000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (!json.ok) {
              reject(new Error(`Slack API error: ${json.error} — ${json.needed?.join(',') || ''}`));
            } else {
              resolve(json);
            }
          } catch {
            reject(new Error(`Slack API returned non-JSON: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Slack API timeout')); });
      req.write(body);
      req.end();
    });
  }

  _buildMessageURL(channel, ts) {
    // Convert 1234567890.123456 → p1234567890123456
    const tsNum = ts.replace('.', '');
    return `https://app.slack.com/client/T.../${channel}/p${tsNum}`;
  }

  _mapError(message) {
    const m = message.toLowerCase();
    if (m.includes('channel_not_found')) return 'channel_not_found';
    if (m.includes('not_in_channel') || m.includes('permission')) return 'permission_denied';
    if (m.includes('rate')) return 'rate_limited';
    if (m.includes('account_inactive')) return 'auth_error';
    return 'unknown_error';
  }
}

module.exports = { SlackAdapter };
