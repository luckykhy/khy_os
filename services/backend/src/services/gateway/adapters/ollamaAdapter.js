/**
 * Ollama Adapter — connect to a local Ollama instance for LLM inference.
 *
 * Ollama runs on http://localhost:11434 by default and exposes an
 * OpenAI-compatible API at /api/generate and /api/chat.
 *
 * Detection: GET /api/tags (list available models).
 * Generation: POST /api/generate { model, prompt, stream: false }
 */
const http = require('http');
const os = require('os');
const { parseNdjsonNodeStream } = require('../../ndjsonStream');
const { createAdapterRuntimeDiagnosticsStore } = require('../runtimeDiagnosticsStore');
const { toOllamaBase64Images } = require('./_imageCompat');
const { normalizeAbortReason, createAbortError } = require('./_abortHelpers');
const { classifyAdapterError } = require('./_errorClassifiers');
const { convertMessagesAnthropicToOpenAI } = require('./_toolSchemaConverter');
const { buildSuccess, buildFailure } = require('./_responseBuilder');
const { createProtocolHandler } = require('./_protocolPipeline');

const _openaiHandler = createProtocolHandler({ protocol: 'openai', adapterName: 'ollama' });

// Register Ollama in media provider registry when detected
let _mediaRegistered = false;
function _updateMediaRegistry(available) {
  try {
    const { mediaRegistry } = require('../../mediaUnderstanding');
    mediaRegistry.setAvailability('ollama', available);
    _mediaRegistered = true;
  } catch { /* mediaUnderstanding not available */ }
}

const { OLLAMA_HOST } = require('../../../constants/serviceDefaults');
// Model-name SSOT: last-resort seed model flows from constants/models.js.
const { PRIMARY: MODELS } = require('../../../constants/models');

const DEFAULT_HOST = OLLAMA_HOST;
// Last-resort seed only. The real default is resolved at call time from the
// models actually installed on the host (see resolveDefaultModel); a baked-in
// name must never be the source of truth (zero-hardcoding rule).
const DEFAULT_MODEL = MODELS.localBrain;
const TIMEOUT_MS = 120_000;

let _available = null;
let _models = [];

// Resolve the model to use when the caller supplies none. Preference order:
// explicit OLLAMA_MODEL env override → first model discovered via /api/tags →
// the literal seed (only before any probe has populated _models). This keeps
// the gateway pointed at whatever is actually installed instead of a hardcoded
// name that may not exist locally.
function resolveDefaultModel() {
  const envModel = String(process.env.OLLAMA_MODEL || '').trim();
  if (envModel) return envModel;
  if (Array.isArray(_models) && _models.length > 0) return _models[0];
  return DEFAULT_MODEL;
}
const _modelContextWindows = new Map(); // model name → context_length from /api/tags
const _runtimeDiagnosticsStore = createAdapterRuntimeDiagnosticsStore('ollama');
let _runtimeDiagnostics = _runtimeDiagnosticsStore.createEmptyDiagnostic();

// ── Memory-aware model selection ────────────────────────────────────────
// Known model memory requirements (GiB, Q4_K_M quantization)
const MODEL_MEMORY_GIB = {
  'qwen2.5:0.5b':  0.8,  'qwen2.5:1.5b':  1.5,  'qwen2.5:3b':    2.5,
  'qwen2.5:7b':    5.4,  'qwen2.5:14b':   9.5,   'qwen2.5:32b':   20,
  'qwen3.5:4b':    3.2,
  'llama3.2:1b':   1.3,  'llama3.2:3b':    2.5,   'llama3.1:8b':   5.5,
  'llama3.1:70b':  42,
  'phi3:mini':     2.5,  'phi3.5:mini':    2.5,
  'gemma2:2b':     2.0,  'gemma2:9b':      6.5,
  'mistral:7b':    5.2,  'deepseek-coder:6.7b': 4.5,
  'codellama:7b':  5.0,  'codellama:13b':  8.5,
  'starcoder2:3b': 2.5,  'starcoder2:7b':  5.0,
};

// Fallback model preferences (smallest → larger)
const FALLBACK_MODELS = [
  'qwen2.5:0.5b', 'qwen2.5:1.5b', 'llama3.2:1b', 'phi3:mini',
  'gemma2:2b', 'qwen2.5:3b', 'qwen3.5:4b', 'llama3.2:3b',
  'starcoder2:3b', 'deepseek-coder:6.7b',
];

/**
 * Estimate model memory requirement (GiB).
 * Uses static table for known models, heuristic for unknown.
 * Heuristic: ~0.7 GiB per billion params (Q4) + 0.5 GiB overhead.
 */
