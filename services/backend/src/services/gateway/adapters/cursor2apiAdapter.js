/**
 * Cursor2API Adapter
 *
 * Connects KHY gateway to a local/remote cursor2api service:
 *   - POST /v1/chat/completions
 *   - GET  /v1/models
 *   - GET  /health
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const integration = require('../../cursor2apiIntegrationService');
const { createProtocolHandler } = require('./_protocolPipeline');
const { buildSuccess, buildFailure } = require('./_responseBuilder');
// Model-name SSOT: relay-family default flows from constants/models.js.
const { PRIMARY: MODELS } = require('../../../constants/models');

const _openaiHandler = createProtocolHandler({ protocol: 'openai', adapterName: 'cursor2api' });

const DEFAULT_MODEL = MODELS.relay;
const DEFAULT_TIMEOUT_MS = 120_000;
const DETECT_TIMEOUT_MS = 6_000;
const DETECT_CACHE_MS = 15_000;

let _available = false;
let _lastCheckAt = 0;
let _lastDetail = '未检测';

function toInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function getConfig(options = {}) {
  const stored = integration.loadConfig();
  const port = toInt(process.env.CURSOR2API_PORT, toInt(stored.port, 3010));
  const baseUrl = (process.env.CURSOR2API_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  const token = String(options.apiKey || options.token || process.env.CURSOR2API_TOKEN || stored.authToken || '').trim();
  const model = String(options.model || process.env.CURSOR2API_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  return { baseUrl, token, model, port };
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function makeRequest(url, { method = 'GET', headers = {}, body = null, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;

    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search || ''}`,
      method,
      headers,
      timeout,
    }, (res) => {
      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      if (contentType.includes('text/event-stream')) {
        resolve({ status: res.statusCode || 0, stream: res, headers: res.headers });
        return;
      }

      let raw = '';
      res.on('data', (chunk) => { raw += chunk.toString(); });
      res.on('end', () => {
        let data = raw;
        try { data = raw ? JSON.parse(raw) : {}; } catch { /* keep raw */ }
        resolve({ status: res.statusCode || 0, data, headers: res.headers });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('request timeout'));
    });

    if (body != null) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function extractErrorMessage(response) {
  const data = response?.data;
  if (!data) return `HTTP ${response?.status || 500}`;
  if (typeof data === 'string') return data.slice(0, 500);
  return data?.error?.message || data?.message || `HTTP ${response?.status || 500}`;
}

// parseSSEStream delegated to protocol pipeline
function parseSSEStream(stream, onChunk, { hasTools = false } = {}) {
  return _openaiHandler.parseStreamResponse(stream, onChunk, {
    enableToolCalls: hasTools,
    enableThinking: false,
    // Stale-stream teardown, same wiring relay uses for the SSE parsers
    // (single-sourced in streamStallPolicy). cursor2api speaks OpenAI format →
    // 'openai' threshold. A mid-stream stall now tears the stream down → partial
    // salvage or retry/failover, instead of hanging to the socket timeout. Gate
    // KHY_STREAM_STALL_ABORT off → byte-identical to the previous behavior.
    enableStaleDetection: true,
    staleOptions: {
      provider: 'openai',
      onStale: (elapsed) => {
        try { onChunk({ type: 'status', text: `Stream stale: no data for ${Math.round(elapsed / 1000)}s` }); } catch { /* ignore */ }
      },
    },
  });
}

async function detectAsync(forceRefresh = false) {
  if (process.env.GATEWAY_CURSOR2API_ENABLED === 'false') {
    _available = false;
    _lastDetail = '已禁用';
    return false;
  }

  const now = Date.now();
  if (!forceRefresh && now - _lastCheckAt < DETECT_CACHE_MS) return _available;

  const { baseUrl, token } = getConfig();
  try {
    const res = await makeRequest(`${baseUrl}/health`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...authHeaders(token),
      },
      timeout: DETECT_TIMEOUT_MS,
    });

    _available = res.status >= 200 && res.status < 300;
    _lastDetail = _available ? `在线 (${baseUrl})` : `HTTP ${res.status}`;
  } catch (err) {
    _available = false;
    _lastDetail = `不可达: ${err.message}`;
  } finally {
    _lastCheckAt = now;
  }

  return _available;
}

