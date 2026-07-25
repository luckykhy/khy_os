/**
 * Relay API Adapter — connect to third-party OpenAI-compatible Claude API relays.
 *
 * Supports:
 * - AWS Bedrock relay (Lambda/API Gateway)
 * - Third-party relay stations (OpenAI-SB, API2D, OhMyGPT, etc.)
 * - Self-hosted VPS reverse proxy (Nginx, Caddy)
 * - Cloudflare Workers proxy
 *
 * Config via environment variables:
 *   RELAY_API_ENDPOINT=https://your-relay.com/v1
 *   RELAY_API_KEY=sk-xxx
 *   RELAY_API_MODEL=claude-sonnet-4-20250514
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
// Model-name SSOT: the relay default model flows from backend constants/models.js.
const { PRIMARY: MODELS } = require('../../../constants/models');

const DEFAULT_MODEL = MODELS.relay;
const TIMEOUT_MS = 120_000;

let _available = null;

const API_FORMATS = new Set(['openai', 'anthropic', 'openai_responses', 'gemini']);
const KEY_FIELDS = new Set(['authorization_bearer', 'x-api-key', 'x-goog-api-key']);

// ── Config helpers ──

// apiFormat decides upstream wire protocol (path + request body shape). When not
// set explicitly we derive it from the legacy `compatibility` flag so existing
// .env files keep working: openai→openai, anthropic→anthropic, else openai.
function deriveApiFormat() {
  const explicit = String(process.env.RELAY_API_FORMAT || '').trim().toLowerCase();
  if (API_FORMATS.has(explicit)) return explicit;
  const compat = String(process.env.RELAY_API_COMPATIBILITY || '').trim().toLowerCase();
  if (compat === 'anthropic') return 'anthropic';
  return 'openai';
}

// apiKeyField decides the auth header. Default Bearer keeps the OpenAI path
// byte-for-byte identical to the previous behaviour.
function deriveKeyField(apiFormat) {
  const explicit = String(process.env.RELAY_API_KEY_FIELD || '').trim().toLowerCase();
  if (KEY_FIELDS.has(explicit)) return explicit;
  if (apiFormat === 'anthropic') return 'x-api-key';
  if (apiFormat === 'gemini') return 'x-goog-api-key';
  return 'authorization_bearer';
}

// Candidate endpoint list for endpoint-level failover. Primary = RELAY_API_ENDPOINT
// (or first of RELAY_API_ENDPOINTS); the rest are tried in order on failure.
function deriveEndpoints() {
  const primary = String(process.env.RELAY_API_ENDPOINT || '').trim();
  const extra = String(process.env.RELAY_API_ENDPOINTS || '')
    .split(/[\n,;]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const ordered = [primary, ...extra].filter(Boolean);
  return [...new Set(ordered)];
}

function getConfig() {
  const apiFormat = deriveApiFormat();
  const endpoints = deriveEndpoints();
  return {
    endpoint: endpoints[0] || '',
    endpoints,
    key: process.env.RELAY_API_KEY || '',
    model: process.env.RELAY_API_MODEL || DEFAULT_MODEL,
    apiFormat,
    keyField: deriveKeyField(apiFormat),
  };
}

// ── Protocol-aware request builders (reuse the canonical protocolConverter) ──

// Map apiFormat → upstream sub-path appended to the normalized base endpoint.
function upstreamPath(apiFormat, model) {
  switch (apiFormat) {
    case 'anthropic': return '/messages';
    case 'openai_responses': return '/responses';
    case 'gemini': return `/models/${encodeURIComponent(model)}:generateContent`;
    case 'openai':
    default: return '/chat/completions';
  }
}

// Convert an OpenAI-shaped body into the target wire protocol. OpenAI stays as-is
// (zero regression); other formats go through the shared canonical converter.
function buildUpstreamBody(apiFormat, openaiBody) {
  if (apiFormat === 'openai') return openaiBody;
  const converter = require('../protocolConverter');
  const target = apiFormat === 'openai_responses' ? converter.PROTOCOLS.CODEX
    : apiFormat === 'anthropic' ? converter.PROTOCOLS.ANTHROPIC
    : apiFormat === 'gemini' ? converter.PROTOCOLS.GEMINI
    : converter.PROTOCOLS.OPENAI;
  return converter.convertRequestBetween(openaiBody, converter.PROTOCOLS.OPENAI, target);
}

function buildAuthHeaders(keyField, key) {
  switch (keyField) {
    case 'x-api-key':
      return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    case 'x-goog-api-key':
      return { 'x-goog-api-key': key };
    case 'authorization_bearer':
    default:
      return { Authorization: `Bearer ${key}` };
  }
}

// Extract assistant text from a non-streaming upstream response across formats.
function extractResponseContent(data) {
  if (!data) return '';
  if (typeof data === 'string') return '';
  return (
    data?.choices?.[0]?.message?.content || // OpenAI chat
    data?.content?.[0]?.text ||             // Anthropic
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || // Gemini
    data?.output?.find?.((o) => o.type === 'message')?.content?.[0]?.text ||    // Codex responses
    data?.output?.text || // some relays
    ''
  );
}

// ── HTTP request with optional proxy support ──

function makeRequest(url, { method = 'POST', headers = {}, body, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    // Check for proxy environment variables
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY ||
                     process.env.http_proxy || process.env.HTTP_PROXY;

    // TLS Sidecar: route through sidecar for configured target domains
    let effectiveProxy = proxyUrl;
    try {
      const sidecar = require('../tlsSidecar');
      if (sidecar.shouldProxy(parsed.hostname)) {
        effectiveProxy = sidecar.getProxyUrl();
      }
    } catch { /* sidecar not available */ }

    let options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout,
    };

    // If proxy is configured, route through it
    if (effectiveProxy && parsed.protocol === 'https:') {
      try {
        const proxy = new URL(effectiveProxy);
        // CONNECT tunnel via proxy
        const connectReq = http.request({
          hostname: proxy.hostname,
          port: proxy.port || 80,
          method: 'CONNECT',
          path: `${parsed.hostname}:${parsed.port || 443}`,
          timeout,
        });
        connectReq.on('connect', (res, socket) => {
          if (res.statusCode !== 200) {
            reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
            return;
          }
          const tunnelOptions = {
            ...options,
            socket,
            agent: false,
          };
          const req = https.request(tunnelOptions, handleResponse(resolve, reject));
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
          if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
          req.end();
        });
        connectReq.on('error', reject);
        connectReq.on('timeout', () => { connectReq.destroy(); reject(new Error('proxy timeout')); });
        connectReq.end();
        return;
      } catch { /* fall through to direct request */ }
    }

    const req = mod.request(options, handleResponse(resolve, reject));
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function handleResponse(resolve, reject) {
  return (res) => {
    // For streaming: return the response object directly
    if (res.headers['content-type']?.includes('text/event-stream')) {
      resolve({ status: res.statusCode, stream: res, headers: res.headers });
      return;
    }
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      try { resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers }); }
      catch { resolve({ status: res.statusCode, data, headers: res.headers }); }
    });
    res.on('error', reject);
  };
}

