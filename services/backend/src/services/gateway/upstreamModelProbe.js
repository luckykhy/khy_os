/**
 * Upstream model probe — read an OpenAI/Anthropic-compatible upstream's
 * advertised model list from its own `/models` endpoint.
 *
 * Single source for "what models does this configured upstream actually
 * expose": both the admin apiAdapter (legacy `_fetchRemoteModels`) and the
 * per-user detection service delegate here so probe semantics stay identical.
 *
 * Zero-fabrication + never-throw: on any timeout, non-2xx, malformed body, or
 * network error this returns `null` (probe failed → caller degrades, leaves the
 * model unset, never invents one). A successful probe returns the raw model ids
 * the upstream reported, nothing more. Endpoints are DERIVED from baseUrl +
 * apiFormat — no hardcoded provider URLs.
 *
 * @pattern Strategy
 */
'use strict';

const { fetchWithTimeout } = require('../fetchTimeout');

/**
 * Build an undici ProxyAgent dispatcher for native fetch when a per-provider
 * proxy URL is configured. Native fetch (Node's global) has no httpsAgent knob;
 * the supported injection point is the `dispatcher` option, and undici is the
 * bundled implementation — least-intrusive, dependency-consistent path.
 *
 * Never-throw: empty/blank proxy → undefined (direct). An illegal proxy URL is
 * caught here and degrades to direct (returns undefined) with a credential-safe
 * warning (only err.code, never the URL), so the probe can never crash the
 * caller before the request.
 *
 * @param {string} [proxyUrl]
 * @param {string} [label] diagnostic label (never a credential)
 * @returns {import('undici').ProxyAgent|undefined}
 */
function buildProxyDispatcher(proxyUrl, label) {
  const raw = String(proxyUrl || '').trim();
  if (!raw) {
    return undefined;
  }
  try {
    // undici 惰性加载。它现在是本包的显式依赖（^7，与 cheerio 对齐），但仍
    // 不放模块顶层 require：那会让「压根没配代理」的绝大多数调用方也在加载期
    // 一起炸掉 —— 而本文件的契约是「探测失败即降级、绝不抛」。同一个依赖在
    // src/utils/proxyDispatcherAgent.js 里也是这个惰性写法，这里对齐它。
    const { ProxyAgent } = require('undici');
    return new ProxyAgent(raw);
  } catch (err) {
    const reason =
      err && err.code === 'MODULE_NOT_FOUND'
        ? 'undici 不可用'
        : `代理地址无效（${(err && err.code) || 'invalid'}）`;
    console.warn(`[proxy] ${label || 'model-probe'} ${reason}，模型探测回退直连`);
    return undefined;
  }
}

// '2023-06-01' is the published stable Anthropic API version; overridable so a
// relay pinned to a newer dated version can still be probed. Kept in sync with
// adapters/relayApiAdapter.js (single convention, not a magic literal).
const ANTHROPIC_VERSION =
  process.env.RELAY_ANTHROPIC_VERSION || process.env.ANTHROPIC_VERSION || '2023-06-01';

const PROBE_TIMEOUT_MS = parseInt(process.env.KHY_MODEL_PROBE_TIMEOUT_MS || '5000', 10);

/**
 * Build the `/models` URL for a given base + api format without double-/v1.
 * OpenAI-compatible: `{base}/models` (base normally already ends in /v1).
 * Anthropic: `{base}/v1/models` (anthropic has no published /models endpoint —
 * the probe is best-effort and degrades gracefully when it 404s).
 */
function buildModelsUrl(base, apiFormat) {
  const root = String(base || '')
    .trim()
    .replace(/\/+$/, '');
  if (!root) {
    return '';
  }
  if (apiFormat === 'anthropic') {
    // Avoid `/v1/v1/models` when the base already carries a version segment.
    return /\/v\d+$/.test(root) ? `${root}/models` : `${root}/v1/models`;
  }
  return `${root}/models`;
}