function estimateModelMemoryGiB(modelId) {
  const id = String(modelId || '').toLowerCase().trim();
  if (MODEL_MEMORY_GIB[id]) return MODEL_MEMORY_GIB[id];

  // Try to extract parameter count from ":Nb" tag (e.g. qwen2:7b → 7)
  const match = id.match(/:(\d+(?:\.\d+)?)b/);
  if (match) {
    const billions = parseFloat(match[1]);
    return +(billions * 0.7 + 0.5).toFixed(1);
  }
  return 5.0; // conservative default
}

/**
 * Find a smaller model that fits in available memory.
 * Returns null if no suitable fallback found.
 */
function findMemoryFitModel(availableGiB, installedModels = []) {
  const installed = new Set(installedModels.map(m => String(m).toLowerCase().trim()));

  // First: check FALLBACK_MODELS order (preferred small models)
  for (const m of FALLBACK_MODELS) {
    if (installed.has(m) && estimateModelMemoryGiB(m) <= availableGiB) return m;
  }

  // Second: check all installed models, pick smallest that fits
  const candidates = [...installed]
    .map(m => ({ id: m, mem: estimateModelMemoryGiB(m) }))
    .filter(c => c.mem <= availableGiB)
    .sort((a, b) => a.mem - b.mem);
  return candidates.length > 0 ? candidates[0].id : null;
}


function normalizeOllamaHostname(hostname) {
  const raw = String(hostname || '').trim();
  if (!raw) return '127.0.0.1';
  if (raw === 'localhost') return '127.0.0.1';
  // URL.hostname for IPv6 literals is bracketed (e.g. "[::1]"), but
  // http.request expects plain IPv6 host without brackets.
  return raw.replace(/^\[([^\]]+)\]$/, '$1');
}

function extractOllamaErrorMessage(result, fallback = '') {
  if (!result) return String(fallback || '').trim();
  const data = result.data;
  if (data && typeof data === 'object') {
    const direct = String(data.error || data.message || '').trim();
    if (direct) return direct;
    if (data.message && typeof data.message === 'object') {
      const nested = String(data.message.error || data.message.content || '').trim();
      if (nested) return nested;
    }
  }
  if (typeof data === 'string') {
    const text = data.trim();
    if (text) return text.slice(0, 500);
  }
  return String(fallback || '').trim();
}

function getRuntimeDiagnostics(options = {}) {
  return _runtimeDiagnosticsStore.get(_runtimeDiagnostics, options);
}

function getRequestId(options = {}) {
  return String(options.requestId || options.traceId || '').trim();
}

const mapRuntimeCategory = require('../../../utils/mapRuntimeErrorCategory');

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

/**
 * Make an HTTP request to the Ollama API.
 */
