'use strict';

/**
 * videoGenService — asynchronous text/image-to-video generation.
 *
 * KHY had no video-generation capability. This service is the first backend:
 * Agnes-Video (Sapiens), an async task API:
 *   1. POST {base}/v1/videos                  → { video_id, task_id, status, ... }
 *   2. GET  {base}/agnesapi?video_id=<id>     → poll until status=completed|failed
 *      (legacy GET {base}/v1/videos/{task_id} is also supported)
 *   3. final MP4 URL is in `remixed_from_video_id` when status=completed
 *
 * Design mirrors imageGenService: env-driven (zero-hardcoding, no key/url/model
 * baked in), proxy-aware HTTP, and full state transparency (every result reports
 * the backend, model, ids, status, size and seconds it actually used).
 *
 * Modes (per Agnes docs):
 *   - text-to-video : prompt only
 *   - image-to-video: single `image` (top-level)
 *   - multi-image   : `extra_body.image[]`
 *   - keyframes     : `extra_body.image[]` + `extra_body.mode="keyframes"`
 *
 * Frame constraints: num_frames <= 441 and num_frames ≡ 1 (mod 8); frame_rate 1-60.
 * Duration ≈ num_frames / frame_rate.
 */

const fs = require('fs');
const { fetchWithTimeout } = require('./fetchTimeout');

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;   // Agnes docs recommend 5s polling
const DEFAULT_MAX_WAIT_MS = 10 * 60_000;  // give up after 10 minutes
const DEFAULT_AGNES_BASE_URL = 'https://apihub.agnes-ai.com'; // host root: /v1/videos + /agnesapi
const DEFAULT_AGNES_MODEL = 'agnes-video-v2.0';
const DEFAULT_NUM_FRAMES = 121;
const DEFAULT_FRAME_RATE = 24;
const MAX_NUM_FRAMES = 441;

// ── env helpers (KHY_VIDEO_GEN_* preferred, GATEWAY_VIDEO_GEN_* fallback) ──────
function _env(name) {
  const v = process.env[`KHY_VIDEO_GEN_${name}`] ?? process.env[`GATEWAY_VIDEO_GEN_${name}`];
  const s = v == null ? '' : String(v).trim();
  return s || '';
}

