'use strict';

/**
 * imageGenService — text-to-image generation across pluggable backends.
 *
 * Capability "image_gen" (画图/绘图/文生图) was declared in the gateway
 * capabilityRegistry but had no implementation, so the model would recognize a
 * drawing intent yet find no callable tool and return empty text. This service
 * is that missing implementation. The tool wrapper lives in
 * tools/imageGenerate.js; the diagnostic layer (cli/ai.js) reuses
 * isAnyBackendConfigured() to tell "no backend configured" apart from a genuine
 * empty model reply.
 *
 * Three backends, selected by env (zero-hardcoding — no model/key/url baked in):
 *   - openai   : OpenAI-compatible POST /v1/images/generations
 *   - agnes    : Agnes AI (Sapiens) images API. OpenAI-shaped but with two
 *                non-standard conventions: `response_format` and the img2img
 *                `image[]` array live inside `extra_body` (top-level
 *                `response_format` returns HTTP 400). Supports text-to-image AND
 *                image-to-image / multi-image compositing in one endpoint.
 *   - domestic : a Chinese text-to-image API; OpenAI-compatible-first with a
 *                configurable RESPONSE_PATH + URL-result download for the rest
 *   - sd_webui : a local Stable Diffusion WebUI (AUTOMATIC1111) /sdapi/v1/txt2img
 *
 * State transparency: every result reports the backend, model/provider, and
 * saved paths it actually used. Cross-platform: callers handle path resolution;
 * this module only deals with HTTP + base64.
 */

const { fetchWithTimeout } = require('./fetchTimeout');

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SIZE = '1024x1024';

// Fixed "auto" quality order — the precedence resolveBackend() uses when no
// explicit backend is pinned. Also the set of valid backend ids for the UI.
const AUTO_ORDER = ['openai', 'agnes', 'domestic', 'sd_webui'];

// Convenience default for the Agnes backend: when the user supplies only an API
// key (via the one-shot provisioner) we still know the public endpoint. Always
// overridable by KHY_IMAGE_GEN_AGNES_BASE_URL — no key/model is hardcoded.
const DEFAULT_AGNES_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const DEFAULT_AGNES_MODEL = 'agnes-image-2.1-flash';      // legacy text-to-image default (gated; see agnesImageModel)
const DEFAULT_AGNES_EDIT_MODEL = 'agnes-image-2.0-flash'; // image-to-image / compositing

// agnes 文生图默认模型收敛到纯叶子 services/agnesImageModel(门控
// KHY_AGNES_UNIFIED_IMAGE_MODEL 默认开:文生图默认 = 官方唯一登记的 agnes-image-2.0-flash;
// 关 → 逐字节回退历史 agnes-image-2.1-flash)。显式 env / 参数覆盖始终优先。fail-soft。
function _defaultAgnesGenModel() {
  try {
    return require('./agnesImageModel').defaultAgnesGenModel(process.env);
  } catch {
    return DEFAULT_AGNES_MODEL;
  }
}

// 门控是否开(统一默认到官方 2.0-flash)。fail-soft:异常视作开(与默认一致)。
function _unifiedImageModelEnabled() {
  try {
    return require('./agnesImageModel').unifiedImageModelEnabled(process.env);
  } catch {
    return true;
  }
}

// 官方登记、可显式选中的 agnes 图像模型清单(2.0 默认在前、2.1 可选在后)。fail-soft。
function _knownAgnesImageModels() {
  try {
    return require('./agnesImageModel').knownAgnesImageModels();
  } catch {
    return [DEFAULT_AGNES_EDIT_MODEL, DEFAULT_AGNES_MODEL];
  }
}

// ── env helpers ─────────────────────────────────────────────────────
// Honor both GATEWAY_IMAGE_* and KHY_IMAGE_* prefixes for consistency with the
// existing GATEWAY_IMAGE_SMALL_TASK_TIMEOUT_MS || KHY_IMAGE_SMALL_TASK_TIMEOUT_MS
// convention in aiGateway.js.
function _env(name) {
  const v = process.env[`KHY_IMAGE_GEN_${name}`] ?? process.env[`GATEWAY_IMAGE_GEN_${name}`];
  const s = v == null ? '' : String(v).trim();
  return s || '';
}