function ollamaRequest(path, method = 'GET', body = null, requestOptions = {}) {
  const host = DEFAULT_HOST;
  const url = new URL(path, host);
  const timeoutMs = Number.isFinite(Number(requestOptions.timeoutMs))
    ? Math.max(1000, Number(requestOptions.timeoutMs))
    : (method === 'GET' ? 3000 : TIMEOUT_MS);
  const signal = requestOptions.signal || null;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(createAbortError(signal.reason));
      return;
    }

    const options = {
      // Force IPv4 to avoid Windows dual-stack DNS delay
      hostname: normalizeOllamaHostname(url.hostname),
      port: url.port,
      path: url.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    };

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      }
      if (hardTimer) clearTimeout(hardTimer);
      fn(value);
    };
    const onAbort = () => {
      const err = createAbortError(signal ? signal.reason : null);
      try { req.destroy(err); } catch { /* ignore */ }
      finish(reject, err);
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          finish(resolve, { status: res.statusCode, data: JSON.parse(data) });
        } catch {
          finish(resolve, { status: res.statusCode, data: data });
        }
      });
    });

    // Hard timeout AFTER req is declared to avoid referencing before initialization
    const hardTimer = setTimeout(() => {
      req.destroy();
      finish(reject, new Error('Ollama request timeout'));
    }, timeoutMs);

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('error', (err) => { finish(reject, err); });
    req.on('timeout', () => {
      req.destroy();
      finish(reject, new Error('Ollama request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Accumulate a parsed Ollama NDJSON stream (an async-iterable of per-line
 * objects) into a single assembled response. Pure & transport-agnostic so it
 * can be unit-tested with a fake iterable (no HTTP).
 *
 * Handles BOTH streaming endpoints in one pass:
 *   - /api/chat     lines: { message: { content, tool_calls?, thinking? }, done }
 *   - /api/generate lines: { response, thinking?, done }
 *
 * @param {AsyncIterable<object>} lineObjects
 * @param {object} [cb]
 * @param {function} [cb.onToken]    called with each non-empty text delta
 * @param {function} [cb.onActivity] called once per line (drives idle-timer reset)
 * @returns {Promise<{content:string, thinking:string, toolCalls:Array, last:object|null, sawMessage:boolean, sawResponse:boolean}>}
 */
async function _accumulateOllamaStream(lineObjects, cb = {}) {
  const onToken = typeof cb.onToken === 'function' ? cb.onToken : null;
  const onActivity = typeof cb.onActivity === 'function' ? cb.onActivity : null;
  let content = '';
  let thinking = '';
  let toolCalls = [];
  let last = null;
  let sawMessage = false;
  let sawResponse = false;
  for await (const obj of lineObjects) {
    if (!obj || typeof obj !== 'object') continue;
    if (onActivity) { try { onActivity(); } catch { /* best effort */ } }
    last = obj;
    const msg = obj.message;
    if (msg && typeof msg === 'object') {
      sawMessage = true;
      const delta = typeof msg.content === 'string' ? msg.content : '';
      if (delta) {
        content += delta;
        if (onToken) { try { onToken(delta); } catch { /* best effort */ } }
      }
      if (typeof msg.thinking === 'string' && msg.thinking) thinking += msg.thinking;
      // Ollama emits the full tool_calls array (usually only on the done line);
      // keep the latest non-empty set rather than concatenating partials.
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) toolCalls = msg.tool_calls;
    }
    if (typeof obj.response === 'string') {
      sawResponse = true;
      const delta = obj.response;
      if (delta) {
        content += delta;
        if (onToken) { try { onToken(delta); } catch { /* best effort */ } }
      }
    }
    if (typeof obj.thinking === 'string' && obj.thinking) thinking += obj.thinking;
    // obj.done === true marks the terminal line; keep draining to flush trailers.
  }
  return { content, thinking, toolCalls, last, sawMessage, sawResponse };
}

/**
 * Streaming counterpart of ollamaRequest for POST generation endpoints.
 *
 * Why streaming matters: the gateway idle-watchdog (aiGateway
 * createAdapterIdleTimeout) only resets when the adapter emits onChunk. A
 * non-streaming request emits nothing until the whole generation finishes, so a
 * slow local model (cold VRAM load + low tok/s) gets killed mid-generation as
 * "stale" → the user sees "AI 超时" and never gets a result. Streaming
 * token-by-token keeps the watchdog alive AND yields incremental output.
 *
 * Contract (chosen to leave generate()'s downstream parsing untouched):
 *   - non-200 → buffers the body and resolves { status, data } exactly like
 *     ollamaRequest, so the caller's 404 / 5xx → /api/generate fallback and
 *     error classification keep working unchanged.
 *   - 200 → consumes the NDJSON stream, forwards each text delta to opts.onToken,
 *     and resolves a SYNTHETIC { status:200, data } shaped like the old
 *     non-streaming response (data.message for /api/chat, data.response for
 *     /api/generate).
 *   - idle timeout is reset-on-line (gap between tokens), NOT a total cap — a
 *     steadily-progressing slow model never times out here. A genuine stall
 *     destroys the request and rejects with a timeout error so the gateway can
 *     fail over.
 *
 * @param {string} path '/api/chat' | '/api/generate'
 * @param {object} body request payload (must set stream:true)
 * @param {object} [requestOptions] { signal, idleTimeoutMs, onToken }
 */
function ollamaStreamRequest(path, body, requestOptions = {}) {
  const host = DEFAULT_HOST;
  const url = new URL(path, host);
  const idleTimeoutMs = Number.isFinite(Number(requestOptions.idleTimeoutMs))
    ? Math.max(1000, Number(requestOptions.idleTimeoutMs))
    : TIMEOUT_MS;
  const signal = requestOptions.signal || null;
  const onToken = typeof requestOptions.onToken === 'function' ? requestOptions.onToken : null;
  const isChat = /\/api\/chat$/.test(url.pathname);

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(createAbortError(signal.reason));
      return;
    }

    const options = {
      // Force IPv4 to avoid Windows dual-stack DNS delay (mirrors ollamaRequest).
      hostname: normalizeOllamaHostname(url.hostname),
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    };

    let settled = false;
    let idleTimer = null;
    let idleFired = false;
    const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
    const armIdle = () => {
      clearIdle();
      idleTimer = setTimeout(() => {
        idleFired = true;
        try { req.destroy(new Error('Ollama stream idle timeout')); } catch { /* ignore */ }
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearIdle();
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      }
      fn(value);
    };
    const onAbort = () => {
      const err = createAbortError(signal ? signal.reason : null);
      try { req.destroy(err); } catch { /* ignore */ }
      finish(reject, err);
    };

    const req = http.request(options, (res) => {
      const status = res.statusCode;
      if (status !== 200) {
        // Buffer the error body so the caller's status-based fallback path works.
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = data;
          try { parsed = JSON.parse(data); } catch { /* keep raw */ }
          finish(resolve, { status, data: parsed });
        });
        res.on('error', (err) => finish(reject, err));
        return;
      }
      // 200 → stream the NDJSON body line by line.
      armIdle();
      (async () => {
        try {
          const acc = await _accumulateOllamaStream(parseNdjsonNodeStream(res), {
            onToken,
            onActivity: armIdle,
          });
          clearIdle();
          if (idleFired) {
            finish(reject, new Error('Ollama stream idle timeout'));
            return;
          }
          const data = isChat
            ? {
              message: {
                role: 'assistant',
                content: acc.content,
                ...(acc.toolCalls && acc.toolCalls.length ? { tool_calls: acc.toolCalls } : {}),
                ...(acc.thinking ? { thinking: acc.thinking } : {}),
              },
              done: true,
            }
            : {
              response: acc.content,
              ...(acc.thinking ? { thinking: acc.thinking } : {}),
              done: true,
            };
          finish(resolve, { status: 200, data });
        } catch (err) {
          if (idleFired) finish(reject, new Error('Ollama stream idle timeout'));
          else finish(reject, err);
        }
      })();
    });

    req.on('error', (err) => {
      if (idleFired) finish(reject, new Error('Ollama stream idle timeout'));
      else finish(reject, err);
    });

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Detect if Ollama is running and has models available.
 * Returns cached result unless forceRefresh is true.
 * Because detection uses async HTTP, call detectAsync() for fresh probe.
 */
function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;
  // Synchronous path can only return cached value; trigger async probe
  detectAsync().catch(() => {});
  return _available || false;
}