// ── SSE stream parser ──

function parseSSEStream(stream, onChunk) {
  return new Promise((resolve, reject) => {
    let content = '';
    let model = null;
    let buffer = '';

    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            // OpenAI format
            const delta = obj.choices?.[0]?.delta;
            if (delta?.content) {
              content += delta.content;
              if (onChunk) onChunk({ type: 'text', text: delta.content });
            }
            // Anthropic format (some relays use this)
            if (obj.type === 'content_block_delta' && obj.delta?.text) {
              content += obj.delta.text;
              if (onChunk) onChunk({ type: 'text', text: obj.delta.text });
            }
            // Gemini format (streamGenerateContent)
            const geminiParts = obj.candidates?.[0]?.content?.parts;
            if (Array.isArray(geminiParts)) {
              for (const part of geminiParts) {
                if (part?.text) {
                  content += part.text;
                  if (onChunk) onChunk({ type: 'text', text: part.text });
                }
              }
            }
            // Thinking content
            if (delta?.reasoning_content || delta?.thinking) {
              const text = delta.reasoning_content || delta.thinking;
              if (onChunk) onChunk({ type: 'thinking', text });
            }
            if (obj.model) model = obj.model;
          } catch { /* skip malformed SSE */ }
        }
      }
    });

    stream.on('end', () => resolve({ content, model }));
    stream.on('error', reject);
  });
}

// ── Adapter interface ──

function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;
  const cfg = getConfig();
  _available = !!(cfg.endpoint && cfg.key);
  return _available;
}