function detect() {
  return _available;
}

async function listModels() {
  const { baseUrl, token, model } = getConfig();
  const fallback = [{ id: model, name: model, isDefault: true, provider: 'cursor2api', description: '' }];

  try {
    const res = await makeRequest(`${baseUrl}/v1/models`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...authHeaders(token),
      },
      timeout: DETECT_TIMEOUT_MS,
    });

    if (!(res.status >= 200 && res.status < 300) || !res.data) {
      return fallback;
    }

    const rows = Array.isArray(res.data.data) ? res.data.data : [];
    const models = rows
      .map((m) => {
        const id = String(m.id || '').trim();
        if (!id) return null;
        return {
          id,
          name: String(m.name || id),
          isDefault: id === model || m.is_default === true,
          provider: 'cursor2api',
          description: String(m.description || ''),
        };
      })
      .filter(Boolean);

    return models.length > 0 ? models : fallback;
  } catch {
    return fallback;
  }
}

async function generate(prompt, options = {}) {
  const cfg = getConfig(options);

  // Build request body via protocol pipeline
  const { body } = _openaiHandler.buildRequestBody(prompt, {
    ...options,
    model: cfg.model,
    stream: !!options.onChunk,
    max_tokens: options.maxTokens ?? 4096,
    temperature: options.temperature ?? 0.3,
  });
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  try {
    const res = await makeRequest(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: options.onChunk ? 'text/event-stream' : 'application/json',
        ...authHeaders(cfg.token),
      },
      body,
      timeout: DEFAULT_TIMEOUT_MS,
    });

    if (!(res.status >= 200 && res.status < 300) && !res.stream) {
      const errMsg = extractErrorMessage(res);
      return buildFailure(errMsg, {
        adapter: 'cursor2api', provider: 'Cursor2API', statusCode: res.status,
        attempts: [{ provider: `Cursor2API (${cfg.model})`, success: false, error: errMsg, statusCode: res.status }],
      });
    }

    if (res.stream) {
      const streamed = await parseSSEStream(res.stream, options.onChunk, { hasTools });
      const usedModel = streamed.model || cfg.model;
      return buildSuccess(String(streamed.content || '').trim(), {
        adapter: 'cursor2api', provider: `Cursor2API (${usedModel})`, model: usedModel,
        toolUseBlocks: streamed.toolUseBlocks || [],
        stopReason: streamed.stopReason || 'end_turn',
        attempts: [{ provider: `Cursor2API (${usedModel})`, success: true }],
      });
    }

    // Non-streaming: parse via protocol pipeline
    const parsed = _openaiHandler.parseJsonResponse(res.data);
    const usedModel = parsed.model || cfg.model;
    return buildSuccess(parsed.content, {
      adapter: 'cursor2api', provider: `Cursor2API (${usedModel})`, model: usedModel,
      toolUseBlocks: parsed.toolUseBlocks, stopReason: parsed.stopReason,
      attempts: [{ provider: `Cursor2API (${usedModel})`, success: true }],
    });
  } catch (err) {
    return buildFailure(err, {
      adapter: 'cursor2api', provider: 'Cursor2API',
      attempts: [{ provider: `Cursor2API (${cfg.model})`, success: false, error: err.message }],
    });
  }
}

function getStatus() {
  const cfg = getConfig();
  return {
    name: 'Cursor2API',
    type: 'cursor2api',
    available: _available,
    detail: _available ? `在线 (${cfg.baseUrl})` : _lastDetail,
  };
}

module.exports = {
  detect,
  detectAsync,
  generate,
  listModels,
  getStatus,
};