/**
 * Async detection — probe Ollama /api/tags via Node http (no curl dependency).
 */
async function detectAsync() {
  try {
    const result = await ollamaRequest('/api/tags', 'GET');
    if (result.status === 200 && result.data?.models?.length > 0) {
      _models = result.data.models.map(m => m.name || m.model);
      // Cache context window from model details when available
      for (const m of result.data.models) {
        const name = m.name || m.model;
        const ctxLen = m.details?.context_length || m.context_length || 0;
        if (name && ctxLen > 0) _modelContextWindows.set(name, ctxLen);
      }
      _available = true;
      _updateMediaRegistry(true);
      return true;
    }
    _available = false;
    _updateMediaRegistry(false);
    return false;
  } catch {
    _available = false;
    _models = [];
    _updateMediaRegistry(false);
    return false;
  }
}

// Default num_predict when the caller does not supply maxTokens. The old bare
// 2048 truncated reasoning models to empty; env-tunable so local setups can
// adjust without code changes.
function _ollamaDefaultNumPredict() {
  const v = parseInt(String(process.env.KHY_OLLAMA_NUM_PREDICT || '').trim(), 10);
  return Number.isFinite(v) && v > 0 ? v : 4096;
}

// qwen3 / deepseek-r1 style reasoning: Ollama may either expose a native
// `message.thinking` field (newer builds with think mode) or leave the
// reasoning inline as <think>...</think> inside content. Split both apart so
// the answer channel stays clean and the reasoning can drive the empty-content
// recovery fallback in the CLI (ai.js: reply falls back to result.thinking
// when content is empty). Without this, a thinking-only turn surfaces as an
// "empty reply" with misleading subsystem hints.
function _splitOllamaThinking(content, nativeThinking) {
  let text = String(content || '');
  const parts = [];
  if (nativeThinking && String(nativeThinking).trim()) parts.push(String(nativeThinking).trim());
  // Complete inline blocks.
  text = text.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi, (_m, inner) => {
    if (inner && inner.trim()) parts.push(inner.trim());
    return '';
  });
  // Unclosed block (model hit num_predict mid-reasoning).
  const unclosed = text.match(/<think(?:ing)?>([\s\S]*)$/i);
  if (unclosed) {
    if (unclosed[1] && unclosed[1].trim()) parts.push(unclosed[1].trim());
    text = text.slice(0, unclosed.index);
  }
  return { content: text.trim(), thinking: parts.length ? parts.join('\n\n') : null };
}

/**
 * Build structured messages array for /api/chat from options.
 * Converts internal message format to Ollama-compatible format.
 */
