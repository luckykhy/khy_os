/**
 * ApiAdapter — deliver content via HTTP request to arbitrary API endpoints.
 */

const https = require('https');
const http = require('http');
const { BaseAdapter } = require('./baseAdapter');

class ApiAdapter extends BaseAdapter {
  constructor(config = {}, logger = console) {
    super(config, logger);
    this._available = true;
  }

  getPlatform() { return 'api'; }
  getSupportedFormats() { return ['json', 'form-data', 'xml', 'text']; }

  detect() { return true; }
  validateConfig() { return { valid: true, errors: [], warnings: [] }; }

  async deliver(task) {
    const url = task.url || this.config.defaultUrl;
    const method = (task.method || 'POST').toUpperCase();
    const headers = task.headers || {};
    const body = task.body;
    const params = task.params || {};
    const timeoutMs = task.timeout_ms || this.config.timeoutMs || 30000;

    if (!url) {
      return this.buildResult(false, { error: 'no_url', message: 'No API URL provided.' });
    }

    // Build full URL with query params for GET requests
    let fullPath = url;
    if (method === 'GET' && Object.keys(params).length > 0) {
      const qs = new URLSearchParams(params).toString();
      fullPath = url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
    }

    const bodyStr = body ? JSON.stringify(body) : null;
    const requestHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };
    if (bodyStr) requestHeaders['Content-Length'] = Buffer.byteLength(bodyStr);

    const startTime = Date.now();
    let retries = 0;

    for (let attempt = 0; attempt <= (task.retry_count || 3); attempt++) {
      try {
        const result = await this._sendRequest(fullPath, method, requestHeaders, bodyStr, timeoutMs);

        if (task.expected_status?.includes(result.status)) {
          return this.buildResult(true, {
            endpoint: url,
            status: result.status,
            response: result.body,
            headers: result.headers,
            retries_used: retries,
            duration_ms: Date.now() - startTime,
          });
        }

        // Retry on rate limit and 5xx
        if ((result.status === 429 || result.status >= 500) && attempt < (task.retry_count || 3)) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
          this.logger.warn(`[api] HTTP ${result.status}, retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          retries++;
          continue;
        }

        return this.buildResult(false, {
          endpoint: url,
          status: result.status,
          error: this._mapError(result.status),
          message: result.body?.message || result.body?.error || `HTTP ${result.status}`,
          retries_used: retries,
          duration_ms: Date.now() - startTime,
        });
      } catch (err) {
        if (attempt < (task.retry_count || 3) && (err.message.includes('timeout') || err.message.includes('ECONNREFUSED'))) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
          await new Promise((r) => setTimeout(r, delay));
          retries++;
          continue;
        }
        return this.buildResult(false, {
          endpoint: url,
          error: 'network_error',
          message: err.message,
          retries_used: retries,
          duration_ms: Date.now() - startTime,
        });
      }
    }
  }

  _sendRequest(urlStr, method, headers, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(urlStr);
      const transport = parsed.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
        timeout: timeoutMs,
      };

      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsedBody = null;
          try { parsedBody = JSON.parse(data); } catch { parsedBody = data; }
          resolve({ status: res.statusCode, body: parsedBody, headers: res.headers });
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('API request timeout')); });
      if (body) req.write(body);
      req.end();
    });
  }

  _mapError(status) {
    if (status === 401) return 'auth_error';
    if (status === 403) return 'permission_denied';
    if (status === 404) return 'not_found';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'server_error';
    return 'bad_request';
  }
}

module.exports = { ApiAdapter };
