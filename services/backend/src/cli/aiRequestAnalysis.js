'use strict';

/**
 * Request-analysis helpers (extracted from cli/ai.js).
 *
 * Owns two cohesive pre-flight decision clusters that analyze the incoming request + target model
 * WITHOUT touching conversation state: (1) context budgeting — _resolveModelContextLimit /
 * _guessModelHint / _estimateContextTokens / _resolveContextBudget; (2) multimodal / vision routing —
 * _supportsImageOnAdapter / _resolveMultimodalAdapterCaps / _supportsMediaKindsOnAdapter /
 * _isImageActionTask / _pickMultimodalAdapter / _pickVisionAdapter / _applyVisionRouting (plus the
 * band-local DEFAULT_MULTIMODAL_ADAPTER_CAPS table). Relocated verbatim (byte-identical bodies) into a
 * same-directory sibling leaf so in-body relative require() paths resolve identically; the host
 * re-imports the five entry points by the same names.
 *
 * These bodies read only two immutable capability tables (EFFORT_PRESETS, MODEL_CAPABILITIES) and two
 * host accessors (_resolveTaskScale, getGateway), all injected via setAiRequestAnalysisDeps to avoid a
 * require cycle back into ai.js. The leaf touches no mutable conversation/session state.
 */

const runtime = require('../services/khyUpgradeRuntime');

// Injected read-only capability tables + host accessors (avoid a require cycle back into ai.js).
let EFFORT_PRESETS = null;
let MODEL_CAPABILITIES = null;
let _resolveTaskScale = null;
let getGateway = null;
// _gateway is intentionally always null here: the sole reference below is
// `_gateway || require('../services/gateway/aiGateway')`, and require() returns the same cached
// module singleton, so the fallback path stays byte-identical and behaviorally equivalent to the host.
let _gateway = null;

function setAiRequestAnalysisDeps(deps = {}) {
  if (deps.EFFORT_PRESETS) EFFORT_PRESETS = deps.EFFORT_PRESETS;
  if (deps.MODEL_CAPABILITIES) MODEL_CAPABILITIES = deps.MODEL_CAPABILITIES;
  if (typeof deps._resolveTaskScale === 'function') _resolveTaskScale = deps._resolveTaskScale;
  if (typeof deps.getGateway === 'function') getGateway = deps.getGateway;
}

function _resolveModelContextLimit(modelHint = '') {
  const lower = String(modelHint || '').toLowerCase().trim();
  if (!lower) return 128000;

  // 1. Gateway adapter-reported real data (single source of truth)
  try {
    const gw = require('../services/gateway/aiGateway');
    const instance = typeof gw.getInstance === 'function' ? gw.getInstance() : gw;
    if (instance && typeof instance.getModelContextWindow === 'function') {
      const dynamic = instance.getModelContextWindow(lower);
      if (dynamic > 0) {
        // A declared 1M window is only real when the context-1m beta is live.
        // Re-clamp through the adapter so the compaction budget never assumes
        // 1M after a 400 fallback / disable / unsupported family — otherwise a
        // long conversation overflows the real 200k ceiling and 400s.
        try {
          const ca = require('../services/gateway/adapters/claudeAdapter');
          if (typeof ca.effectiveContextWindow === 'function') {
            return ca.effectiveContextWindow(lower, dynamic);
          }
        } catch { /* adapter optional — fall through to raw window */ }
        return dynamic;
      }
    }
  } catch { /* gateway not ready yet */ }

  // 2. Fallback: MODEL_CAPABILITIES static table (only used before gateway init)
  for (const [key, capability] of Object.entries(MODEL_CAPABILITIES)) {
    if (key !== 'default' && lower.includes(key) && capability && Number.isFinite(capability.context)) {
      return Math.max(8000, Number(capability.context));
    }
  }

  // 3. Unknown model — return conservative default; gateway will async-resolve for next call
  return 128000;
}