function buildChatMessages(prompt, options, { hasTools = false } = {}) {
  const messages = [];
  let _flattenOL;
  try { _flattenOL = require('../../../services/contentBlockUtils').flattenContent; } catch { _flattenOL = (c) => String(c || ''); }

  // If structured messages are provided, use them
  if (options.messages && Array.isArray(options.messages) && options.messages.length > 0) {
    // When tools are active, convert Anthropic tool_use/tool_result blocks to OpenAI format
    // (Ollama /api/chat supports OpenAI-style tool_calls + role:'tool' messages)
    let rawMsgs = options.messages;
    if (hasTools) {
      const hasAnthropicBlocks = rawMsgs.some(m =>
        Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use' || b.type === 'tool_result')
      );
      if (hasAnthropicBlocks) {
        rawMsgs = convertMessagesAnthropicToOpenAI(rawMsgs, true);
      }
    }

    for (const msg of rawMsgs) {
      const role = msg.role || 'user';
      // Pass through tool messages as-is when tools are active (Ollama supports role:'tool')
      if (hasTools && role === 'tool') {
        messages.push({ role: 'tool', content: typeof msg.content === 'string' ? msg.content : _flattenOL(msg.content), tool_call_id: msg.tool_call_id });
        continue;
      }
      // Pass through assistant tool_calls when tools are active
      if (hasTools && role === 'assistant' && msg.tool_calls) {
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
        continue;
      }
      const textContent = typeof msg.content === 'string' ? msg.content : _flattenOL(msg.content);
      if (role === 'user') {
        messages.push({ role: 'user', content: textContent });
      } else if (role === 'assistant') {
        messages.push({ role: 'assistant', content: textContent });
      } else if (role === 'tool' || role === 'system') {
        // Fallback for tool messages when tools not active
        const toolText = `[Tool Execution Results]:\n${textContent}`;
        const last = messages[messages.length - 1];
        if (last && last.role === 'user' && last.content.startsWith('[Tool Execution Results]:')) {
          last.content += `\n\n${toolText}`;
        } else {
          messages.push({ role: 'user', content: toolText });
        }
      }
    }
    return messages;
  }

  // Fallback: single user message from prompt
  messages.push({ role: 'user', content: prompt });
  return messages;
}

function attachImagesToLatestUserMessage(messages = [], imageBase64List = []) {
  if (!Array.isArray(imageBase64List) || imageBase64List.length === 0) return messages;
  const next = Array.isArray(messages)
    ? messages.map((msg) => (msg && typeof msg === 'object' ? { ...msg } : msg))
    : [];

  let userIndex = -1;
  for (let i = next.length - 1; i >= 0; i--) {
    if (String(next[i]?.role || '').toLowerCase() === 'user') {
      userIndex = i;
      break;
    }
  }

  if (userIndex < 0) {
    next.push({ role: 'user', content: '', images: [...imageBase64List] });
    return next;
  }

  const target = next[userIndex] || { role: 'user', content: '' };
  const existing = Array.isArray(target.images) ? target.images.filter(Boolean) : [];
  target.images = [...existing, ...imageBase64List];
  next[userIndex] = target;
  return next;
}

function buildGeneratePromptFromMessages(prompt, options) {
  const parts = [];
  if (options.system) {
    parts.push(`[System]\n${options.system}`);
  }
  const messages = buildChatMessages(prompt, options);
  for (const msg of messages) {
    const role = String(msg.role || 'user').toLowerCase();
    const content = String(msg.content || '').trim();
    if (!content) continue;
    if (role === 'assistant') {
      parts.push(`[Assistant]\n${content}`);
    } else {
      parts.push(`[User]\n${content}`);
    }
  }
  parts.push('[Assistant]\n');
  return parts.filter(Boolean).join('\n\n');
}

/**
 * Generate a response using the Ollama /api/chat (multi-turn) API.
 */