function buildHeaders(apiKey, apiFormat) {
  if (apiFormat === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Probe an upstream's `/models` endpoint.
 *
 * @param {object} opts
 * @param {string} [opts.baseUrl]   Upstream base (e.g. https://api.x.com/v1)
 * @param {string} [opts.endpoint]  Explicit endpoint base; takes precedence over baseUrl
 * @param {string} opts.apiKey      Bearer / x-api-key secret (server-side only, never returned)
 * @param {string} [opts.apiFormat] 'openai' | 'anthropic' (default 'openai')
 * @param {string} [opts.proxyUrl]  Optional per-provider proxy URL; injected as
 *   an undici ProxyAgent dispatcher. Blank/illegal → direct (degrades safely).
 * @returns {Promise<Array<{id:string, contextWindow:number, maxOutputTokens?:number}>|null>}
 *   Reported models, or null when the probe could not be completed.
 */
async function fetchUpstreamModels({ baseUrl, endpoint, apiKey, apiFormat, proxyUrl } = {}) {
  const base = endpoint || baseUrl;
  if (!base || !apiKey) {
    return null;
  }
  const format = String(apiFormat || 'openai')
    .trim()
    .toLowerCase();
  const url = buildModelsUrl(base, format);
  if (!url) {
    return null;
  }

  // per-provider 代理透传：配了 proxyUrl 则经代理探测（如 Agnes），否则直连。
  const dispatcher = buildProxyDispatcher(proxyUrl, url);

  try {
    // fetchWithTimeout takes a (signal)=>Promise thunk + { timeoutMs }, NOT a
    // URL. (The legacy apiAdapter call passed a URL string and `timeout:` — both
    // wrong — so it silently always failed; this is the corrected form.)
    const resp = await fetchWithTimeout(
      (signal) =>
        fetch(url, {
          method: 'GET',
          headers: buildHeaders(apiKey, format),
          signal,
          ...(dispatcher ? { dispatcher } : {}),
        }),
      { timeoutMs: PROBE_TIMEOUT_MS, operation: 'upstreamModelProbe' }
    );
    if (!resp || !resp.ok) {
      return null;
    }
    const body = await resp.json();
    // OpenAI shape: { data: [{ id, ... }] }. Anthropic (when present) also
    // returns { data: [{ id, ... }] }. Accept either; ignore anything else.
    const data = Array.isArray(body?.data) ? body.data : [];
    return data
      .filter((m) => m && m.id)
      .map((m) => {
        // API 返回的 context_window/context_length 优先；未返回则为 0（由探测层补全）。
        // 不做模型名推断——上下文窗口必须来自实际 API 响应。
        const entry = {
          id: m.id,
          contextWindow: m.context_window || m.context_length || m.max_context_length || 0,
        };
        // Output token limit — field name varies by provider; fail-soft: absent
        // → property not set at all (callers treat missing as unknown).
        const maxOut =
          m.max_output_tokens ||
          m.max_completion_tokens ||
          m.max_output_length ||
          m.output_token_limit ||
          m.max_output ||
          m.max_tokens ||
          0;
        if (maxOut > 0) {
          entry.maxOutputTokens = maxOut;
        }
        return entry;
      });
  } catch {
    return null;
  }
}

/**
 * 实际探测模型上下文窗口：发送最小请求，从响应中提取真实值。
 *
 * 与 fetchUpstreamModels（/v1/models 列表）不同，此函数通过实际 API 调用探测：
 * 1. 发送 1 token 请求（max_tokens=1）
 * 2. 从响应 headers 中提取上下文窗口（x-ratelimit-* 等）
 * 3. 从响应体中提取（部分 provider 在 usage/model 字段携带）
 * 4. 若均无 → 触发一次超限探测（发送大 max_tokens）→ 从错误消息提取
 *
 * @param {object} opts
 * @param {string} opts.endpoint  API 端点（如 https://apihub.agnes-ai.com/v1）
 * @param {string} opts.apiKey    API key
 * @param {string} opts.modelId   模型 ID（如 agnes-2.5-flash）
 * @param {string} [opts.proxyUrl] 代理 URL
 * @param {number} [opts.timeoutMs=5000] 超时
 * @returns {Promise<number>} 上下文窗口 token 数（0 = 未探测到）
 */
async function probeContextWindow({ endpoint, apiKey, modelId, proxyUrl, timeoutMs = 5000 } = {}) {
  if (!endpoint || !apiKey || !modelId) return 0;

  const chatUrl = `${endpoint.replace(/\/+$/, '')}/chat/completions`;
  const dispatcher = buildProxyDispatcher(proxyUrl, chatUrl);
  const headers = {
    ...buildHeaders(apiKey, 'openai'),
    'Content-Type': 'application/json',
  };

  // ── Step 1: 最小请求，从 headers/body 提取 ─────────────────────
  try {
    const resp = await fetchWithTimeout(
      (signal) =>
        fetch(chatUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
          }),
          signal,
          ...(dispatcher ? { dispatcher } : {}),
        }),
      { timeoutMs, operation: 'probeContextWindow' }
    );

    if (resp) {
      // 从 headers 提取（部分 provider 在响应头中返回限制信息）
      const headerChecks = [
        'x-ratelimit-limit-tokens',
        'x-ratelimit-limit-context',
        'x-context-window',
        'x-model-context-window',
      ];
      for (const h of headerChecks) {
        const val = parseInt(resp.headers?.get?.(h) || resp.headers?.[h], 10);
        if (Number.isFinite(val) && val > 0) return val;
      }

      // 从响应体提取
      if (resp.ok) {
        const body = await resp.json();
        // 部分 provider 在响应中返回模型元数据
        const bodyCtx =
          body?.context_window ||
          body?.model_info?.context_window ||
          body?.usage?.context_window ||
          0;
        if (bodyCtx > 0) return bodyCtx;
      }
    }
  } catch {
    /* fail-soft: 继续到 Step 2 */
  }

  // ── Step 2: 超限探测（发送极大 max_tokens 触发错误） ────────────
  // 从错误消息中提取真实上下文窗口（如 "maximum context length is 512000 tokens"）
  try {
    const resp = await fetchWithTimeout(
      (signal) =>
        fetch(chatUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 999999999,
          }),
          signal,
          ...(dispatcher ? { dispatcher } : {}),
        }),
      { timeoutMs, operation: 'probeContextWindow-overflow' }
    );

    if (resp && !resp.ok) {
      const body = await resp.json().catch(() => ({}));
      const errMsg = body?.error?.message || body?.message || '';
      if (errMsg) {
        const { parseContextOverflowTokens } = require('../errorClassifier');
        const parsed = parseContextOverflowTokens(errMsg);
        if (parsed && parsed.limitTokens > 0) return parsed.limitTokens;
      }
    }
  } catch {
    /* fail-soft: 探测失败返回 0 */
  }

  return 0;
}

module.exports = {
  fetchUpstreamModels,
  probeContextWindow,
  buildModelsUrl,
  buildProxyDispatcher,
  ANTHROPIC_VERSION,
};
