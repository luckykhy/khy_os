'use strict';

const { defineTool } = require('./_baseTool');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const toolErrorCodes = require('../services/toolErrorCodes');

/**
 * httpRequest — generic HTTP client (GET/POST/PUT/DELETE/PATCH/HEAD).
 *
 * Fills the gap where the only network tools were the purpose-built WebSearch /
 * WebFetch; an agent had to shell out to `curl` for a plain API call. Uses node's
 * built-in http/https (zero external deps, so it works in the bundled runtime
 * before any npm install). Returns a structured result; failures carry an
 * `errorClass` (CONFIG_MISSING vs SERVICE_UNAVAILABLE vs BAD_PARAM) via the
 * shared toolErrorCodes leaf so callers can branch/retry deterministically.
 *
 * Safety: only http/https schemes are honored; response body is capped to avoid
 * blowing the context window; redirects are followed up to a small bound.
 */

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB cap on captured response body
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30000;
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];

/** Perform a single request (no redirect handling); resolves to a result-ish object. */
function _once(urlStr, { method, headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(urlStr);
    } catch {
      resolve({ _err: { code: 'BAD_PARAM', message: `非法 URL：${urlStr}` } });
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      resolve({ _err: { code: 'BAD_PARAM', message: `不支持的协议：${target.protocol}（仅 http/https）` } });
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const reqHeaders = Object.assign({}, headers || {});
    let payload = null;
    if (body != null && method !== 'GET' && method !== 'HEAD') {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!Object.keys(reqHeaders).some((h) => h.toLowerCase() === 'content-type')) {
        reqHeaders['Content-Type'] = typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
      }
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = lib.request(
      target,
      { method, headers: reqHeaders, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c) => {
          size += c.length;
          if (size <= MAX_BODY_BYTES) {
            chunks.push(c);
          } else if (!truncated) {
            truncated = true;
            const room = MAX_BODY_BYTES - (size - c.length);
            if (room > 0) chunks.push(c.slice(0, room));
          }
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage || '',
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
            truncated,
            location: res.headers && res.headers.location,
          });
        });
      },
    );
    req.on('error', (err) => {
      // Connection refused / DNS / reset / TLS → service unavailable (transient).
      resolve({ _err: { code: 'SERVICE_UNAVAILABLE', message: err.message } });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ _err: { code: 'TIMEOUT', message: `请求超时（${timeoutMs}ms）` } });
    });
    if (payload != null) req.write(payload);
    req.end();
  });
}

module.exports = defineTool({
  name: 'httpRequest',
  description:
    'Make an HTTP/HTTPS request (GET/POST/PUT/DELETE/PATCH/HEAD) to an arbitrary URL and return the status, '
    + 'headers and body. Use for calling REST/JSON APIs directly instead of shelling out to curl. '
    + 'Body capped at 1 MiB; redirects followed up to 5 hops.',
  category: 'data',
  risk: 'medium',
  isReadOnly: false,
  isConcurrencySafe: true,
  // `fetch_url` intentionally omitted — it denotes "read a page's content" and is
  // owned by the `WebFetch` tool (GET-only, SSRF-guarded page reader). httpRequest
  // is the general REST client, so it keeps `curl` (arbitrary verbs). Splitting the
  // previously-shared `fetch_url`/`curl` aliases gives each normalized key a single
  // owner → deterministic resolution (see toolContract auditor + _toolKey).
  aliases: ['http_request', 'curl'],
  searchHint: 'http request rest api call get post put delete curl fetch endpoint',
  inputSchema: {
    url: { type: 'string', required: true, description: 'Absolute http(s) URL to request.' },
    method: {
      type: 'string',
      required: false,
      enum: ALLOWED_METHODS,
      default: 'GET',
      description: 'HTTP method (default GET).',
    },
    headers: {
      type: 'object',
      required: false,
      description: 'Optional request headers as a flat {name: value} object.',
    },
    body: {
      type: 'string',
      required: false,
      description: 'Optional request body (string). For JSON, pass a JSON string; Content-Type defaults accordingly.',
    },
    timeout: {
      type: 'number',
      required: false,
      min: 1,
      max: 120000,
      description: `Per-attempt timeout in ms (default ${DEFAULT_TIMEOUT_MS}).`,
    },
  },

  async validateInput(input) {
    if (!input || !input.url || !String(input.url).trim()) {
      return { valid: false, message: 'url is required.' };
    }
    return { valid: true };
  },

  getActivityDescription(input) {
    const m = (input && input.method) || 'GET';
    const u = input && input.url ? String(input.url) : '';
    return `HTTP ${m} ${u.length > 60 ? `${u.slice(0, 60)}…` : u}`;
  },

  async execute(params, _context) {
    const method = String((params && params.method) || 'GET').toUpperCase();
    if (!ALLOWED_METHODS.includes(method)) {
      return toolErrorCodes.enrich({
        success: false,
        code: 'BAD_PARAM',
        error: `不支持的方法：${method}（允许:${ALLOWED_METHODS.join('/')}）`,
      });
    }
    const timeoutMs = Number.isFinite(params && params.timeout) ? params.timeout : DEFAULT_TIMEOUT_MS;

    let url = String((params && params.url) || '');
    let headers = (params && params.headers) || {};
    const body = params && params.body;
    let res;
    let hops = 0;
    // Follow redirects (GET/HEAD only — re-issuing a POST body across hosts is unsafe).
    while (true) {
      res = await _once(url, { method, headers, body, timeoutMs });
      if (res._err) {
        return toolErrorCodes.enrich({
          success: false,
          code: res._err.code,
          error: res._err.message,
          content: res._err.message,
          meta: { url, method },
        });
      }
      const isRedirect = res.status >= 300 && res.status < 400 && res.location;
      if (isRedirect && (method === 'GET' || method === 'HEAD') && hops < MAX_REDIRECTS) {
        hops += 1;
        try {
          url = new URL(res.location, url).toString();
        } catch {
          break; // malformed Location → stop, return what we have
        }
        continue;
      }
      break;
    }

    const ok = res.status >= 200 && res.status < 400;
    if (!ok) {
      // 5xx / 408 / 429 → transient service issue (retryable). Other 4xx → the
      // request itself was rejected (auth/not-found/bad-request): surfaced as
      // UPSTREAM_ERROR which classifies to UNKNOWN (not auto-retryable). The body
      // is kept either way so the caller can inspect it.
      const transient = res.status >= 500 || res.status === 408 || res.status === 429;
      const error = `HTTP ${res.status} ${res.statusText}`.trim();
      return toolErrorCodes.enrich({
        success: false,
        code: transient ? 'SERVICE_UNAVAILABLE' : 'UPSTREAM_ERROR',
        error,
        content: res.body || error,
        status: res.status,
        headers: res.headers,
        body: res.body,
        meta: { url, method, redirects: hops, truncated: res.truncated },
      });
    }

    return {
      success: true,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      body: res.body,
      content: res.body || `HTTP ${res.status} ${res.statusText}`.trim(),
      meta: { url, method, redirects: hops, truncated: res.truncated },
    };
  },
});