async function generate(prompt, options = {}) {
  const cfg = getConfig();
  // Support external key/endpoint override (from apiKeyPool)
  const activeKey = options.apiKey || cfg.key;
  // Endpoint override (apiKeyPool) takes precedence; otherwise use the candidate
  // list so a failing primary endpoint falls over to the next one.
  const endpointList = options.apiEndpoint ? [options.apiEndpoint] : cfg.endpoints;
  const activeEndpoint = endpointList[0] || '';

  if (!activeEndpoint || !activeKey) {
    return {
      success: false, content: '', provider: 'Relay API', adapter: 'relay_api',
      error: 'RELAY_API_ENDPOINT and RELAY_API_KEY not configured',
      attempts: [{ provider: 'Relay API', success: false, error: 'not_configured' }],
    };
  }

  const model = options.model || cfg.model;
  // Per-user upstream (multi-tenant) supplies its own wire format + key field;
  // absent those overrides, fall back to the global cfg (byte-identical).
  const apiFormat = options.apiFormat || cfg.apiFormat;
  const keyField = options.apiKeyField || cfg.keyField;
  const useStream = !!(options.onChunk);

  // Build messages: use structured messages if provided, else wrap prompt
  let messages;
  if (options.messages && options.messages.length > 0) {
    messages = options.messages.map(m => ({ role: m.role, content: m.content }));
    // Prepend system message if provided
    if (options.system) {
      messages = [{ role: 'system', content: options.system }, ...messages];
    }
  } else {
    messages = [{ role: 'user', content: prompt }];
    if (options.system) {
      messages = [{ role: 'system', content: options.system }, ...messages];
    }
  }

  // Canonical OpenAI-shaped body; converted to the target wire format per endpoint.
  const openaiBody = {
    model,
    messages,
    stream: useStream,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 2048,
  };
  const body = buildUpstreamBody(apiFormat, openaiBody);
  const authHeaders = buildAuthHeaders(keyField, activeKey);
  const subPath = upstreamPath(apiFormat, model);

  const attempts = [];

  for (let i = 0; i < endpointList.length; i++) {
    const endpoint = String(endpointList[i]).replace(/\/+$/, '');
    const url = `${endpoint}${subPath}`;
    const host = (() => { try { return new URL(endpoint).hostname; } catch { return endpoint; } })();
    const isLast = i === endpointList.length - 1;

    try {
      const res = await makeRequest(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
          'Accept': useStream ? 'text/event-stream' : 'application/json',
        },
        body,
      });

      if (res.status !== 200 && !res.stream) {
        const errMsg = res.data?.error?.message || res.data?.message || `HTTP ${res.status}`;
        attempts.push({ provider: `Relay API (${host}/${model})`, success: false, error: errMsg, statusCode: res.status });
        // 5xx → try the next candidate endpoint; 4xx is a config/auth error, stop.
        if (res.status >= 500 && !isLast) continue;
        return {
          success: false, content: '', provider: 'Relay API', adapter: 'relay_api',
          error: errMsg, statusCode: res.status, headers: res.headers || null, attempts,
        };
      }

      // Streaming response
      if (res.stream) {
        const { content, model: usedModel } = await parseSSEStream(res.stream, options.onChunk);
        const displayModel = usedModel || model;
        attempts.push({ provider: `Relay API (${host}/${displayModel})`, success: true });
        return {
          success: true,
          content: content.trim(),
          provider: `Relay (${displayModel})`,
          adapter: 'relay_api',
          model: displayModel,
          attempts,
        };
      }

      // Non-streaming response (format-aware extraction)
      const data = res.data;
      const content = extractResponseContent(data);
      const usedModel = data?.model || model;

      if (!content) {
        const rawSnippet = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200);
        attempts.push({ provider: `Relay API (${host}/${usedModel})`, success: false, error: 'empty_response' });
        if (!isLast) continue;
        return {
          success: false, content: '', provider: 'Relay API', adapter: 'relay_api',
          error: `Empty response (HTTP ${res.status}, body: ${rawSnippet})`, attempts,
        };
      }

      attempts.push({ provider: `Relay API (${host}/${usedModel})`, success: true });
      return {
        success: true,
        content: content.trim(),
        provider: `Relay (${usedModel})`,
        adapter: 'relay_api',
        model: usedModel,
        tokenUsage: data.usage ? {
          inputTokens: data.usage.prompt_tokens ?? data.usage.input_tokens,
          outputTokens: data.usage.completion_tokens ?? data.usage.output_tokens,
          totalTokens: data.usage.total_tokens,
        } : null,
        attempts,
      };
    } catch (err) {
      attempts.push({ provider: `Relay API (${host}/${model})`, success: false, error: err.message });
      // Network/timeout error → fall over to next endpoint if any remain.
      if (!isLast) continue;
      return {
        success: false, content: '', provider: 'Relay API', adapter: 'relay_api',
        error: err.message, attempts,
      };
    }
  }

  // Should be unreachable, but keep a definite return.
  return {
    success: false, content: '', provider: 'Relay API', adapter: 'relay_api',
    error: 'All relay endpoints failed', attempts,
  };
}

function getStatus() {
  detect();
  const cfg = getConfig();
  let detail;
  if (_available) {
    const endpoint = cfg.endpoint.replace(/\/+$/, '');
    const host = (() => { try { return new URL(endpoint).hostname; } catch { return endpoint; } })();
    const extra = cfg.endpoints.length > 1 ? ` +${cfg.endpoints.length - 1} 备用` : '';
    detail = `已配置 → ${host} (${cfg.model}) [${cfg.apiFormat}]${extra}`;
  } else {
    detail = '未配置 — 运行 gateway config 设置中转地址和密钥';
  }
  return { name: 'API 中转', type: 'relay_api', available: _available, detail };
}

function destroy() {
  _available = null;
}

module.exports = { detect, generate, getStatus, destroy };
