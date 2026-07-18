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
const { extractPrimaryApiKey } = require('../../apiKeyFormat');
const { createAdapterRuntimeDiagnosticsStore } = require('../runtimeDiagnosticsStore');
const { normalizeAbortReason, createAbortError, isAbortLikeError } = require('./_abortHelpers');
const { parseOpenAISseStream } = require('./_openaiSseStream');
const { isTransientError: _sharedIsTransient, sleepAbortable: _sharedSleep } = require('./_retryWithBackoff');
const { classifyAdapterError: _sharedClassify } = require('./_errorClassifiers');
const { connectThroughProxy: _sharedConnectProxy } = require('./_proxyTunnel');
const { createProtocolHandler } = require('./_protocolPipeline');
const _adaptiveParamStrip = require('./adaptiveParamStrip');
const { buildSuccess, buildFailure } = require('./_responseBuilder');
const { normalizeCacheUsage } = require('./_cacheUsage');
const { clampMaxTokensForGlmVision } = require('../glmVisionMaxTokens');
const { downscaleGlmVisionImages, downscaleImageBlocksInMessages } = require('../glmVisionImageDownscale');
const { clampTextBudgetInMessages } = require('../glmVisionTextBudget');
// Model-name SSOT: relay default flows from constants/models.js
// (env RELAY_API_MODEL still overrides at call sites).
const { PRIMARY: MODELS } = require('../../../constants/models');

const DEFAULT_MODEL = MODELS.relay;
const TIMEOUT_MS = 120_000;

// Standard Anthropic Messages API version. The prior hardcoded '2024-10-22'
// is not a valid Anthropic version date and risks rejection by strict relays;
// '2023-06-01' is the published stable version. Overridable for relays that
// pin a newer dated version.
const ANTHROPIC_VERSION = process.env.RELAY_ANTHROPIC_VERSION
  || process.env.ANTHROPIC_VERSION
  || '2023-06-01';
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_TOTAL_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 350;
const DEFAULT_RETRY_MAX_DELAY_MS = 1800;
const _runtimeDiagnosticsStore = createAdapterRuntimeDiagnosticsStore('relay_api');
let _runtimeDiagnostics = _runtimeDiagnosticsStore.createEmptyDiagnostic();
const _openaiHandler = createProtocolHandler({ protocol: 'openai', adapterName: 'relay_api' });
const _anthropicHandler = createProtocolHandler({ protocol: 'anthropic', adapterName: 'relay_api' });
const _responsesHandler = createProtocolHandler({ protocol: 'responses', adapterName: 'relay_api' });

// ── Tool Calling 转换 (Anthropic ↔ OpenAI) ──
// convertToolsToOpenAI + convertMessagesWithTools eliminated — now handled by
// _protocolPipeline.buildRequestBody() internally.

// extractToolCallsFromResponse eliminated — now handled by
// _protocolPipeline.parseJsonResponse() internally.

let _available = null;
let _modelsCache = { at: 0, list: null };

function getRuntimeDiagnostics(options = {}) {
  return _runtimeDiagnosticsStore.get(_runtimeDiagnostics, options);
}

function getRequestId(options = {}) {
  return String(options.requestId || options.traceId || '').trim();
}

function mapRuntimeCategory(errorType = '', errorText = '') {
  const normalizedType = String(errorType || '').trim().toLowerCase();
  const normalizedText = String(errorText || '').trim().toLowerCase();
  if (normalizedType === 'timeout' || normalizedText.includes('timeout')) return 'stall';
  if (
    normalizedType === 'network'
    || normalizedType === 'process'
    || normalizedType === 'cancelled'
    || /econn|socket|network|transport|aborted|cancelled|canceled/.test(normalizedText)
  ) {
    return 'transport';
  }
  return '';
}

function recordRuntimeFailure(options = {}, payload = {}) {
  _runtimeDiagnostics = _runtimeDiagnosticsStore.record(_runtimeDiagnostics, {
    requestId: getRequestId(options),
    ...payload,
  }, {
    fallbackTrigger: 'request_failed',
  });
}

function recordRuntimeRecovery(options = {}, summary = '', diagnosis = '') {
  if (Number(_runtimeDiagnostics.at || 0) <= 0 || _runtimeDiagnostics.healed) return;
  _runtimeDiagnostics = _runtimeDiagnosticsStore.record(_runtimeDiagnostics, {
    requestId: getRequestId(options),
    healed: true,
    trigger: 'request_recovered',
    category: 'recovery',
    phase: 'response',
    summary,
    diagnosis,
    lastError: '',
  }, {
    fallbackTrigger: 'request_recovered',
  });
}


function normalizeRelayHostname(hostname) {
  const raw = String(hostname || '').trim();
  if (!raw) return '127.0.0.1';
  if (raw === 'localhost') return '127.0.0.1';
  // URL.hostname for IPv6 literals is bracketed (e.g. "[::1]"), but
  // node http/https request expects plain host without brackets.
  return raw.replace(/^\[([^\]]+)\]$/, '$1');
}