async function generate(prompt, options = {}) {
  let model = String(options.model || resolveDefaultModel()).trim() || resolveDefaultModel();

  // Memory-aware model selection: auto-downgrade if not enough RAM
  const freeMemGiB = os.freemem() / (1024 ** 3);
  const requiredGiB = estimateModelMemoryGiB(model);
  if (requiredGiB > freeMemGiB) {
    const fallback = findMemoryFitModel(freeMemGiB, _models);
    if (fallback) {
      const msg = `内存不足: ${model} 需要 ${requiredGiB}GiB，可用 ${freeMemGiB.toFixed(1)}GiB → 自动降级到 ${fallback}`;
      if (typeof options.onChunk === 'function') options.onChunk({ type: 'status', text: msg });
      model = fallback;
    } else if (freeMemGiB < 1.0) {
      recordRuntimeFailure(options, {
        trigger: 'insufficient_memory',
        phase: 'preflight',
        summary: `Ollama request blocked by low memory (${model})`,
        diagnosis: `ollama requires ${requiredGiB}GiB but only ${freeMemGiB.toFixed(1)}GiB is available`,
        lastError: `insufficient memory for ${model}`,
      });
      return buildFailure('insufficient memory', {
        adapter: 'ollama', provider: `Ollama (${model})`, errorType: 'memory',
        attempts: [{ provider: `Ollama (${model})`, success: false, error: 'insufficient memory' }],
      });
    }
    // If freeMemGiB >= 1.0 but no installed fallback, attempt anyway (Ollama may swap)
  }
  // Sampling locks come from the zero-dependency leaf, not the upgrade runtime
  // ([DESIGN-ARCH-051] §6.8 — keeps this adapter out of the giant SCC).
  const runtime = require('../../samplingPolicy');
  const sourceText = options.userMessage || prompt || '';
  const forcedTemperature = runtime.lockTemperature(sourceText);
  const forcedTopP = runtime.lockTopP(sourceText);
  const requestSignal = options.abortSignal || options.signal || null;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : TIMEOUT_MS;
  const normalizedImages = toOllamaBase64Images(options.images || []);
  if (Array.isArray(options.images) && options.images.length > 0 && normalizedImages.length === 0) {
    recordRuntimeFailure(options, {
      trigger: 'unsupported_image',
      phase: 'preflight',
      summary: `Ollama request rejected unsupported image input (${model})`,
      diagnosis: 'ollama image payload normalization failed before the request started',
      lastError: 'image payload normalization failed',
    });
    return buildFailure('image payload normalization failed', {
      adapter: 'ollama', provider: `Ollama (${model})`, errorType: 'unsupported_image',
      attempts: [{ provider: `Ollama (${model})`, success: false, error: 'image payload normalization failed' }],
    });
  }

  try {
    if (process.env.OLLAMA_AUTO_START !== 'false') {
      const { ensureOllamaRunning } = require('../../ollamaModelManager');
      const ensure = await ensureOllamaRunning({ autoStart: true, waitMs: 4000 });
      if (!ensure.running) {
        const ensureErr = ensure.error || 'Ollama not available';
        recordRuntimeFailure(options, {
          trigger: /timeout/i.test(String(ensureErr || '')) ? 'startup_timeout' : 'service_unavailable',
          category: mapRuntimeCategory(classifyAdapterError(ensureErr), ensureErr),
          phase: 'startup',
          summary: `Ollama was unavailable before request start (${model})`,
          diagnosis: `ollama service check failed before /api/chat`,
          lastError: ensureErr,
        });
        return buildFailure(ensureErr, {
          adapter: 'ollama', provider: 'Ollama',
          attempts: [{ provider: `Ollama (${model})`, success: false, error: ensureErr }],
        });
      }
    }

    // Small models (< 7B params) often don't support OpenAI role:'tool' messages.
    // Embed tool results as plain text in role:'user' messages instead.
    const _paramB = (() => {
      const m = String(model).toLowerCase().match(/:(\d+(?:\.\d+)?)b/);
      return m ? parseFloat(m[1]) : null;
    })();
    const useToolRole = _paramB !== null ? _paramB >= 7 : true;

    // Use protocol pipeline for message + tool construction
    const { body: openaiBody } = _openaiHandler.buildRequestBody(prompt, {
      ...options,
      model,
      stream: false,
      max_tokens: options.maxTokens || _ollamaDefaultNumPredict(),
      temperature: forcedTemperature,
      useToolRole,
    });
    // Reshape OpenAI body into Ollama /api/chat format:
    // - system is a top-level field (not a message)
    // - temperature/top_p/num_predict live under options
    // - images are Ollama raw base64, not OpenAI image_url blocks
    const systemMsg = openaiBody.messages?.[0]?.role === 'system' ? openaiBody.messages[0].content : undefined;
    const chatMessages = systemMsg ? openaiBody.messages.slice(1) : openaiBody.messages;
    const chatPayload = {
      model,
      messages: attachImagesToLatestUserMessage(chatMessages, normalizedImages),
      system: systemMsg || options.system || undefined,
      // Stream token-by-token: keeps the gateway idle-watchdog alive on slow
      // local models and gives the user incremental output (see ollamaStreamRequest).
      stream: true,
      options: {
        temperature: forcedTemperature,
        top_p: forcedTopP,
        num_predict: options.maxTokens || _ollamaDefaultNumPredict(),
      },
    };
    if (openaiBody.tools) chatPayload.tools = openaiBody.tools;
    // Thinking-mode control: only forward when the caller is explicit, so
    // reasoning models keep their default behavior otherwise. Ollama accepts a
    // top-level `think` boolean on /api/chat (newer builds); older builds that
    // don't recognize the field simply ignore it. Without this, think:false
    // never reaches the model and a reasoning turn can spend its whole token
    // budget on hidden reasoning, leaving content empty.
    if (typeof options.think === 'boolean') chatPayload.think = options.think;

    // Forward each streamed delta to the gateway-provided onChunk. The gateway
    // wraps this to reset its per-adapter idle-watchdog, so a steadily-progressing
    // (but slow) local model is never killed as "stale". best-effort.
    const forwardChunk = (delta) => {
      if (typeof options.onChunk === 'function') {
        try { options.onChunk(delta); } catch { /* best effort */ }
      }
    };

    let result = await ollamaStreamRequest('/api/chat', chatPayload, {
      signal: requestSignal,
      idleTimeoutMs: timeoutMs,
      onToken: forwardChunk,
    });

    // Parse success via protocol pipeline — wrap Ollama's { message } into
    // OpenAI's { choices: [{ message }] } envelope so parseJsonResponse works.
    if (result.status === 200 && result.data && result.data.message) {
      const openaiEnvelope = { choices: [{ message: result.data.message }] };
      const parsed = _openaiHandler.parseJsonResponse(openaiEnvelope);
      // Ollama may also carry reasoning on the raw message (native think mode).
      const nativeThinking = parsed.thinking || result.data.message.thinking || null;
      const { content: cleanContent, thinking } = _splitOllamaThinking(parsed.content, nativeThinking);
      recordRuntimeRecovery(
        options,
        `Ollama chat request succeeded (${model})`,
        'ollama /api/chat returned a complete response'
      );
      return buildSuccess(cleanContent, {
        adapter: 'ollama', provider: `Ollama (${model})`, model,
        toolUseBlocks: parsed.toolUseBlocks,
        thinking,
        attempts: [{ provider: `Ollama (${model})`, success: true }],
      });
    }

    // Compatibility fallback: some Ollama builds/models fail on /api/chat but
    // can still serve /api/generate reliably.
    const shouldFallbackGenerate = [404, 405, 500, 501, 502, 503].includes(Number(result.status || 0));
    if (shouldFallbackGenerate) {
      const generatePayload = {
        model,
        prompt: buildGeneratePromptFromMessages(prompt, options),
        images: normalizedImages.length > 0 ? normalizedImages : undefined,
        stream: true,
        options: {
          temperature: forcedTemperature,
          top_p: forcedTopP,
          num_predict: options.maxTokens || _ollamaDefaultNumPredict(),
        },
      };
      if (typeof options.think === 'boolean') generatePayload.think = options.think;
      const fallback = await ollamaStreamRequest('/api/generate', generatePayload, {
        signal: requestSignal,
        idleTimeoutMs: timeoutMs,
        onToken: forwardChunk,
      });
      if (fallback.status === 200 && fallback.data && typeof fallback.data.response === 'string') {
        const { content: cleanContent, thinking } = _splitOllamaThinking(
          fallback.data.response, fallback.data.thinking || null
        );
        recordRuntimeRecovery(
          options,
          `Ollama generate fallback succeeded (${model})`,
          'ollama /api/generate recovered after /api/chat did not return a usable response'
        );
        return buildSuccess(cleanContent, {
          adapter: 'ollama', provider: `Ollama (${model})`, model,
          thinking,
          attempts: [{ provider: `Ollama (${model})`, success: true }],
        });
      }
      // keep the richer error for diagnosis
      result = fallback.status >= 400 ? fallback : result;
    }

    // Model not found — try to suggest pulling
    if (result.status === 404) {
      const message = `模型 ${model} 未找到。请运行: ollama pull ${model}`;
      recordRuntimeFailure(options, {
        trigger: 'model_not_found',
        phase: 'response',
        summary: `Ollama model missing (${model})`,
        diagnosis: `ollama returned HTTP 404 for model ${model}`,
        lastError: 'model not found',
      });
      return buildFailure('model not found', {
        adapter: 'ollama', provider: 'Ollama', errorType: 'unavailable',
        attempts: [{ provider: `Ollama (${model})`, success: false, error: 'model not found' }],
      });
    }

    const detail = extractOllamaErrorMessage(result, `HTTP ${result.status}`);
    const httpError = `HTTP ${result.status}${detail && !/^http\s+\d+/i.test(detail) ? `: ${detail}` : ''}`;
    const httpErrorType = classifyAdapterError(httpError, { statusCode: result.status });
    recordRuntimeFailure(options, {
      trigger: result.status ? `http_${result.status}` : 'request_failed',
      category: mapRuntimeCategory(httpErrorType, httpError),
      phase: 'response',
      summary: `Ollama request failed with HTTP ${result.status || 'unknown'} (${model})`,
      diagnosis: `ollama request completed with an unsuccessful HTTP status for ${model}`,
      lastError: httpError,
    });
    return buildFailure(httpError, {
      adapter: 'ollama', provider: 'Ollama', errorType: httpErrorType, statusCode: result.status,
      attempts: [{ provider: `Ollama (${model})`, success: false, error: httpError, statusCode: result.status }],
    });
  } catch (err) {
    if (requestSignal && requestSignal.aborted) {
      const errMsg = err && err.message ? err.message : String(err);
      const reason = normalizeAbortReason(requestSignal.reason);
      const normalizedAbortMessage = /\baborted\b|\bcancelled\b|\bcanceled\b/i.test(errMsg)
        ? errMsg
        : `Ollama request aborted: ${reason}`;
      recordRuntimeFailure(options, {
        trigger: 'request_aborted',
        category: 'transport',
        phase: 'request',
        summary: `Ollama request was aborted (${model})`,
        diagnosis: 'ollama request was aborted before completion',
        lastError: normalizedAbortMessage,
      });
      return buildFailure(normalizedAbortMessage, {
        adapter: 'ollama', provider: 'Ollama', errorType: 'cancelled',
        attempts: [{ provider: `Ollama (${model})`, success: false, error: normalizedAbortMessage }],
      });
    }
    if ((err && err.code === 'ECONNREFUSED') || /ECONNREFUSED/i.test(err?.message || '')) {
      const message = 'Ollama 服务未启动，已自动回退到其他 AI 通道。';
      recordRuntimeFailure(options, {
        trigger: 'connection_refused',
        category: 'transport',
        phase: 'request',
        summary: `Ollama connection refused (${model})`,
        diagnosis: 'ollama local service refused the TCP connection',
        lastError: 'ECONNREFUSED',
      });
      return buildFailure('ECONNREFUSED', {
        adapter: 'ollama', provider: 'Ollama', errorType: 'network',
        attempts: [{ provider: `Ollama (${model})`, success: false, error: 'ECONNREFUSED' }],
      });
    }
    const errMsg = err && err.message ? err.message : String(err);
    const errorType = classifyAdapterError(errMsg);
    recordRuntimeFailure(options, {
      trigger: errorType === 'timeout' ? 'request_timeout' : 'request_exception',
      category: mapRuntimeCategory(errorType, errMsg),
      phase: 'request',
      summary: `Ollama request raised an exception (${model})`,
      diagnosis: 'ollama request failed before a valid response was returned',
      lastError: errMsg,
    });
    return buildFailure(errMsg, {
      adapter: 'ollama', provider: 'Ollama', errorType,
      attempts: [{ provider: `Ollama (${model})`, success: false, error: errMsg }],
    });
  }
}