function _timeoutMs() {
  const raw = parseInt(_env('TIMEOUT_MS'), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Bridge fallback: when no dedicated KHY_IMAGE_GEN_AGNES_API_KEY is set, borrow an
 * already-configured *chat* provider whose endpoint host is a known image-serving
 * host (imageGenPoolBridge whitelist). Lets a user who configured agnes only as a
 * chat provider (key in apiKeyPool, not in KHY_IMAGE_GEN_* env) still generate images.
 *
 * The pure leaf decides *which* provider (host-whitelist); the actual key + endpoint
 * come from apiKeyPool.pick() here (runtime secret stays out of the leaf). Gated by
 * KHY_IMAGE_GEN_POOL_BRIDGE (default-on). Fail-soft: any error / gate-off → null, so
 * every consumer byte-reverts to today's env-only behaviour.
 *
 * @returns {{ key: string, endpoint: string } | null}
 */
function _agnesKeyFromPool() {
  try {
    const bridge = require('./imageGenPoolBridge');
    if (!bridge.bridgeEnabled(process.env)) return null;

    const registry = require('./customProviderRegistry');
    const pool = require('./apiKeyPool');
    const providers = (registry.listProviders() || [])
      .map(p => ({ poolKey: p && p.poolKey, endpoint: p && p.endpoint }))
      .filter(p => p.poolKey);

    const picked = bridge.pickImageProviderFromPool({ providers });
    if (!picked) return null;

    const sel = pool.pick(picked.poolKey);
    if (!sel || !sel.key) return null;
    // Prefer the live endpoint from the selected key, else the registry endpoint.
    const endpoint = String(sel.endpoint || picked.endpoint || '').replace(/\/+$/, '');
    return { key: sel.key, endpoint };
  } catch {
    return null;
  }
}

/** Resolve the Agnes base URL (env override, else a bridged pool endpoint, else the public default). */
function _agnesBaseUrl() {
  const envBase = _env('AGNES_BASE_URL');
  if (envBase) return envBase.replace(/\/+$/, '');
  const bridged = _agnesKeyFromPool();
  if (bridged && bridged.endpoint) return bridged.endpoint.replace(/\/+$/, '');
  return DEFAULT_AGNES_BASE_URL.replace(/\/+$/, '');
}

/** True when the cross-key rotation gate is on (default-on). Fail-soft: on → default. */
function _keyRotateEnabled() {
  try {
    const raw = process.env.KHY_IMAGE_GEN_KEY_ROTATE;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(v);
  } catch {
    return true;
  }
}

/**
 * Enumerate the *available* (non-cooldown) pool keys usable for image gen, across
 * every chat provider whose endpoint host is whitelisted (imageGenPoolBridge). Each
 * entry carries its keyId so a rejecting key can be reported via apiKeyPool.markFailure
 * and skipped on the next attempt. Ordered deterministically (by provider, then pool
 * order). Gate-off / any error → []. Zero throw.
 *
 * @returns {Array<{ key: string, endpoint: string, keyId: string, poolKey: string }>}
 */
function _agnesPoolCandidates() {
  try {
    const bridge = require('./imageGenPoolBridge');
    if (!bridge.bridgeEnabled(process.env)) return [];

    const registry = require('./customProviderRegistry');
    const pool = require('./apiKeyPool');
    const providers = (registry.listProviders() || [])
      .map(p => ({ poolKey: p && p.poolKey, endpoint: p && p.endpoint }))
      .filter(p => p.poolKey);

    const hits = bridge.listImageProvidersFromPool({ providers });
    const out = [];
    for (const hit of hits) {
      let keys = [];
      try { keys = pool.listAvailableKeys(hit.poolKey) || []; } catch { keys = []; }
      for (const k of keys) {
        if (!k || !k.key || !k.keyId) continue;
        const endpoint = String(k.endpoint || hit.endpoint || '').replace(/\/+$/, '');
        out.push({ key: k.key, endpoint, keyId: k.keyId, poolKey: hit.poolKey });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Which backends have the minimum env to operate. */
function backendStatus() {
  return {
    openai: Boolean(_env('OPENAI_BASE_URL') && _env('OPENAI_API_KEY')),
    // Agnes ships a known public endpoint, so an API key alone is enough. When no
    // dedicated KHY_IMAGE_GEN_AGNES_API_KEY is set, fall back to a chat provider's
    // agnes key bridged from apiKeyPool (imageGenPoolBridge, gated/fail-soft).
    agnes: Boolean(_env('AGNES_API_KEY') || _agnesKeyFromPool()),
    domestic: Boolean(_env('DOMESTIC_BASE_URL') && _env('DOMESTIC_API_KEY')),
    sd_webui: Boolean(_env('SD_BASE_URL')),
  };
}

/** Backends capable of image-to-image / editing (not just text-to-image). */
function backendSupportsEdit(backend) {
  return backend === 'agnes';
}

/**
 * Enumerate the image models each *active* backend exposes, for the model
 * catalog graph (modelCatalogGraph.js). One entry per (backend, model); model
 * names are resolved from the same env the generators use, so nothing is
 * hardcoded here. Never makes a network call. `supportsEdit` marks backends
 * that also do image-to-image.
 *
 * These models live OUTSIDE custom_providers.json (their own KHY_IMAGE_GEN_*
 * namespace), so this is the ONLY way the "by-capability" view can surface them.
 * @returns {Array<{backend:string, model:string, capability:'image', supportsEdit:boolean}>}
 */
function catalogModels() {
  const status = backendStatus();
  const out = [];
  if (status.openai) {
    out.push({ backend: 'openai', model: _env('OPENAI_MODEL') || 'openai-image', capability: 'image', supportsEdit: false });
  }
  if (status.agnes) {
    // Agnes exposes two documented, selectable image models (2.0-flash unified default
    // + 2.1-flash upgraded); both do text-to-image AND image-to-image. An explicit
    // KHY_IMAGE_GEN_AGNES_MODEL override pins the catalog to that one id (historical shape).
    // Otherwise, gate-on lists BOTH known ids so 2.1 stays first-class; gate-off byte-reverts
    // to the legacy "gen-default + edit-default (if different)" pair.
    const explicit = _env('AGNES_MODEL');
    const editModel = _env('AGNES_EDIT_MODEL') || DEFAULT_AGNES_EDIT_MODEL;
    const models = [];
    if (explicit) {
      models.push(explicit);
    } else if (_unifiedImageModelEnabled()) {
      models.push(..._knownAgnesImageModels());
    } else {
      models.push(_defaultAgnesGenModel());
    }
    if (editModel && !models.includes(editModel)) models.push(editModel);
    for (const model of models) {
      out.push({ backend: 'agnes', model, capability: 'image', supportsEdit: true });
    }
  }
  if (status.domestic) {
    out.push({ backend: 'domestic', model: _env('DOMESTIC_MODEL') || 'domestic-image', capability: 'image', supportsEdit: false });
  }
  if (status.sd_webui) {
    out.push({ backend: 'sd_webui', model: 'stable-diffusion-webui', capability: 'image', supportsEdit: false });
  }
  return out;
}

/** True when at least one image backend is usable. */
function isAnyBackendConfigured() {
  const s = backendStatus();
  return s.openai || s.agnes || s.domestic || s.sd_webui;
}

/**
 * Resolve which backend to use. Precedence:
 *   1. an explicit caller override (e.g. a per-user UI selection),
 *   2. the KHY_IMAGE_GEN_BACKEND env pin,
 *   3. auto-detect by the fixed quality order openai > agnes > domestic > sd_webui.
 * An empty/falsy override or env value means "auto".
 * @param {string} [override] explicit backend id from a caller (UI selection)
 * @returns {string|null} backend id, or null if none configured
 */
function resolveBackend(override) {
  const picked = String(override || '').trim().toLowerCase();
  const status = backendStatus();
  // Honor an explicit override even if mis-set, so generate() can report a clear error.
  if (picked && picked !== 'auto') return status[picked] ? picked : picked;
  const explicit = _env('BACKEND').toLowerCase();
  if (explicit) return status[explicit] ? explicit : explicit; // honor explicit even if mis-set
  for (const id of AUTO_ORDER) {
    if (status[id]) return id;
  }
  return null;
}

/** Human-readable list of the env each backend needs (for the no-backend error). */
function backendHelpText() {
  return [
    '未检测到任何图像生成后端。请配置以下任一组环境变量后重试：',
    '  OpenAI 兼容: KHY_IMAGE_GEN_OPENAI_BASE_URL, KHY_IMAGE_GEN_OPENAI_API_KEY, KHY_IMAGE_GEN_OPENAI_MODEL',
    '  Agnes AI:   KHY_IMAGE_GEN_AGNES_API_KEY (可选 KHY_IMAGE_GEN_AGNES_BASE_URL / _MODEL / _EDIT_MODEL；支持文生图与图改图)',
    '  国内 API:   KHY_IMAGE_GEN_DOMESTIC_BASE_URL, KHY_IMAGE_GEN_DOMESTIC_API_KEY, KHY_IMAGE_GEN_DOMESTIC_MODEL',
    '              (可选 KHY_IMAGE_GEN_DOMESTIC_RESPONSE_PATH 指定响应取图路径, 如 data.0.b64_json 或 output.results.0.url)',
    '  本地 SD:    KHY_IMAGE_GEN_SD_BASE_URL (如 http://127.0.0.1:7860)',
    '可用 KHY_IMAGE_GEN_BACKEND=openai|agnes|domestic|sd_webui 显式选择后端。',
  ].join('\n');
}

// ── HTTP ────────────────────────────────────────────────────────────

/** A fetch dispatcher honoring the active HTTP proxy, if any (undici ProxyAgent). */
const _proxyDispatcher = require('../utils/proxyDispatcherAgent');

async function _postJson(url, body, headers) {
  const dispatcher = _proxyDispatcher();
  const res = await fetchWithTimeout(
    (signal) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
      ...(dispatcher ? { dispatcher } : {}),
    }),
    { timeoutMs: _timeoutMs(), url, operation: 'image-generate' },
  );
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const snippet = text ? text.slice(0, 400) : '(empty body)';
    // Attach the HTTP status (additive) so callers can branch on 401/403/429 to
    // report a pool key as failed (apiKeyPool.markFailure) and rotate to the next.
    const err = new Error(`HTTP ${res.status} ${res.statusText} — ${snippet}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/** Download a remote image URL and return base64 (for backends that return URLs). */
async function _fetchUrlToBase64(url) {
  const dispatcher = _proxyDispatcher();
  const res = await fetchWithTimeout(
    (signal) => fetch(url, { signal, ...(dispatcher ? { dispatcher } : {}) }),
    { timeoutMs: _timeoutMs(), url, operation: 'image-download' },
  );
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

/** Read a dotted path like "data.0.b64_json" out of a response object. */
function _readPath(obj, dottedPath) {
  if (!dottedPath) return undefined;
  let cur = obj;
  for (const seg of String(dottedPath).split('.')) {
    if (cur == null) return undefined;
    const key = /^\d+$/.test(seg) ? Number(seg) : seg;
    cur = cur[key];
  }
  return cur;
}

// ── backend adapters ────────────────────────────────────────────────
// Each returns { images: [{ base64 }], model } — base64 is raw (no data URL).

async function _generateOpenAiCompatible({ prompt, size, n, modelOverride }) {
  const baseUrl = _env('OPENAI_BASE_URL').replace(/\/+$/, '');
  const apiKey = _env('OPENAI_API_KEY');
  const model = modelOverride || _env('OPENAI_MODEL');
  if (!baseUrl || !apiKey) throw new Error('OpenAI 兼容后端缺少 BASE_URL 或 API_KEY');
  const url = `${baseUrl}/images/generations`;
  const body = { prompt, size, n, response_format: 'b64_json' };
  if (model) body.model = model;
  const json = await _postJson(url, body, { authorization: `Bearer ${apiKey}` });
  const data = (json && json.data) || [];
  const images = [];
  for (const item of data) {
    if (item && item.b64_json) images.push({ base64: item.b64_json });
    else if (item && item.url) images.push({ base64: await _fetchUrlToBase64(item.url) });
  }
  if (!images.length) throw new Error('OpenAI 兼容后端未返回图像数据');
  return { images, model: model || (json && json.model) || null };
}

/** True when the given HTTP status means "this credential was rejected / throttled". */
function _isKeyRejection(status) {
  return status === 401 || status === 403 || status === 429;
}

async function _generateAgnes({ prompt, size, images, modelOverride }) {
  const isEdit = Array.isArray(images) && images.length > 0;
  // text-to-image and image-to-image use different model defaults but the same
  // endpoint; both are env-overridable, and a caller override (UI selection) wins.
  const model = modelOverride || (isEdit
    ? (_env('AGNES_EDIT_MODEL') || _env('AGNES_MODEL') || DEFAULT_AGNES_EDIT_MODEL)
    : (_env('AGNES_MODEL') || _defaultAgnesGenModel()));

  // Build the request body once (identical across every key attempt). Agnes quirk:
  // `response_format` and the img2img `image[]` array MUST live in `extra_body` — a
  // top-level `response_format` returns HTTP 400. The request style is env-switchable
  // in case the upstream contract changes, but defaults to the documented shape.
  const style = (_env('AGNES_REQUEST_STYLE') || 'extra_body').toLowerCase();
  const body = { model, prompt, size };
  const extra = { response_format: 'b64_json' };
  if (isEdit) extra.image = images;
  if (style === 'top_level') {
    body.response_format = 'b64_json';
    if (isEdit) body.image = images;
  } else {
    body.extra_body = extra;
  }

  // One POST + parse against a specific key/endpoint. Bubbles up the HTTP status
  // (via err.status from _postJson) so the caller can rotate on 401/403/429.
  const attempt = async (apiKey, baseUrl) => {
    const url = `${baseUrl.replace(/\/+$/, '')}/images/generations`;
    const json = await _postJson(url, body, { authorization: `Bearer ${apiKey}` });
    const data = (json && json.data) || [];
    const out = [];
    for (const item of data) {
      if (item && item.b64_json) out.push({ base64: item.b64_json });
      else if (item && item.url) out.push({ base64: await _fetchUrlToBase64(item.url) });
    }
    if (!out.length) throw new Error('Agnes 后端未返回图像数据');
    return { images: out, model };
  };

  // 1) Explicit env key stays first-priority and NEVER rotates (byte-identical to
  //    today's behaviour). A dedicated image-gen key is the operator's own choice.
  const envKey = _env('AGNES_API_KEY');
  if (envKey) {
    return attempt(envKey, _agnesBaseUrl());
  }

  // 2) No env key — borrow a chat provider's agnes credential from apiKeyPool.
  //    When rotation is on, walk every available (non-cooldown) whitelisted key:
  //    on a key rejection (401/403/429) mark it failed (cooldown) and try the next;
  //    on success mark it healthy. When all are exhausted, throw NO_USABLE_KEY so the
  //    tool layer can offer to configure a fresh key.
  if (_keyRotateEnabled()) {
    const pool = (() => { try { return require('./apiKeyPool'); } catch { return null; } })();
    const candidates = _agnesPoolCandidates();
    if (pool && candidates.length) {
      let lastErr = null;
      for (const cand of candidates) {
        try {
          const result = await attempt(cand.key, cand.endpoint || _agnesBaseUrl());
          try { pool.markSuccess(cand.keyId); } catch { /* fail-soft */ }
          return result;
        } catch (e) {
          lastErr = e;
          const status = e && typeof e.status === 'number' ? e.status : null;
          if (status && _isKeyRejection(status)) {
            try { pool.markFailure(cand.keyId, status, e.message); } catch { /* fail-soft */ }
            continue; // rejected/throttled → try the next key
          }
          // Non-credential error (timeout, 400, network) → don't burn other keys on it.
          throw e;
        }
      }
      // Every whitelisted key was rejected/cooled down.
      const exhausted = new Error(
        `Agnes 图像生成没能完成:已配置的图像生成 key 都不可用${lastErr ? ` — ${lastErr.message}` : ''}`,
      );
      exhausted.code = 'NO_USABLE_KEY';
      if (lastErr && typeof lastErr.status === 'number') exhausted.status = lastErr.status;
      exhausted.cause = lastErr || undefined;
      throw exhausted;
    }
  }

  // 3) Rotation off (or no pool candidates) — byte-revert to "pick once, throw on
  //    empty". Preserves today's behaviour when the gate is closed.
  const apiKey = (_agnesKeyFromPool() || {}).key || '';
  if (!apiKey) throw new Error('Agnes 后端缺少 AGNES_API_KEY');
  return attempt(apiKey, _agnesBaseUrl());
}

async function _generateDomestic({ prompt, negativePrompt, size, n, seed, modelOverride }) {
  const baseUrl = _env('DOMESTIC_BASE_URL').replace(/\/+$/, '');
  const apiKey = _env('DOMESTIC_API_KEY');
  const model = modelOverride || _env('DOMESTIC_MODEL');
  const responsePath = _env('DOMESTIC_RESPONSE_PATH'); // e.g. data.0.b64_json or output.results.0.url
  const authHeader = _env('DOMESTIC_AUTH_HEADER') || 'authorization';
  const authPrefix = _env('DOMESTIC_AUTH_PREFIX') || 'Bearer ';
  if (!baseUrl || !apiKey) throw new Error('国内后端缺少 BASE_URL 或 API_KEY');
  // OpenAI-compatible-first request shape; many domestic gateways accept it.
  const url = baseUrl.endsWith('/images/generations') ? baseUrl : `${baseUrl}/images/generations`;
  const body = { prompt, size, n, response_format: 'b64_json' };
  if (model) body.model = model;
  if (negativePrompt) body.negative_prompt = negativePrompt;
  if (Number.isFinite(seed)) body.seed = seed;
  const json = await _postJson(url, body, { [authHeader]: `${authPrefix}${apiKey}` });

  const images = [];
  if (responsePath) {
    // Single explicit path → may be a string (b64 or url) or an array of either.
    const picked = _readPath(json, responsePath);
    const items = Array.isArray(picked) ? picked : [picked];
    for (const it of items) {
      if (!it) continue;
      const s = typeof it === 'string' ? it : (it.b64_json || it.url || '');
      if (!s) continue;
      if (/^https?:\/\//i.test(s)) images.push({ base64: await _fetchUrlToBase64(s) });
      else images.push({ base64: s });
    }
  } else {
    // Default to OpenAI-compatible data[] shape.
    for (const item of (json && json.data) || []) {
      if (item && item.b64_json) images.push({ base64: item.b64_json });
      else if (item && item.url) images.push({ base64: await _fetchUrlToBase64(item.url) });
    }
  }
  if (!images.length) {
    throw new Error('国内后端未返回可解析的图像数据（可设置 KHY_IMAGE_GEN_DOMESTIC_RESPONSE_PATH 指定取图路径）');
  }
  return { images, model: model || null };
}

async function _generateSdWebui({ prompt, negativePrompt, size, n, seed, modelOverride }) {
  const baseUrl = _env('SD_BASE_URL').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('本地 SD WebUI 缺少 SD_BASE_URL');
  const [w, h] = String(size || DEFAULT_SIZE).split('x').map((x) => parseInt(x, 10));
  const steps = parseInt(_env('SD_STEPS'), 10);
  const sampler = _env('SD_SAMPLER');
  const body = {
    prompt,
    negative_prompt: negativePrompt || '',
    width: Number.isFinite(w) ? w : 1024,
    height: Number.isFinite(h) ? h : 1024,
    batch_size: n || 1,
    steps: Number.isFinite(steps) ? steps : 20,
  };
  if (sampler) body.sampler_name = sampler;
  if (Number.isFinite(seed)) body.seed = seed;
  const json = await _postJson(`${baseUrl}/sdapi/v1/txt2img`, body, {});
  const images = ((json && json.images) || []).map((b64) => ({ base64: b64 }));
  if (!images.length) throw new Error('本地 SD WebUI 未返回图像数据');
  return { images, model: modelOverride || 'stable-diffusion-webui' };
}

/**
 * Generate images. Returns { backend, model, images:[{base64}], size, n }.
 * Throws on no-backend / backend error (caller maps to a tool result).
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.negativePrompt]
 * @param {string} [opts.size]
 * @param {number} [opts.n]
 * @param {number} [opts.seed]
 * @param {string[]} [opts.images] input image refs (public URLs or data: URIs)
 *                                 for image-to-image / multi-image compositing.
 *                                 Only honored by edit-capable backends (agnes).
 * @param {string} [opts.backend] explicit backend override (UI selection); ''/'auto' = auto.
 * @param {string} [opts.model]   explicit model override (UI selection) for that backend.
 */
async function generate({ prompt, negativePrompt, size, n, seed, images, backend, model } = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error('prompt 不能为空');
  const resolvedBackend = resolveBackend(backend);
  if (!resolvedBackend) {
    const e = new Error(backendHelpText());
    e.code = 'NO_BACKEND';
    throw e;
  }
  const inputImages = Array.isArray(images) ? images.filter(Boolean).map(String) : [];
  if (inputImages.length && !backendSupportsEdit(resolvedBackend)) {
    const e = new Error(
      `当前图像后端 "${resolvedBackend}" 不支持图改图（img2img）。请配置 Agnes 后端：`
      + 'KHY_IMAGE_GEN_AGNES_API_KEY（并设 KHY_IMAGE_GEN_BACKEND=agnes）。',
    );
    e.code = 'EDIT_UNSUPPORTED';
    throw e;
  }
  const modelOverride = model ? String(model).trim() : '';
  const args = {
    prompt: String(prompt),
    negativePrompt: negativePrompt ? String(negativePrompt) : '',
    size: size || DEFAULT_SIZE,
    n: Math.max(1, Math.min(4, parseInt(n, 10) || 1)),
    seed: Number.isFinite(seed) ? seed : undefined,
    images: inputImages,
    modelOverride: modelOverride || undefined,
  };
  let out;
  if (resolvedBackend === 'openai') out = await _generateOpenAiCompatible(args);
  else if (resolvedBackend === 'agnes') out = await _generateAgnes(args);
  else if (resolvedBackend === 'domestic') out = await _generateDomestic(args);
  else if (resolvedBackend === 'sd_webui') out = await _generateSdWebui(args);
  else throw new Error(`未知的图像后端: ${resolvedBackend}`);
  return {
    backend: resolvedBackend,
    model: out.model || null,
    images: out.images,
    size: args.size,
    n: args.n,
    edited: inputImages.length > 0,
  };
}

module.exports = {
  generate,
  resolveBackend,
  backendStatus,
  backendSupportsEdit,
  catalogModels,
  isAnyBackendConfigured,
  backendHelpText,
  AUTO_ORDER,
  // internals exposed for unit tests (no network)
  __testHooks: { _readPath, _env, _timeoutMs, _agnesBaseUrl },
};