function _guessModelHint(opts = {}) {
  const byOpts = String(opts.preferredModel || '').trim();
  if (byOpts) return byOpts;
  const byEnv = String(process.env.GATEWAY_PREFERRED_MODEL || '').trim();
  if (byEnv) return byEnv;
  try {
    const gw = _gateway || require('../services/gateway/aiGateway');
    const status = gw && typeof gw.getStatus === 'function' ? gw.getStatus() : null;
    const active = Array.isArray(status) ? status.find(s => s && s.active) : null;
    return String(active?.activeModel || active?.model || '').trim();
  } catch {
    return '';
  }
}

function _estimateContextTokens(messages = [], systemPrompt = '', userPrompt = '') {
  let _ct;
  try { _ct = require('../services/contentBlockUtils').contentToText; } catch { _ct = (c) => String(c || ''); }
  const msgTokens = (messages || []).reduce((sum, m) => sum + runtime.estimateTokens(_ct(m?.content)), 0);
  const sysTokens = runtime.estimateTokens(String(systemPrompt || ''));
  const userTokens = runtime.estimateTokens(String(userPrompt || ''));
  // A2: 移除 _estimateContextTokens 的 1.2x — 安全系数只在 contextRouter 应用一次
  return Math.ceil(msgTokens + sysTokens + userTokens);
}

function _resolveContextBudget(opts = {}, preset = EFFORT_PRESETS.medium, userMessage = '') {
  const scale = _resolveTaskScale(userMessage, opts);
  const configuredLimit = parseInt(String(process.env.KHY_CONTEXT_TOKEN_LIMIT || runtime.CONTEXT_TOKEN_LIMIT || ''), 10);
  const modelHint = _guessModelHint(opts);
  const modelLimit = _resolveModelContextLimit(modelHint);

  let contextWindow = modelLimit;
  if (Number.isFinite(configuredLimit) && configuredLimit > 0) {
    contextWindow = Math.min(contextWindow, configuredLimit);
  }

  const minBudget = Math.max(4096, parseInt(String(process.env.KHY_CONTEXT_MIN_BUDGET || '8192'), 10) || 8192);
  const baseReserve = Math.max(1024, parseInt(String(process.env.KHY_CONTEXT_OUTPUT_RESERVE_TOKENS || ''), 10) || 0);
  const presetReserve = Math.max(1024, Math.floor(Number(preset?.maxTokens || 4096)));
  const reserveTokens = Math.max(baseReserve, scale === 'large' ? presetReserve : Math.min(presetReserve, 4096));

  const safetyRatioBase = Number.parseFloat(String(process.env.KHY_CONTEXT_SAFETY_RATIO || '0.12'));
  const safetyRatio = scale === 'small'
    ? Math.min(0.4, Math.max(0.1, safetyRatioBase + 0.08))
    : (scale === 'large'
      ? Math.min(0.35, Math.max(0.08, safetyRatioBase))
      : Math.min(0.35, Math.max(0.09, safetyRatioBase + 0.03)));
  const safetyTokens = Math.max(1024, Math.floor(contextWindow * safetyRatio));

  let budget = contextWindow - reserveTokens - safetyTokens;
  if (scale === 'small') {
    const smallCap = Math.max(16000, parseInt(String(process.env.KHY_CONTEXT_SMALL_CAP_TOKENS || '65536'), 10) || 65536);
    budget = Math.min(budget, smallCap);
  }

  budget = Math.max(minBudget, budget);
  return {
    taskScale: scale,
    modelHint,
    contextWindow,
    contextBudget: budget,
    reserveTokens,
    safetyTokens,
  };
}