function _parsePositiveInt(raw, fallback, min = 1, max = 8) {
  const parsed = parseInt(String(raw ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
}

function _parseMs(raw, fallback, min = 0) {
  const parsed = parseInt(String(raw ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, parsed);
}


// Delegates to shared _retryWithBackoff.isTransientError (Phase 2B)
function _isTransientRelayError(err, statusCode = 0, errorText = '') {
  // Build a synthetic error object the shared classifier can inspect
  const msg = String(errorText || err?.message || '');
  const synth = { message: msg, statusCode: Number(statusCode || 0) };
  if (_sharedIsTransient(synth)) return true;
  // Relay-specific extras not in shared module
  const lower = msg.toLowerCase();
  if (/deadline exceeded|client network socket disconnected.*tls|eai_again|ehostunreach|enetunreach|broken pipe/i.test(lower)) return true;
  return false;
}

// Delegates to shared _errorClassifiers.classifyAdapterError (Phase 2B)
function _classifyRelayFailure(errorText = '', statusCode = 0) {
  return _sharedClassify(errorText, { statusCode: Number(statusCode || 0) });
}

// Delegates to shared _retryWithBackoff.sleepAbortable (Phase 2B)
const _sleepAbortable = _sharedSleep;

// ── Config helpers ──

function getConfig() {
  return {
    endpoint: process.env.RELAY_API_ENDPOINT || '',
    key: extractPrimaryApiKey(process.env.RELAY_API_KEY),
    model: process.env.RELAY_API_MODEL || DEFAULT_MODEL,
  };
}

// ── Endpoint failover (P1 IDE-channel stability) ──
// A misconfigured/dead RELAY_API_ENDPOINT (e.g. pointing at a host that 404s every
// request) used to loop the same dead endpoint until the retry budget burned out
// with no output. When the user supplies alternates via RELAY_API_ENDPOINT_FALLBACKS
// (comma-separated), we advance to the next candidate on *structural* failures
// (endpoint dead: 404 / DNS / refused / 5xx host-down) — never on auth/rate-limit/
// success, which are not the endpoint's fault and would just duplicate the request.
// The first candidate that succeeds is remembered (sticky) so later calls start from
// the known-good endpoint. With NO fallbacks configured, the candidate list collapses
// to the single primary and behavior is byte-for-byte identical to before.
const _RELAY_FAILOVER_ERROR_TYPES = new Set(['unavailable', 'network', 'server_error', 'bad_request']);
let _stickyEndpoint = null; // last endpoint (normalized) that produced a success

function _normalizeEndpoint(e) {
  return String(e || '').trim().replace(/\/+$/, '');
}

function _resolveEndpointCandidates(primary) {
  const out = [];
  const seen = new Set();
  const push = (e) => {
    const v = _normalizeEndpoint(e);
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  };
  // Sticky known-good endpoint first (fast path once we've found one).
  if (_stickyEndpoint) push(_stickyEndpoint);
  push(primary);
  for (const f of String(process.env.RELAY_API_ENDPOINT_FALLBACKS || '').split(',')) push(f);
  return out;
}

function _isEndpointStructuralFailure(errorType) {
  return _RELAY_FAILOVER_ERROR_TYPES.has(String(errorType || '').toLowerCase());
}

// Indirection seam so tests can drive the failover orchestration deterministically
// without standing up real HTTP endpoints. Production always routes through
// _generateOnce; tests overwrite _impl.generateOnce to script per-endpoint results.
const _impl = { generateOnce: (...a) => _generateOnce(...a) };

// Test-only: reset the sticky known-good endpoint between cases.
function _resetEndpointState() { _stickyEndpoint = null; }


// ── HTTP request with optional proxy support ──

function makeRequest(url, { method = 'POST', headers = {}, body, timeout = TIMEOUT_MS, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(createAbortError(signal.reason));
      return;
    }

    let settled = false;
    let connectReq = null;
    let activeReq = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      }
      fn(value);
    };
    const finishResolve = (value) => finish(resolve, value);
    const finishReject = (err) => finish(reject, err);
    const onAbort = () => {
      const abortErr = createAbortError(signal ? signal.reason : null);
      try { if (connectReq && !connectReq.destroyed) connectReq.destroy(abortErr); } catch { /* ignore */ }
      try { if (activeReq && !activeReq.destroyed) activeReq.destroy(abortErr); } catch { /* ignore */ }
      finishReject(abortErr);
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    // Resolve proxy: env vars + TLS Sidecar (shared _proxyTunnel, Phase 2B)
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY ||
                     process.env.http_proxy || process.env.HTTP_PROXY;
    let effectiveProxy = proxyUrl;
    try {
      const sidecar = require('../tlsSidecar');
      if (sidecar.shouldProxy(parsed.hostname)) effectiveProxy = sidecar.getProxyUrl();
    } catch { /* sidecar not available */ }

    let options = {
      hostname: normalizeRelayHostname(parsed.hostname),
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout,
    };

    const sendDirect = () => {
      activeReq = mod.request(options, handleResponse(finishResolve, finishReject));
      activeReq.on('error', finishReject);
      activeReq.on('timeout', () => { activeReq.destroy(); finishReject(new Error('request timeout')); });
      if (body) activeReq.write(typeof body === 'string' ? body : JSON.stringify(body));
      activeReq.end();
    };

    // Proxy tunnel via shared connectThroughProxy (Phase 2B — eliminates ~30 lines)
    if (effectiveProxy && parsed.protocol === 'https:') {
      _sharedConnectProxy(effectiveProxy, parsed.hostname, parsed.port || 443, timeout)
        .then((socket) => {
          activeReq = https.request({ ...options, socket, agent: false }, handleResponse(finishResolve, finishReject));
          activeReq.on('error', finishReject);
          activeReq.on('timeout', () => { activeReq.destroy(); finishReject(new Error('request timeout')); });
          if (body) activeReq.write(typeof body === 'string' ? body : JSON.stringify(body));
          activeReq.end();
        })
        .catch(() => { sendDirect(); }); // proxy failed, fall through to direct
      return;
    }

    sendDirect();
  });
}

function handleResponse(resolve, reject) {
  return (res) => {
    const status = res.statusCode;
    const isEventStream = res.headers['content-type']?.includes('text/event-stream');
    // 门控 KHY_RELAY_ERROR_BODY_DIAG(默认开;显式 0/false/off/no 关 → 逐字节回退旧行为:
    // 任何 event-stream 都当流 resolve、不保留 rawBody)。开门时:仅 2xx 的 event-stream 当正常流,
    // 非 2xx 一律排干响应体读出真错误码。
    const _diagOn = (() => {
      try {
        const v = String(process.env.KHY_RELAY_ERROR_BODY_DIAG ?? 'true').trim().toLowerCase();
        return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
      } catch { return true; }
    })();
    // 诊断根治:仅当**成功**(2xx)的 event-stream 才当作正常流直接返回。
    // GLM / 智谱等 SSE 端点在 4xx/5xx 时也会回 `text/event-stream`,把错误原因
    // (`{ error: { code, message } }` 或 SSE `data:` 事件)写在响应体里 —— 若照旧当流
    // resolve `{ stream }`,上层 `!res.stream` 诊断分支被跳过,错误体被 SSE 解析器读成空内容,
    // 最终打印 `HTTP 4xx ... detail:`(空),真错误码(1210/1211/1002…)永远看不到。
    // 因此:非 2xx 一律排干响应体读出原始文本,交给 4xx 诊断分支,绝不当流处理。
    if (isEventStream && (!_diagOn || (status >= 200 && status < 300))) {
      resolve({ status, stream: res, headers: res.headers });
      return;
    }
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      // 始终保留原始响应体文本(rawBody),即便 JSON.parse 失败或体为空 —— 诊断分支据此
      // 打印真实错误体,不再吞成空 detail。
      const rawBody = data;
      try { resolve({ status, data: JSON.parse(data), rawBody, headers: res.headers }); }
      catch { resolve({ status, data, rawBody, headers: res.headers }); }
    });
    res.on('error', reject);
  };
}