function _intEnv(name, fallback) {
  const raw = parseInt(_env(name), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function _timeoutMs() { return _intEnv('TIMEOUT_MS', DEFAULT_TIMEOUT_MS); }
function _pollIntervalMs() { return _intEnv('POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS); }
function _maxWaitMs() { return _intEnv('MAX_WAIT_MS', DEFAULT_MAX_WAIT_MS); }

/** Resolve the Agnes base URL (env override, else a bridged pool endpoint, else the public default). */
function _agnesBaseUrl() {
  const envBase = _env('AGNES_BASE_URL');
  if (envBase) return envBase.replace(/\/+$/, '');
  const bridged = _agnesKeyFromPool();
  if (bridged && bridged.endpoint) return bridged.endpoint.replace(/\/+$/, '');
  return DEFAULT_AGNES_BASE_URL;
}

/**
 * Bridge fallback: when no dedicated KHY_VIDEO_GEN_AGNES_API_KEY is set, borrow an
 * already-configured *chat* provider whose endpoint host is a known video-serving
 * host (videoGenPoolBridge whitelist). Lets a user who configured agnes only as a
 * chat provider (key in apiKeyPool, not in KHY_VIDEO_GEN_* env) still generate videos.
 *
 * The pure leaf decides *which* provider (host-whitelist); the actual key + endpoint
 * come from apiKeyPool.pick() here (runtime secret stays out of the leaf). Gated by
 * KHY_VIDEO_GEN_POOL_BRIDGE (default-on). Fail-soft: any error / gate-off → null, so
 * every consumer byte-reverts to today's env-only behaviour.
 *
 * @returns {{ key: string, endpoint: string } | null}
 */
function _agnesKeyFromPool() {
  try {
    const bridge = require('./videoGenPoolBridge');
    if (!bridge.bridgeEnabled(process.env)) return null;

    const registry = require('./customProviderRegistry');
    const pool = require('./apiKeyPool');
    const providers = (registry.listProviders() || [])
      .map(p => ({ poolKey: p && p.poolKey, endpoint: p && p.endpoint }))
      .filter(p => p.poolKey);

    const picked = bridge.pickVideoProviderFromPool({ providers });
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

/** Resolve the effective Agnes API key: dedicated env key first, else a bridged pool key. */
function _agnesApiKey() {
  const envKey = _env('AGNES_API_KEY');
  if (envKey) return envKey;
  const bridged = _agnesKeyFromPool();
  return (bridged && bridged.key) || '';
}

/** Which backends have the minimum env to operate. */
function backendStatus() {
  return {
    // Agnes ships a known public endpoint, so an API key alone is enough. When no
    // dedicated KHY_VIDEO_GEN_AGNES_API_KEY is set, fall back to a chat provider's
    // agnes key bridged from apiKeyPool (videoGenPoolBridge, gated/fail-soft).
    agnes: Boolean(_env('AGNES_API_KEY') || _agnesKeyFromPool()),
  };
}

/** True when at least one video backend is usable. */
function isAnyBackendConfigured() {
  return backendStatus().agnes;
}

/**
 * Enumerate the video models each *active* backend exposes, for the model
 * catalog graph (modelCatalogGraph.js). Model names resolve from the same env
 * the generator uses — nothing hardcoded. Never makes a network call. These
 * models live OUTSIDE custom_providers.json (their own KHY_VIDEO_GEN_*
 * namespace), so this is the ONLY way the "by-capability" view surfaces them.
 * @returns {Array<{backend:string, model:string, capability:'video'}>}
 */
function catalogModels() {
  const status = backendStatus();
  const out = [];
  if (status.agnes) {
    out.push({ backend: 'agnes', model: _env('AGNES_MODEL') || DEFAULT_AGNES_MODEL, capability: 'video' });
  }
  return out;
}

/** Resolve which backend to use. Explicit KHY_VIDEO_GEN_BACKEND wins. */
function resolveBackend() {
  const explicit = _env('BACKEND').toLowerCase();
  const status = backendStatus();
  if (explicit) return status[explicit] ? explicit : explicit;
  if (status.agnes) return 'agnes';
  return null;
}

function backendHelpText() {
  return [
    '未检测到任何视频生成后端。请配置以下环境变量后重试：',
    '  Agnes AI: KHY_VIDEO_GEN_AGNES_API_KEY',
    '            (可选 KHY_VIDEO_GEN_AGNES_BASE_URL / _MODEL；支持文生视频、图生视频、多图、关键帧)',
    '  提示：若已把 Agnes 配置为聊天 provider，视频会自动复用同一把 key（无需重复配置）。',
    '可选 KHY_VIDEO_GEN_POLL_INTERVAL_MS / _MAX_WAIT_MS 控制轮询节奏与超时。',
  ].join('\n');
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const _proxyDispatcher = require('../utils/proxyDispatcherAgent');

async function _request(method, url, { headers, body } = {}) {
  const dispatcher = _proxyDispatcher();
  const res = await fetchWithTimeout(
    (signal) => fetch(url, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
      ...(dispatcher ? { dispatcher } : {}),
    }),
    { timeoutMs: _timeoutMs(), url, operation: 'video-generate' },
  );
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const snippet = text ? text.slice(0, 400) : '(empty body)';
    const e = new Error(`HTTP ${res.status} ${res.statusText} — ${snippet}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

function _sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });
}

// ── param validation ───────────────────────────────────────────────────────────
/**
 * Validate / normalize frame params. Throws (code BAD_PARAM) on violation.
 * @returns {{numFrames:number, frameRate:number, seconds:number}}
 */
function validateFrameParams({ numFrames, frameRate } = {}) {
  const nf = Number.isFinite(numFrames) ? Math.trunc(numFrames) : DEFAULT_NUM_FRAMES;
  const fr = Number.isFinite(frameRate) ? Math.trunc(frameRate) : DEFAULT_FRAME_RATE;
  if (nf > MAX_NUM_FRAMES) {
    const e = new Error(`num_frames 不能超过 ${MAX_NUM_FRAMES}（收到 ${nf}）`);
    e.code = 'BAD_PARAM';
    throw e;
  }
  if (nf < 1 || (nf - 1) % 8 !== 0) {
    const e = new Error(`num_frames 必须满足 8n+1（如 81/121/161/241/441），收到 ${nf}`);
    e.code = 'BAD_PARAM';
    throw e;
  }
  if (fr < 1 || fr > 60) {
    const e = new Error(`frame_rate 必须在 1–60 之间，收到 ${fr}`);
    e.code = 'BAD_PARAM';
    throw e;
  }
  return { numFrames: nf, frameRate: fr, seconds: nf / fr };
}

// ── Agnes backend ────────────────────────────────────────────────────────────────
function _buildAgnesBody(model, opts) {
  const { prompt, image, images, mode, width, height, numFrames, frameRate, numInferenceSteps, seed, negativePrompt } = opts;
  const body = { model, prompt, num_frames: numFrames, frame_rate: frameRate };
  if (Number.isFinite(width)) body.width = Math.trunc(width);
  if (Number.isFinite(height)) body.height = Math.trunc(height);
  if (Number.isFinite(numInferenceSteps)) body.num_inference_steps = Math.trunc(numInferenceSteps);
  if (Number.isFinite(seed)) body.seed = Math.trunc(seed);
  if (negativePrompt) body.negative_prompt = String(negativePrompt);

  const list = Array.isArray(images) ? images.filter(Boolean).map(String) : [];
  if (list.length > 1 || mode === 'keyframes') {
    // multi-image / keyframes → extra_body
    body.extra_body = { image: list };
    if (mode === 'keyframes') body.extra_body.mode = 'keyframes';
  } else if (list.length === 1) {
    body.image = list[0];
  } else if (image) {
    body.image = String(image); // single image-to-video
  }
  if (mode && mode !== 'keyframes') body.mode = mode; // e.g. ti2vid (top-level)
  return body;
}

/** Extract the completed video URL from a poll result. */
function _extractVideoUrl(result) {
  if (!result) return null;
  // Docs: final URL is in `remixed_from_video_id` when completed. Tolerate the
  // more intuitive aliases too, in case the upstream contract evolves.
  return result.remixed_from_video_id
    || result.video_url
    || (result.video && result.video.url)
    || null;
}

async function _createAgnes(model, opts) {
  const baseUrl = _agnesBaseUrl();
  const apiKey = _agnesApiKey();
  if (!apiKey) throw new Error('Agnes 视频后端缺少 AGNES_API_KEY');
  const body = _buildAgnesBody(model, opts);
  const json = await _request('POST', `${baseUrl}/v1/videos`, {
    headers: { authorization: `Bearer ${apiKey}` },
    body,
  });
  const videoId = json && (json.video_id || null);
  const taskId = json && (json.task_id || json.id || null);
  if (!videoId && !taskId) throw new Error('Agnes 创建视频任务未返回 video_id/task_id');
  return { videoId, taskId, raw: json };
}

async function _pollAgnes({ videoId, taskId }) {
  const baseUrl = _agnesBaseUrl();
  const apiKey = _agnesApiKey();
  const model = _env('AGNES_MODEL') || DEFAULT_AGNES_MODEL;
  const style = (_env('AGNES_POLL_STYLE') || (videoId ? 'video_id' : 'task_id')).toLowerCase();
  let url;
  if (style === 'task_id' && taskId) {
    url = `${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`;
  } else {
    url = `${baseUrl}/agnesapi?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(model)}`;
  }
  return _request('GET', url, { headers: { authorization: `Bearer ${apiKey}` } });
}

/**
 * Generate a video. Creates the task then polls until terminal state.
 *
 * @param {object} opts
 * @param {string}  opts.prompt              required
 * @param {string}  [opts.image]             single image URL (image-to-video)
 * @param {string[]}[opts.images]            multiple image URLs (multi-image / keyframes)
 * @param {string}  [opts.mode]              'keyframes' | 'ti2vid' | ...
 * @param {number}  [opts.width] [opts.height]
 * @param {number}  [opts.numFrames]         <=441 and ≡1 (mod 8); default 121
 * @param {number}  [opts.frameRate]         1-60; default 24
 * @param {number}  [opts.numInferenceSteps] [opts.seed]
 * @param {string}  [opts.negativePrompt]
 * @param {function}[opts.onProgress]        called with ({status, progress})
 * @returns {Promise<{backend,model,videoId,taskId,status,videoUrl,seconds,size,progress,raw}>}
 */
async function generate(opts = {}) {
  const prompt = opts.prompt ? String(opts.prompt) : '';
  if (!prompt.trim()) throw new Error('prompt 不能为空');
  const backend = resolveBackend();
  if (!backend) {
    const e = new Error(backendHelpText());
    e.code = 'NO_BACKEND';
    throw e;
  }
  if (backend !== 'agnes') throw new Error(`未知的视频后端: ${backend}`);

  const { numFrames, frameRate } = validateFrameParams({ numFrames: opts.numFrames, frameRate: opts.frameRate });
  const model = _env('AGNES_MODEL') || DEFAULT_AGNES_MODEL;

  const created = await _createAgnes(model, { ...opts, numFrames, frameRate });
  const ids = { videoId: created.videoId, taskId: created.taskId };

  const interval = _pollIntervalMs();
  const deadline = Date.now() + _maxWaitMs();
  let last = created.raw || {};
  let status = String(last.status || 'queued').toLowerCase();
  if (typeof opts.onProgress === 'function') {
    try { opts.onProgress({ status, progress: last.progress || 0 }); } catch { /* non-essential */ }
  }

  while (status !== 'completed' && status !== 'failed') {
    if (Date.now() >= deadline) {
      const e = new Error(`视频生成超时（>${Math.round(_maxWaitMs() / 1000)}s），任务仍为 ${status}`);
      e.code = 'TIMEOUT';
      e.partial = { ...ids, status };
      throw e;
    }
    await _sleep(interval);
    last = await _pollAgnes(ids) || {};
    status = String(last.status || status).toLowerCase();
    if (typeof opts.onProgress === 'function') {
      try { opts.onProgress({ status, progress: last.progress || 0 }); } catch { /* non-essential */ }
    }
  }

  if (status === 'failed') {
    const reason = last.error ? (typeof last.error === 'string' ? last.error : JSON.stringify(last.error)) : '未知原因';
    const e = new Error(`视频生成失败：${reason}`);
    e.code = 'GENERATION_FAILED';
    e.partial = { ...ids, status };
    throw e;
  }

  const videoUrl = _extractVideoUrl(last);
  if (!videoUrl) throw new Error('视频已完成但未返回可下载的视频 URL');
  return {
    backend,
    model,
    videoId: ids.videoId,
    taskId: ids.taskId,
    status,
    videoUrl,
    seconds: last.seconds != null ? last.seconds : (numFrames / frameRate),
    size: last.size || null,
    progress: last.progress != null ? last.progress : 100,
    raw: last,
  };
}

/** Download a remote video URL to a local file path (proxy-aware). Returns destPath. */
async function downloadVideo(url, destPath) {
  const dispatcher = _proxyDispatcher();
  const res = await fetchWithTimeout(
    (signal) => fetch(url, { signal, ...(dispatcher ? { dispatcher } : {}) }),
    { timeoutMs: _timeoutMs(), url, operation: 'video-download' },
  );
  if (!res.ok) throw new Error(`视频下载失败: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}

module.exports = {
  generate,
  downloadVideo,
  resolveBackend,
  backendStatus,
  catalogModels,
  isAnyBackendConfigured,
  backendHelpText,
  validateFrameParams,
  // internals exposed for unit tests (no network)
  __testHooks: { _env, _agnesBaseUrl, _agnesApiKey, _agnesKeyFromPool, _buildAgnesBody, _extractVideoUrl, _sleep },
};