function _supportsImageOnAdapter(adapterKey = '') {
  const key = String(adapterKey || '').trim().toLowerCase();
  // Default strategy: assume adapter supports vision unless explicitly blacklisted.
  // This avoids premature forced channel switching (e.g. codex -> claude).
  if (!key) return true;
  const extraCapable = String(process.env.KHY_VISION_CAPABLE_ADAPTERS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  const nonVision = String(process.env.KHY_NON_VISION_ADAPTERS || 'clipboard,kiro')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  const capable = new Set(extraCapable);
  const nonVisionSet = new Set(nonVision);
  if (capable.has(key)) return true;
  if (nonVisionSet.has(key)) return false;
  return true;
}

const DEFAULT_MULTIMODAL_ADAPTER_CAPS = Object.freeze({
  claude: ['image', 'document'],
  codex: ['image'],
  api: ['image', 'audio', 'video', 'document'],
  relay_api: ['image', 'audio', 'video', 'document'],
  relay: ['image', 'document'],
  ollama: ['image'],
  localLLM: ['image'],
  localllm: ['image'],
  kiro: ['image'],
  cursor: ['image'],
  trae: ['image'],
  windsurf: ['image'],
});

function _resolveMultimodalAdapterCaps() {
  const out = { ...DEFAULT_MULTIMODAL_ADAPTER_CAPS };
  const raw = String(process.env.KHY_MULTIMODAL_ADAPTER_CAPS || '').trim();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return out;
    for (const [adapter, kinds] of Object.entries(parsed)) {
      const key = String(adapter || '').trim();
      if (!key || !Array.isArray(kinds)) continue;
      const normalizedKinds = kinds
        .map(x => String(x || '').trim().toLowerCase())
        .filter(Boolean);
      if (normalizedKinds.length > 0) out[key] = [...new Set(normalizedKinds)];
    }
  } catch { /* ignore malformed env */ }
  return out;
}

function _supportsMediaKindsOnAdapter(adapterKey = '', mediaKinds = []) {
  const key = String(adapterKey || '').trim();
  const normalizedKey = key.toLowerCase();
  const kinds = [...new Set((mediaKinds || []).map(x => String(x || '').trim().toLowerCase()).filter(Boolean))];
  if (kinds.length === 0) return true;
  if (kinds.length === 1 && kinds[0] === 'image') return _supportsImageOnAdapter(normalizedKey);
  const caps = _resolveMultimodalAdapterCaps();
  const supported = new Set(caps[key] || caps[normalizedKey] || []);
  return kinds.every(kind => supported.has(kind));
}

function _isImageActionTask(opts = {}) {
  const text = String(
    opts.userMessage
    || opts.originalUserMessage
    || opts.prompt
    || ''
  ).toLowerCase();
  if (!text) return false;
  return /(写|保存|生成|创建|制作|导出|修改|编辑|网页|页面|html|文件|桌面|双击|write|save|create|generate|build|edit|modify|html|page|file|desktop)/i.test(text);
}

function _pickMultimodalAdapter(requested = '', mediaKinds = [], preferredAdapters = []) {
  const visionFallback = String(
    process.env.KHY_VISION_PREFERRED_ADAPTERS
    || process.env.KHY_VISION_PREFERRED_ADAPTER
    || 'codex,claude,api'
  )
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const multimodalFallback = String(process.env.KHY_MULTIMODAL_PREFERRED_ADAPTERS || 'claude,codex,api,relay_api')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const ordered = [...new Set([
    ...(Array.isArray(preferredAdapters) ? preferredAdapters : []),
    ...visionFallback,
    ...multimodalFallback,
  ])];
  const requestedKey = String(requested || '').trim();
  if (requestedKey) ordered.push(requestedKey);

  try {
    const gw = getGateway();
    const statuses = typeof gw.getStatus === 'function' ? gw.getStatus() : [];
    const statusList = Array.isArray(statuses) ? statuses : [];
    const available = new Set(
      statusList
        .filter(s => s && s.available)
        .map(s => String(s.type || '').trim().toLowerCase())
        .filter(Boolean)
    );
    for (const candidate of ordered) {
      const key = String(candidate || '').trim();
      if (!key) continue;
      const lower = key.toLowerCase();
      if (!available.has(lower)) continue;
      if (_supportsMediaKindsOnAdapter(lower, mediaKinds)) return lower;
    }
    if (requestedKey && available.has(requestedKey.toLowerCase()) && _supportsMediaKindsOnAdapter(requestedKey, mediaKinds)) {
      return requestedKey.toLowerCase();
    }
    for (const candidate of available) {
      if (_supportsMediaKindsOnAdapter(candidate, mediaKinds)) return candidate;
    }
  } catch { /* gateway status best effort */ }

  return requestedKey.toLowerCase() || String(ordered[0] || 'claude').toLowerCase();
}