/**
 * Get adapter status.
 */
function getStatus() {
  const available = detect();
  const model = resolveDefaultModel();
  return {
    name: 'Ollama 本地模型',
    type: 'ollama',
    available,
    detail: available
      ? `${_models.length} 个模型 (当前: ${model})`
      : '未运行 — ollama serve 启动服务',
  };
}

/**
 * Get list of available models.
 */
function getModels() {
  return _models;
}

async function listModels() {
  if (!_models.length) {
    await detectAsync();
  }
  const current = resolveDefaultModel();
  const freeMemGiB = os.freemem() / (1024 ** 3);
  return (_models || []).map((id) => {
    const memEst = estimateModelMemoryGiB(id);
    let memoryFit = 'ok';
    if (memEst > freeMemGiB) memoryFit = 'insufficient';
    else if (memEst > freeMemGiB * 0.8) memoryFit = 'tight';
    return {
      id,
      name: id,
      provider: 'ollama',
      description: 'Ollama local model',
      isDefault: id === current,
      discoverySource: 'local',
      connectionMode: 'local',
      memoryEstimateGiB: memEst,
      memoryFit,
      contextWindow: _modelContextWindows.get(id) || 0,
    };
  });
}

function destroy() {
  _available = null;
  _models = [];
  _runtimeDiagnostics = _runtimeDiagnosticsStore.createEmptyDiagnostic();
}

module.exports = {
  detect, detectAsync, generate, getStatus, getModels, listModels, destroy, getRuntimeDiagnostics,
  // Exported for unit tests (streaming accumulation + request).
  _accumulateOllamaStream, ollamaStreamRequest,
};