// ── SSE stream parser (replaced by shared _openaiSseStream, Phase 5B) ──

async function parseSSEStream(stream, onChunk, signal = null, staleOptions = null) {
  const result = await parseOpenAISseStream(stream, onChunk, {
    signal,
    enableToolCalls: true,
    enableThinking: true,
    enableStaleDetection: staleOptions !== false,
    staleOptions: staleOptions !== false ? {
      provider: (staleOptions && staleOptions.provider) || 'default',
      onStale: (elapsed) => {
        if (onChunk) {
          try { onChunk({ type: 'status', text: `Stream stale: no data for ${Math.round(elapsed / 1000)}s` }); } catch { /* ignore */ }
        }
      },
    } : null,
  });

  // Preserve original return shape: toolUseBlocks is null when empty (not [])
  const toolUseBlocks = result.toolUseBlocks.length > 0 ? result.toolUseBlocks : null;

  // Emit tool_use chunks at end (original behavior)
  if (toolUseBlocks && onChunk) {
    for (const tb of toolUseBlocks) {
      onChunk({ type: 'tool_use', id: tb.id, name: tb.name, input: tb.input });
    }
  }

  return {
    content: result.content,
    thinking: result.thinking,
    model: result.model,
    toolUseBlocks,
    finishReason: result.finishReason,
    usage: result.usage,
    interrupted: result.interrupted,
  };
}

// parseAnthropicSSEStream eliminated — now handled by
// _protocolPipeline.parseStreamResponse() (delegates to _anthropicSseStream).

// ── Adapter interface ──

function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;
  const cfg = getConfig();
  _available = !!(cfg.endpoint && cfg.key);
  if (forceRefresh) _modelsCache = { at: 0, list: null };
  return _available;
}