function _pickVisionAdapter(requested = '', preferredAdapters = []) {
  return _pickMultimodalAdapter(requested, ['image'], preferredAdapters);
}

function _applyVisionRouting(opts = {}, onStatus = null, startTime = Date.now()) {
  const mediaKinds = [...new Set((Array.isArray(opts._mediaKinds) ? opts._mediaKinds : [])
    .map(x => String(x || '').trim().toLowerCase())
    .filter(Boolean))];
  const hasImageInput = Array.isArray(opts.images) && opts.images.length > 0;
  if (hasImageInput && !mediaKinds.includes('image')) mediaKinds.push('image');
  if (!hasImageInput && mediaKinds.length === 0) return opts;

  const requested = String(opts.preferredAdapter || process.env.GATEWAY_PREFERRED_ADAPTER || '').trim().toLowerCase();
  const actionTask = _isImageActionTask(opts);
  const toolWeakAdapters = new Set(
    String(process.env.KHY_VISION_TOOL_WEAK_ADAPTERS || 'kiro')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const smartRouteEnabled = !['0', 'false', 'off'].includes(
    String(process.env.KHY_VISION_SMART_ROUTE || 'true').trim().toLowerCase()
  );
  const weakForActionTask = smartRouteEnabled && actionTask && toolWeakAdapters.has(requested);
  const hasNonImageMedia = mediaKinds.some(kind => kind !== 'image');

  if (!requested || (_supportsMediaKindsOnAdapter(requested, mediaKinds) && !weakForActionTask)) return opts;

  const forceRoute = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.KHY_VISION_FORCE_ROUTE || 'false').trim().toLowerCase()
  );
  const shouldForceRoute = forceRoute || weakForActionTask || hasNonImageMedia;
  if (!shouldForceRoute) {
    if (typeof onStatus === 'function') {
      try {
        onStatus({
          phase: 'request',
          message: `检测到多模态输入，保持当前通道 ${requested}；若不支持将由网关自动兜底重试`,
          elapsed: Date.now() - startTime,
        });
      } catch { /* best effort */ }
    }
    return opts;
  }

  const preferredAdapters = Array.isArray(opts._multimodalPreferredAdapters)
    ? opts._multimodalPreferredAdapters
    : [];
  const visionAdapter = _pickMultimodalAdapter(requested, mediaKinds, preferredAdapters);
  if (!visionAdapter || visionAdapter === requested) return opts;
  const routed = {
    ...opts,
    preferredAdapter: visionAdapter,
    preferredStrict: false,
    strictPreferred: false,
  };
  if (typeof onStatus === 'function') {
    try {
      const from = requested || '当前通道';
      const mediaLabel = mediaKinds.length > 0 ? `（${mediaKinds.join('+')}）` : '';
      const reason = weakForActionTask ? `${mediaLabel}（图片+执行任务场景）` : mediaLabel;
      onStatus({
        phase: 'request',
        message: `检测到多模态输入，${from} 已切换到 ${visionAdapter}${reason}`,
        elapsed: Date.now() - startTime,
      });
    } catch { /* best effort */ }
  }
  return routed;
}

module.exports = {
  _resolveModelContextLimit,
  _guessModelHint,
  _estimateContextTokens,
  _resolveContextBudget,
  _supportsImageOnAdapter,
  _resolveMultimodalAdapterCaps,
  _supportsMediaKindsOnAdapter,
  _isImageActionTask,
  _pickMultimodalAdapter,
  _pickVisionAdapter,
  _applyVisionRouting,
  setAiRequestAnalysisDeps,
};
