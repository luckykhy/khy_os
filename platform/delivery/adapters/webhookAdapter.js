/**
 * WebhookAdapter — deliver content via HTTP POST to a webhook URL.
 *
 * Supports HMAC-SHA256 signing, idempotency keys, retries.
 *
 * Configuration:
 *   webhook.defaultUrl   — fallback URL if not provided in task
 *   webhook.secret       — HMAC secret for signing
 *   webhook.timeoutMs    — request timeout (default 10000)
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const urlModule = require('url');
const { BaseAdapter } = require('./baseAdapter');

// ── Helpers ────────────────────────────────────────────────────────────

function buildIdempotencyKey() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function signPayload(payload, secret) {
  const signature = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  return `sha256=${signature}`;
}

function isInternalUrl(urlStr) {
  try {
    const parsed = urlModule.parse(urlStr);
    const hostname = parsed.hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

// ── Adapter ────────────────────────────────────────────────────────────

class WebhookAdapter extends BaseAdapter {
  constructor(config = {}, logger = console) {
    super(config, logger);
    this._available = true;
  }

  getPlatform() { return 'webhook'; }
  getSupportedFormats() { return ['json', 'form-data', 'text']; }

  detect() { return true; }
  validateConfig() {
    const errors = [];
    const warnings = [];
    if (!this.config.defaultUrl && !this.config.webhook?.defaultUrl) {
      warnings.push('No default webhook URL configured — task must provide url.');
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  async deliver(task) {
    const webhookUrl = task.url || this.config.defaultUrl || this.config.webhook?.defaultUrl;
    const secret = task.secret || this.config.secret || this.config.webhook?.secret;
    const timeoutMs = task.timeout_ms || this.config.timeoutMs || this.config.webhook?.timeoutMs || 10000;

    if (!webhookUrl) {
      return this.buildResult(false, { error: 'no_url', message: 'No webhook URL provided.' });
    }

    if (isInternalUrl(webhookUrl)) {
      this.logger.warn(`[webhook] Internal-only URL detected, skipping actual send: ${webhookUrl}`);
      return this.buildResult(true, {
        url: webhookUrl,
        status: 0,
        internal_only: true,
        delivery_id: buildIdempotencyKey(),
      });
    }

    const deliveryId = buildIdempotencyKey();
    const payload = task.payload || { text: task.text || '' };
    const payloadStr = JSON.stringify(payload);

    if (Buffer.byteLength(payloadStr) > 10 * 1024 * 1024) {
      return this.buildResult(false, { error: 'payload_too_large', message: 'Payload exceeds 10MB limit.' });
    }

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payloadStr),
      'X-Delivery-Id': deliveryId,
    };

    if (secret) {
      headers['X-Webhook-Signature'] = signPayload(payload, secret);
    }

    let retries = 0;
    const maxRetries = task.retry_on_failure !== false ? 3 : 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this._sendRequest(webhookUrl, payloadStr, headers, timeoutMs);
        if (result.status >= 200 && result.status < 300) {
          return this.buildResult(true, {
            url: webhookUrl,
            status: result.status,
            response: result.body,
            delivery_id: deliveryId,
            signature: secret ? headers['X-Webhook-Signature'] : undefined,
            retries_used: retries,
            duration_ms: result.durationMs,
          });
        }

        // Retry on 429 and 5xx
        if ((result.status === 429 || result.status >= 500) && attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
          this.logger.warn(`[webhook] HTTP ${result.status}, retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          retries++;
          continue;
        }

        // Non-retryable error
        return this.buildResult(false, {
          url: webhookUrl,
          status: result.status,
          error: `HTTP_${result.status}`,
          message: result.body?.message || `HTTP ${result.status}`,
          delivery_id: deliveryId,
          retries_used: retries,
        });
      } catch (err) {
        if (attempt < maxRetries && (err.message.includes('timeout') || err.message.includes('ECONNREFUSED') || err.message.includes('ENOTFOUND'))) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
          this.logger.warn(`[webhook] Network error, retrying in ${delay}ms: ${err.message}`);
          await new Promise((r) => setTimeout(r, delay));
          retries++;
          continue;
        }
        return this.buildResult(false, {
          url: webhookUrl,
          error: 'network_error',
          message: err.message,
          delivery_id: deliveryId,
          retries_used: retries,
        });
      }
    }
  }

  _sendRequest(urlStr, body, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const parsed = urlModule.parse(urlStr);
      const transport = parsed.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.path || '/',
        method: 'POST',
        headers,
        timeout: timeoutMs,
      };

      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: data ? JSON.parse(data) : null,
            durationMs: Date.now() - startTime,
          });
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Webhook request timeout')); });
      req.write(body);
      req.end();
    });
  }
}

module.exports = { WebhookAdapter };