function parseRelayModelHints() {
  const raw = String(process.env.RELAY_API_MODELS || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(id => ({
      id,
      name: id,
      isDefault: false,
      provider: 'relay_api',
      description: '',
      discoverySource: 'hint',
    }));
}

async function listModels() {
  const cfg = getConfig();
  const endpoint = (cfg.endpoint || '').replace(/\/+$/, '');
  const key = cfg.key || '';

  const fallback = [
    {
      id: cfg.model || DEFAULT_MODEL,
      name: cfg.model || DEFAULT_MODEL,
      isDefault: true,
      provider: 'relay_api',
      description: '',
      discoverySource: 'config',
    },
    ...parseRelayModelHints(),
  ];

  if (!endpoint || !key) return fallback;

  const now = Date.now();
  if (_modelsCache.list && now - _modelsCache.at < MODELS_CACHE_TTL_MS) {
    return _modelsCache.list;
  }

  try {
    const res = await makeRequest(`${endpoint}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Accept': 'application/json',
      },
      body: null,
      timeout: 15000,
    });
    if (res.status === 200 && res.data) {
      const rows = Array.isArray(res.data.data) ? res.data.data : [];
      const models = rows
        .map(m => ({
          id: String(m.id || '').trim(),
          name: String(m.id || '').trim(),
          isDefault: String(m.id || '').trim() === (cfg.model || DEFAULT_MODEL),
          provider: 'relay_api',
          description: '',
          discoverySource: 'remote',
        }))
        .filter(m => !!m.id);

      if (models.length > 0) {
        _modelsCache = { at: now, list: models };
        return models;
      }
    }
  } catch {
    // fallback below
  }

  _modelsCache = { at: now, list: fallback };
  return fallback;
}

async function generate(prompt, options = {}) {
  const cfg = getConfig();
  const primary = options.apiEndpoint || cfg.endpoint;
  const candidates = _resolveEndpointCandidates(primary);

  // No alternates configured → single candidate → identical to legacy behavior.
  if (candidates.length <= 1) {
    const r = await _impl.generateOnce(prompt, options);
    if (r && r.success) _stickyEndpoint = candidates[0] || _stickyEndpoint;
    return r;
  }

  let last = null;
  for (let i = 0; i < candidates.length; i++) {
    const ep = candidates[i];
    const hasMore = i < candidates.length - 1;
    const r = await _impl.generateOnce(prompt, { ...options, _endpointOverride: ep });
    if (r && r.success) {
      _stickyEndpoint = ep;
      return r;
    }
    last = r;
    // Stop unless this is a structural endpoint failure with somewhere to go next.
    if (!hasMore || !_isEndpointStructuralFailure(r && r.errorType)) return r;
    if (ep === _stickyEndpoint) _stickyEndpoint = null; // drop a now-dead sticky pick
    if (typeof options.onChunk === 'function') {
      try {
        options.onChunk({
          type: 'status',
          text: `Relay API 端点不可用（${r && r.errorType || 'unavailable'}），切换到备用端点 ${i + 2}/${candidates.length} 重试`,
        });
      } catch { /* best effort */ }
    }
  }
  return last;
}

async function _generateOnce(prompt, options = {}) {
  const cfg = getConfig();
  // Support external key/endpoint override (from apiKeyPool) and failover override.
  const activeKey = options.apiKey || cfg.key;
  const activeEndpoint = options._endpointOverride || options.apiEndpoint || cfg.endpoint;

  if (!activeEndpoint || !activeKey) {
    recordRuntimeFailure(options, {
      trigger: 'not_configured',
      phase: 'preflight',
      summary: 'Relay API request blocked before start',
      diagnosis: 'relay_api adapter cannot send the request because RELAY_API_ENDPOINT or RELAY_API_KEY is missing',
      lastError: 'RELAY_API_ENDPOINT and RELAY_API_KEY not configured',
    });
    return buildFailure('RELAY_API_ENDPOINT and RELAY_API_KEY not configured', {
      adapter: 'relay_api', provider: 'Relay API',
      attempts: [{ provider: 'Relay API', success: false, error: 'not_configured' }],
    });
  }

  const model = options.model || cfg.model;
  // GLM 视觉合并预算修复:过大图片(实测单图 18287 token > 16384 上限)必然 400 code 1210。
  // 在协议分支之前统一等比降采样,让下游三个 buildRequestBody 都收到预算内的图片。
  // 仅 GLM 视觉模型 + 门控开 + 估算超预算才重编码,其它情况原样透传(fail-soft)。
  if (Array.isArray(options.images) && options.images.length > 0) {
    options = { ...options, images: downscaleGlmVisionImages(model, options.images) };
  }
  let endpoint = activeEndpoint.replace(/\/+$/, '');
  // 检测是否为 Anthropic 原生协议端点（如 DeepSeek api.deepseek.com/anthropic）
  const isAnthropicNative = endpoint.endsWith('/anthropic') || endpoint.includes('/anthropic/');
  // 检测是否为 OpenAI Responses API 端点（/v1/responses）。
  // serviceType 显式声明优先，其次 URL 后缀 /responses。
  const serviceType = String(options.serviceType || cfg.serviceType || process.env.RELAY_API_SERVICE_TYPE || '').toLowerCase();
  const isResponses = !isAnthropicNative
    && (serviceType === 'responses' || endpoint.endsWith('/responses') || endpoint.includes('/responses/'));
  // OpenAI 兼容端点：如果路径不含 /v1，自动补全（防止 https://your-relay/chat/completions 404）
  if (!isAnthropicNative && !isResponses && !endpoint.match(/\/v\d+$/)) {
    endpoint = `${endpoint}/v1`;
  }
  // Responses 端点：若用户只给了基址，自动补 /v1/responses。
  if (isResponses && !endpoint.endsWith('/responses')) {
    endpoint = endpoint.match(/\/v\d+$/) ? `${endpoint}/responses` : `${endpoint}/v1/responses`;
  }
  const url = isAnthropicNative
    ? `${endpoint}/v1/messages`
    : (isResponses ? endpoint : `${endpoint}/chat/completions`);

  // ── 跨厂商错配守卫(relayVendorMismatchGuard,门控 KHY_RELAY_VENDOR_GUARD 默认开)──
  // relay_api 用自有 RELAY_API_ENDPOINT + 透传 model,不经 `api` 通道的池解析(wildcardPoolGuard
  // 罩不到);relayModelGuard 又是端点无关的静态家族表。若端点是某已知厂商官方 host、而 model 属
  // 另一厂商 → 上游必回「模型不存在」(实测 open.bigmodel.cn + agnes-2.0-flash → 400 code 1211)。
  // 此处发请求前以清晰可执行提示短路,而不是把含糊的 1211 甩给用户。门关/异常/探测(_probe)→
  // 逐字节回退(不拦截,原样发送=今日行为)。
  if (!options._probe) {
    try {
      const vguard = require('../relayVendorMismatchGuard');
      if (vguard.isEnabled(process.env)) {
        const presets = require('../providerPresets').getProviderPresets();
        const verdict = vguard.evaluateRelayRequest({ endpoint, model, presets });
        if (verdict && verdict.mismatch) {
          const hint = vguard.buildMismatchHint({
            endpoint,
            model,
            endpointVendor: verdict.endpointVendor,
            modelVendor: verdict.modelVendor,
            presets,
          }, process.env);
          recordRuntimeFailure(options, {
            trigger: 'vendor_mismatch',
            phase: 'preflight',
            summary: 'Relay API request blocked before start (endpoint/model vendor mismatch)',
            diagnosis: hint,
            lastError: hint,
          });
          return buildFailure(hint || 'relay endpoint/model vendor mismatch', {
            adapter: 'relay_api', provider: 'Relay API',
            errorType: 'model_not_found',
            attempts: [{ provider: 'Relay API', success: false, error: 'vendor_mismatch' }],
          });
        }
      }
    } catch { /* 守卫不可用 → 原样发送(今日行为) */ }
  }

  const useStream = !!(options.onChunk);
  const signal = options.abortSignal || options.signal || null;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : TIMEOUT_MS;
  const envRetryAttempts = process.env.RELAY_API_RETRY_ATTEMPTS;
  const envRetryTotalAttempts = process.env.RELAY_API_RETRY_TOTAL_ATTEMPTS;
  const totalAttempts = (() => {
    if (options.retryTotalAttempts !== undefined) {
      return _parsePositiveInt(options.retryTotalAttempts, DEFAULT_RETRY_TOTAL_ATTEMPTS, 1, 8);
    }
    if (envRetryTotalAttempts !== undefined) {
      return _parsePositiveInt(envRetryTotalAttempts, DEFAULT_RETRY_TOTAL_ATTEMPTS, 1, 8);
    }
    if (envRetryAttempts !== undefined) {
      const retryOnly = _parsePositiveInt(envRetryAttempts, DEFAULT_RETRY_TOTAL_ATTEMPTS - 1, 0, 7);
      return Math.min(8, retryOnly + 1);
    }
    return DEFAULT_RETRY_TOTAL_ATTEMPTS;
  })();
  const retryBaseDelayMs = _parseMs(
    options.retryBaseDelayMs ?? process.env.RELAY_API_RETRY_BASE_DELAY_MS ?? String(DEFAULT_RETRY_BASE_DELAY_MS),
    DEFAULT_RETRY_BASE_DELAY_MS,
    50
  );
  const retryMaxDelayMs = _parseMs(
    options.retryMaxDelayMs ?? process.env.RELAY_API_RETRY_MAX_DELAY_MS ?? String(DEFAULT_RETRY_MAX_DELAY_MS),
    DEFAULT_RETRY_MAX_DELAY_MS,
    retryBaseDelayMs
  );

  // Build request body via protocol pipeline (messages + tools + images handled internally)
  const hasTools = Array.isArray(options.tools) && options.tools.length > 0;

  let _toolsStripped = false;
  const _strippedParams = new Set();

  let body;
  if (isAnthropicNative) {
    // ─── Anthropic 原生协议（DeepSeek /anthropic 端点）───
    // Delegate message building + image injection to protocol pipeline
    const pipelineResult = _anthropicHandler.buildRequestBody(prompt, {
      ...options,
      model,
      stream: useStream,
      max_tokens: clampMaxTokensForGlmVision(model, options.maxTokens ?? 4096),
      temperature: options.temperature,
    });
    body = pipelineResult.body;
  } else if (isResponses) {
    // ─── OpenAI Responses API（/v1/responses）───
    // Delegate to the responses handler: messages/tools/system resolved via the
    // OpenAI handler, then converted to the Responses input[]+instructions shape.
    const pipelineResult = _responsesHandler.buildRequestBody(prompt, {
      ...options,
      model,
      stream: useStream,
      max_tokens: clampMaxTokensForGlmVision(model, options.maxTokens ?? 8192),
      temperature: options.temperature,
    });
    body = pipelineResult.body;
  } else {
    // ─── OpenAI 兼容协议（SenseNova、通用中转站）───
    // Delegate message building + tool conversion to protocol pipeline
    const pipelineResult = _openaiHandler.buildRequestBody(prompt, {
      ...options,
      model,
      stream: useStream,
      max_tokens: clampMaxTokensForGlmVision(model, options.maxTokens ?? 8192),
      temperature: options.temperature ?? 0.3,
    });
    body = pipelineResult.body;

    // 小模型（flash-lite/mini/7b 等）通常不支持 function calling，发送 tools 会导致 400。
    // 该判定单一真源在 modelToolingCapability(与系统提示词教学门同源,strip⟺teach 同步)。
    // 实测为准:measured 来自 toolCapabilityStore(live probe / 被动学习),胜过名字启发。
    // _toolCapProbe:能力探测自身必须真发 tools 才能测出结果,绝不剥离。
    // 门控 KHY_MODEL_TOOLING_CAPABILITY 关 → 字节回退到下方旧内联正则。
    if (hasTools) {
      const _toolCap = require('../modelToolingCapability');
      let _isSmallModel;
      if (options._toolCapProbe) {
        _isSmallModel = false; // 探测必须保留 tools
      } else if (_toolCap.isEnabled()) {
        let _measured = null;
        try { _measured = require('../toolCapabilityStore').getVerdict(model); } catch { /* best effort */ }
        _isSmallModel = _toolCap.shouldStripUpstreamTools(model, { measured: _measured });
      } else {
        _isSmallModel = (/(mini|lite|flash|haiku|small|7b|8b|3b|1\.5b|nano|tiny)/i.test(model)
          && !/deepseek-v[3-9]/i.test(model)
          && !/sensenova-\d/i.test(model));
      }
      if (_isSmallModel) {
        _toolsStripped = true;
        delete body.tools;
        delete body.tool_choice;
        if (typeof options.onChunk === 'function') {
          try {
            options.onChunk({
              type: 'notice',
              text: `模型 ${model} 不支持工具调用 (function calling)，将以纯文本模式回答。如需使用工具，请切换到支持 function calling 的模型。`,
            });
          } catch { /* best effort */ }
        }
      }
    }
  }

  // GLM 视觉合并预算修复(真正命中路径):图片经 rawMessages/messages 内联到达时
  // (_messageBuilder 以 rawMessages 为最高保真源、options.images 为空),上面基于
  // options.images 的降采样看不到图。此处走**已构建好的 body**,就地把内联 image_url/
  // image 块降采样到预算内。仅 GLM 视觉模型 + 门控开才动;fail-soft,绝不抛。
  try {
    if (body && Array.isArray(body.messages)) {
      downscaleImageBlocksInMessages(model, body.messages, process.env);
    }
    // Responses API 用 input[] 承载消息内容。
    if (body && Array.isArray(body.input)) {
      downscaleImageBlocksInMessages(model, body.input, process.env);
    }
  } catch { /* fail-soft:降采样失败不影响原请求 */ }

  // GLM 视觉超大文本预算截断(glmVisionTextBudget;排障「为什么会出现剪贴板中转模式」):
  // 无图的大文本工具结果(如磁盘扫描 25304 token)会撞 GLM 视觉端 16384 合并预算 → 400 code 1210
  // → 级联耗尽落剪贴板兜底。图片降采样管不了纯文本,此处对已构建好的 body 做文本侧预算截断。
  // 输出保留取「实际会发送的 max_tokens」(已由 clampMaxTokensForGlmVision 钳到 ≤1024)。
  // 仅 GLM 视觉模型 + 门控开 + 估算超预算才截断;fail-soft,绝不抛。
  try {
    const outReserve = clampMaxTokensForGlmVision(model, options.maxTokens ?? 1024);
    if (body && Array.isArray(body.messages)) {
      clampTextBudgetInMessages(model, body.messages, { maxTokens: outReserve }, process.env);
    }
    if (body && Array.isArray(body.input)) {
      clampTextBudgetInMessages(model, body.input, { maxTokens: outReserve }, process.env);
    }
  } catch { /* fail-soft:文本截断失败不影响原请求 */ }

  let streamedChars = 0;
  const trackedOnChunk = (chunk) => {
    if (chunk && chunk.type === 'text' && chunk.text) {
      streamedChars += String(chunk.text).length;
    }
    if (typeof options.onChunk === 'function') {
      try { options.onChunk(chunk); } catch { /* best effort */ }
    }
  };

  for (let attemptNo = 1; attemptNo <= totalAttempts; attemptNo++) {
    const isRetryAttempt = attemptNo > 1;
    try {
      if (isRetryAttempt && typeof options.onChunk === 'function') {
        try {
          options.onChunk({
            type: 'status',
            text: `Relay API 网络重试 ${attemptNo}/${totalAttempts}（目标: ${model}）`,
          });
        } catch { /* best effort */ }
      }
      const res = await makeRequest(url, {
        method: 'POST',
        headers: isAnthropicNative
          ? {
              'Content-Type': 'application/json',
              'x-api-key': activeKey,
              'anthropic-version': ANTHROPIC_VERSION,
              'Accept': useStream ? 'text/event-stream' : 'application/json',
            }
          : {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${activeKey}`,
              'Accept': useStream ? 'text/event-stream' : 'application/json',
            },
        body,
        timeout: timeoutMs,
        signal,
      });

      if (res.status !== 200 && !res.stream) {
        // 诊断根治:GLM/智谱把真错误码藏在结构化体里(`{ error: { code, message } }` 或顶层
        // `{ code, message }`)。errMsg 从解析后的 data 里逐层取;若 data 解析为空/非对象,回退到
        // rawBody 原始文本 —— 绝不再吞成空 detail。
        const _rawBody = typeof res.rawBody === 'string' ? res.rawBody : '';
        const _upstream = res.data && typeof res.data === 'object'
          ? (res.data.error || res.data)
          : null;
        const _upstreamCode = _upstream && (_upstream.code != null ? String(_upstream.code) : '');
        const _upstreamMsg = _upstream && (_upstream.message || _upstream.msg || '');
        const errMsg = _upstreamMsg
          || res.data?.error?.message
          || res.data?.message
          || (_rawBody ? _rawBody.slice(0, 300) : `HTTP ${res.status}`);
        const errorType = _classifyRelayFailure(errMsg, res.status);
        // 记录 4xx 错误详情，帮助排查请求格式问题。
        // 连通性探测（options._probe）时静默：探测结果已通过 testAdapter 返回，
        // 避免配置错误的端点（如 RELAY_API_ENDPOINT 指向非 OpenAI 兼容主机）
        // 在每次模型探测时反复刷屏。
        if (res.status >= 400 && res.status < 500 && !options._probe) {
          // detail 优先原始体(含真错误码),其次结构化 JSON，最后回退状态码 —— 三级兜底不留空。
          let errDetail = '';
          if (_rawBody) errDetail = _rawBody.slice(0, 500);
          else if (res.data && typeof res.data === 'object') errDetail = JSON.stringify(res.data).slice(0, 500);
          else if (typeof res.data === 'string') errDetail = res.data.slice(0, 500);
          const codeTag = _upstreamCode ? ` | code=${_upstreamCode}` : '';
          console.warn(`[relay_api] HTTP ${res.status} from ${url} | model=${model}${codeTag} | detail: ${errDetail || '(empty body)'}`);
        }
        // 400 + tools present → likely tool payload rejected; strip tools and retry immediately
        if (res.status === 400 && body.tools && !_toolsStripped) {
          _toolsStripped = true;
          delete body.tools;
          delete body.tool_choice;
          if (typeof options.onChunk === 'function') {
            try {
              options.onChunk({
                type: 'notice',
                text: `模型 ${model} 拒绝了工具调用请求 (HTTP 400)，已自动去除工具定义重试`,
              });
            } catch { /* best effort */ }
          }
          continue; // retry this attempt with tools stripped
        }
        // 400 + 上游点名某可选采样参数「参数不对」→ 自适应剥离被拒参数后重试。
        // 承 tools-strip 同一先例(门 KHY_ADAPTIVE_PARAM_STRIP·关则 plan.enabled=false
        // 逐字节回退不剥离)。只剥可选采样参数白名单,绝不触碰 messages/model/max_tokens。
        if (res.status === 400) {
          const _stripPlan = _adaptiveParamStrip.planParamStrip(errMsg, body, {
            alreadyStripped: _strippedParams,
            env: process.env,
          });
          if (_stripPlan.strip.length) {
            for (const _k of _stripPlan.strip) {
              delete body[_k];
              _strippedParams.add(_k);
            }
            if (typeof options.onChunk === 'function') {
              try {
                options.onChunk({
                  type: 'notice',
                  text: `模型 ${model} 不支持参数 ${_stripPlan.strip.join(', ')} (HTTP 400)，已自动去除并重试`,
                });
              } catch { /* best effort */ }
            }
            continue; // retry this attempt with the offending param(s) stripped
          }
        }
        const canRetry = attemptNo < totalAttempts && _isTransientRelayError(null, res.status, errMsg);
        if (canRetry) {
          const delayMs = Math.min(
            retryMaxDelayMs,
            Math.round(retryBaseDelayMs * Math.pow(1.8, Math.max(0, attemptNo - 1)))
          );
          if (typeof options.onChunk === 'function') {
            try {
              options.onChunk({
                type: 'status',
                text: `Relay API 请求失败（HTTP ${res.status}），等待 ${delayMs}ms 后继续重试 ${attemptNo + 1}/${totalAttempts}`,
              });
            } catch { /* best effort */ }
          }
          try {
            await _sleepAbortable(delayMs, signal);
          } catch (sleepErr) {
            if (isAbortLikeError(sleepErr)) {
              return buildFailure(sleepErr.message, {
                adapter: 'relay_api', provider: 'Relay API',
                errorType: 'cancelled',
                attempts: [{ provider: `Relay API (${model})`, success: false, error: sleepErr.message, errorType: 'cancelled' }],
              });
            }
            throw sleepErr;
          }
          continue;
        }
        recordRuntimeFailure(options, {
          trigger: res.status ? `http_${res.status}` : 'request_failed',
          category: mapRuntimeCategory(errorType, errMsg),
          phase: 'response',
          summary: `Relay API request failed with HTTP ${res.status || 'unknown'} (${model})`,
          diagnosis: `relay_api request returned HTTP ${res.status || 'unknown'} from ${url}`,
          lastError: errMsg,
        });
        return buildFailure(errMsg, {
          adapter: 'relay_api', provider: 'Relay API',
          errorType, statusCode: res.status,
          errorDetail: typeof res.data === 'object' ? res.data : undefined,
          attempts: [{ provider: `Relay API (${model})`, success: false, error: errMsg, statusCode: res.status, errorType }],
        });
      }

      // Streaming response
      if (res.stream) {
        // 根据协议类型选择对应的 SSE 解析器
        // Stale detection on for the anthropic-native / responses paths too — these
        // previously passed NO stale options, so a silently stalled stream hung
        // until the 120s socket timeout. With a provider-aware detector + the
        // streamStallPolicy teardown (gate KHY_STREAM_STALL_ABORT default on), a
        // stalled stream is torn down at the 45–90s threshold → retry/failover.
        const _staleProvider = isAnthropicNative ? 'anthropic' : (isResponses ? 'openai' : 'default');
        const streamOpts = {
          signal,
          enableToolCalls: true,
          enableThinking: true,
          enableStaleDetection: true,
          staleOptions: {
            provider: _staleProvider,
            onStale: (elapsed) => {
              try {
                if (trackedOnChunk) trackedOnChunk({ type: 'status', text: `Stream stale: no data for ${Math.round(elapsed / 1000)}s` });
              } catch { /* ignore */ }
            },
          },
        };
        let parseResult;
        if (isAnthropicNative) {
          parseResult = await _anthropicHandler.parseStreamResponse(res.stream, trackedOnChunk, streamOpts);
        } else if (isResponses) {
          parseResult = await _responsesHandler.parseStreamResponse(res.stream, trackedOnChunk, streamOpts);
        } else {
          parseResult = await parseSSEStream(res.stream, trackedOnChunk, signal);
        }
        const { content, thinking, model: usedModel, toolUseBlocks, finishReason, usage } = parseResult;
        const displayModel = usedModel || model;
        const hasTools = !!(toolUseBlocks && toolUseBlocks.length > 0);
        // Reasoning-only turn: the model streamed reasoning_content but produced
        // no final text and no tool call (common with deepseek-v4 reasoning
        // models). Returning this as a clean end_turn yields an empty reply →
        // the user-facing "未返回有效回复". Instead surface it as length so the
        // tool-use loop's continuation/empty-reply recovery asks the model to
        // write the answer from its reasoning, rather than dead-ending.
        const reasoningOnly = !hasTools
          && !String(content || '').trim()
          && !!String(thinking || '').trim();
        const effectiveStopReason = hasTools
          ? 'tool_use'
          : (reasoningOnly
            ? 'length'
            : (finishReason === 'stop' ? 'end_turn' : (finishReason || 'end_turn')));
        recordRuntimeRecovery(
          options,
          `Relay API streaming request succeeded (${displayModel})`,
          `relay_api streaming response completed from ${url}`
        );
        return buildSuccess(content.trim(), {
          adapter: 'relay_api',
          provider: `Relay (${displayModel})`,
          model: displayModel,
          toolUseBlocks: toolUseBlocks || [],
          stopReason: effectiveStopReason,
          // Streaming usage was previously dropped — surface it (含缓存计费字段) so the
          // cache-economy probe can see streamed Anthropic/relay responses too.
          tokenUsage: usage ? {
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
            ...normalizeCacheUsage(usage),
          } : null,
          attempts: [{ provider: `Relay API (${displayModel})`, success: true }],
        });
      }

      // Non-streaming response
      const data = res.data;

      // Anthropic 原生协议：delegate to protocol pipeline
      if (isAnthropicNative) {
        const parsed = _anthropicHandler.parseJsonResponse(data);
        const usedModel = parsed.model || model;
        const textContent = parsed.content || '';
        const nativeToolUseBlocks = parsed.toolUseBlocks;
        if (textContent && typeof options.onChunk === 'function') {
          try { options.onChunk({ type: 'text', text: textContent }); } catch { /* best effort */ }
        }
        for (const tb of nativeToolUseBlocks) {
          if (typeof options.onChunk === 'function') {
            try { options.onChunk({ type: 'tool_use', id: tb.id, name: tb.name, input: tb.input }); } catch { /* best effort */ }
          }
        }
        const result = buildSuccess(textContent.trim(), {
          adapter: 'relay_api',
          provider: `Relay (${usedModel})`,
          model: usedModel,
          stopReason: parsed.stopReason || 'end_turn',
          tokenUsage: parsed.usage ? {
            inputTokens: parsed.usage.input_tokens,
            outputTokens: parsed.usage.output_tokens,
            totalTokens: (parsed.usage.input_tokens || 0) + (parsed.usage.output_tokens || 0),
            ...normalizeCacheUsage(parsed.usage),
          } : null,
          toolUseBlocks: nativeToolUseBlocks,
          attempts: [{ provider: `Relay API (${usedModel})`, success: true }],
        });
        recordRuntimeRecovery(
          options,
          `Relay API request succeeded (${usedModel})`,
          `relay_api response completed from ${url}`
        );
        return result;
      }

      // OpenAI Responses API 非流式响应 — delegate to responses handler
      if (isResponses) {
        const parsed = _responsesHandler.parseJsonResponse(data);
        const usedModel = parsed.model || model;
        const textContent = parsed.content || '';
        const respToolUseBlocks = parsed.toolUseBlocks || [];
        if (textContent && typeof options.onChunk === 'function') {
          try { options.onChunk({ type: 'text', text: textContent }); } catch { /* best effort */ }
        }
        for (const tb of respToolUseBlocks) {
          if (typeof options.onChunk === 'function') {
            try { options.onChunk({ type: 'tool_use', id: tb.id, name: tb.name, input: tb.input }); } catch { /* best effort */ }
          }
        }
        if (!textContent && respToolUseBlocks.length === 0) {
          const rawSnippet = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200);
          recordRuntimeFailure(options, {
            trigger: 'empty_response',
            phase: 'response',
            summary: `Relay API (Responses) returned an empty body (${usedModel})`,
            diagnosis: `relay_api responses output[] contained no text/function_call from ${url}`,
            lastError: `Empty response (HTTP ${res.status}, body: ${rawSnippet})`,
          });
          // errorType 'empty' (not 'unknown'): an HTTP-200 body with no model
          // text is a healthy channel that produced no content — a model-behavior
          // blip (frequent for weak models after a tool call), NOT a dead channel.
          // Classifying it 'empty' keeps it OUT of the cross-request cooldown that
          // 'unknown' carries, so the user's re-ask is never fast-failed. Empty
          // recovery is owned by the tool loop (forced-summary + salvage).
          return buildFailure(`Empty response (HTTP ${res.status}, body: ${rawSnippet})`, {
            adapter: 'relay_api', provider: 'Relay API',
            errorType: 'empty',
            attempts: [{ provider: `Relay API (${usedModel})`, success: false, error: 'empty_response', errorType: 'empty' }],
          });
        }
        const result = buildSuccess(textContent.trim(), {
          adapter: 'relay_api',
          provider: `Relay (${usedModel})`,
          model: usedModel,
          stopReason: parsed.stopReason || (respToolUseBlocks.length > 0 ? 'tool_use' : 'end_turn'),
          tokenUsage: parsed.usage ? {
            inputTokens: parsed.usage.input_tokens,
            outputTokens: parsed.usage.output_tokens,
            totalTokens: parsed.usage.total_tokens
              || ((parsed.usage.input_tokens || 0) + (parsed.usage.output_tokens || 0)),
            ...normalizeCacheUsage(parsed.usage),
          } : null,
          toolUseBlocks: respToolUseBlocks,
          attempts: [{ provider: `Relay API (${usedModel})`, success: true }],
        });
        recordRuntimeRecovery(
          options,
          `Relay API request succeeded (${usedModel})`,
          `relay_api responses response completed from ${url}`
        );
        return result;
      }

      // OpenAI 协议非流式响应 — delegate to protocol pipeline
      const parsed = _openaiHandler.parseJsonResponse(data);
      const usedModel = parsed.model || model;
      const toolUseBlocks = parsed.toolUseBlocks;
      // Pipeline content, with fallback for non-standard providers
      const content = parsed.content
        || data?.content?.[0]?.text       // some relays return Anthropic-like shape
        || data?.output?.text             // some providers use output.text
        || '';

      if (toolUseBlocks && toolUseBlocks.length > 0) {
        // 通知 onChunk
        if (content && typeof options.onChunk === 'function') {
          try { options.onChunk({ type: 'text', text: content }); } catch { /* best effort */ }
        }
        for (const tb of toolUseBlocks) {
          if (typeof options.onChunk === 'function') {
            try { options.onChunk({ type: 'tool_use', id: tb.id, name: tb.name, input: tb.input }); } catch { /* best effort */ }
          }
        }
        recordRuntimeRecovery(
          options,
          `Relay API request succeeded (${usedModel})`,
          `relay_api response completed from ${url}`
        );
        return buildSuccess(content, {
          adapter: 'relay_api',
          provider: `Relay (${usedModel})`,
          model: usedModel,
          toolUseBlocks,
          stopReason: 'tool_use',
          tokenUsage: parsed.usage ? {
            inputTokens: parsed.usage.prompt_tokens,
            outputTokens: parsed.usage.completion_tokens,
            totalTokens: parsed.usage.total_tokens,
          } : null,
          attempts: [{ provider: `Relay API (${usedModel})`, success: true }],
        });
      }

      if (!content) {
        // Build a diagnostic snippet so the user can see what the API actually returned
        const rawSnippet = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200);
        recordRuntimeFailure(options, {
          trigger: 'empty_response',
          phase: 'response',
          summary: `Relay API returned an empty body (${usedModel})`,
          diagnosis: `relay_api response body did not contain model text from ${url}`,
          lastError: `Empty response (HTTP ${res.status}, body: ${rawSnippet})`,
        });
        // errorType 'empty' (not 'unknown'): healthy channel, no model text — a
        // model-behavior blip, not a dead channel. Keeps it out of the 'unknown'
        // cross-request cooldown so the user's re-ask is never fast-failed; empty
        // recovery is owned by the tool loop (forced-summary + salvage).
        return buildFailure(`Empty response (HTTP ${res.status}, body: ${rawSnippet})`, {
          adapter: 'relay_api', provider: 'Relay API',
          errorType: 'empty',
          attempts: [{ provider: `Relay API (${usedModel})`, success: false, error: 'empty_response', errorType: 'empty' }],
        });
      }

      recordRuntimeRecovery(
        options,
        `Relay API request succeeded (${usedModel})`,
        `relay_api response completed from ${url}`
      );
      return buildSuccess(content.trim(), {
        adapter: 'relay_api',
        provider: `Relay (${usedModel})`,
        model: usedModel,
        tokenUsage: parsed.usage ? {
          inputTokens: parsed.usage.prompt_tokens,
          outputTokens: parsed.usage.completion_tokens,
          totalTokens: parsed.usage.total_tokens,
          ...normalizeCacheUsage(parsed.usage),
        } : null,
        attempts: [{ provider: `Relay API (${usedModel})`, success: true }],
      });
    } catch (err) {
      if (isAbortLikeError(err)) {
        recordRuntimeFailure(options, {
          trigger: 'request_aborted',
          category: 'transport',
          phase: 'request',
          summary: `Relay API request was aborted (${model})`,
          diagnosis: `relay_api request was aborted before completion for ${url}`,
          lastError: err.message,
        });
        return buildFailure(err.message, {
          adapter: 'relay_api', provider: 'Relay API',
          errorType: 'cancelled',
          attempts: [{ provider: `Relay API (${model})`, success: false, error: err.message, errorType: 'cancelled' }],
        });
      }
      const errMsg = String(err?.message || 'unknown error');
      const errorType = _classifyRelayFailure(errMsg, err?.status || err?.statusCode || 0);
      const canRetry = attemptNo < totalAttempts
        && _isTransientRelayError(err, err?.status || err?.statusCode || 0, errMsg)
        && !(useStream && streamedChars > 0);
      if (canRetry) {
        const delayMs = Math.min(
          retryMaxDelayMs,
          Math.round(retryBaseDelayMs * Math.pow(1.8, Math.max(0, attemptNo - 1)))
        );
        if (typeof options.onChunk === 'function') {
          try {
            options.onChunk({
              type: 'status',
              text: `Relay API 网络抖动（${errMsg.slice(0, 80)}），等待 ${delayMs}ms 后继续重试 ${attemptNo + 1}/${totalAttempts}`,
            });
          } catch { /* best effort */ }
        }
        try {
          await _sleepAbortable(delayMs, signal);
        } catch (sleepErr) {
          if (isAbortLikeError(sleepErr)) {
            return buildFailure(sleepErr.message, {
              adapter: 'relay_api', provider: 'Relay API',
              errorType: 'cancelled',
              attempts: [{ provider: `Relay API (${model})`, success: false, error: sleepErr.message, errorType: 'cancelled' }],
            });
          }
          throw sleepErr;
        }
        continue;
      }
      recordRuntimeFailure(options, {
        trigger: errorType === 'timeout' ? 'request_timeout' : 'request_exception',
        category: mapRuntimeCategory(errorType, errMsg),
        phase: 'request',
        summary: `Relay API request failed before completion (${model})`,
        diagnosis: `relay_api request raised an exception for ${url}`,
        lastError: errMsg,
      });
      return buildFailure(errMsg, {
        adapter: 'relay_api', provider: 'Relay API',
        errorType,
        attempts: [{ provider: `Relay API (${model})`, success: false, error: errMsg, errorType }],
      });
    }
  }

  recordRuntimeFailure(options, {
    trigger: 'retries_exhausted',
    category: 'transport',
    phase: 'retry',
    summary: `Relay API retries exhausted (${model})`,
    diagnosis: `relay_api request exhausted all retry attempts for ${url}`,
    lastError: 'Relay API retries exhausted',
  });
  return buildFailure('Relay API retries exhausted', {
    adapter: 'relay_api', provider: 'Relay API',
    errorType: 'network',
    attempts: [{ provider: `Relay API (${model})`, success: false, error: 'retries exhausted', errorType: 'network' }],
  });
}

function getStatus() {
  detect();
  const cfg = getConfig();
  let detail;
  if (_available) {
    const endpoint = cfg.endpoint.replace(/\/+$/, '');
    const host = (() => { try { return new URL(endpoint).hostname; } catch { return endpoint; } })();
    detail = `已配置 → ${host} (${cfg.model})`;
  } else {
    detail = '未配置 — 运行 khy gateway config 设置中转地址和密钥';
  }
  return { name: 'API 中转', type: 'relay_api', available: _available, detail };
}

function destroy() {
  _available = null;
  _modelsCache = { at: 0, list: null };
  _runtimeDiagnostics = _runtimeDiagnosticsStore.createEmptyDiagnostic();
}

module.exports = {
  detect, listModels, generate, getStatus, destroy, getRuntimeDiagnostics,
  // Test seam + pure helpers for the P1 endpoint-failover logic.
  _resolveEndpointCandidates, _isEndpointStructuralFailure, _resetEndpointState, _impl,
  // Test seam: response-body diagnostic (empty-detail root-cause fix).
  _handleResponse: handleResponse,
};
