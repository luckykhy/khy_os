/**
 * API Adapter — thin wrapper around the existing MultiFreeService
 * to expose a unified interface for the gateway.
 */
const { fetchWithTimeout } = require('../../fetchTimeout');
const { fetchUpstreamModels } = require('../upstreamModelProbe');
const { createAdapterRuntimeDiagnosticsStore } = require('../runtimeDiagnosticsStore');

const DEFAULT_API_TIMEOUT_MS = 120_000; // 2 minutes default
let _service = null;
const _runtimeDiagnosticsStore = createAdapterRuntimeDiagnosticsStore('api');
let _runtimeDiagnostics = _runtimeDiagnosticsStore.createEmptyDiagnostic();
const SERVICE_PROVIDER_KEYS = new Set([
  'google',
  'groq',
  'openrouter',
  'openai',
  'anthropic',
  'trae',
  'zhipu',
  'xunfei',
  'baidu',
  'alibaba',
  'huggingface',
]);
const DEFAULT_POOL_PROVIDER_ALIASES = Object.freeze({
  openai: 'openai',
  gpt: 'openai',
  anthropic: 'anthropic',
  claude: 'anthropic',
  trae: 'trae',
  deepseek: 'deepseek',
  qwen: 'qwen',
  alibaba: 'qwen',
  dashscope: 'qwen',
  glm: 'glm',
  zhipu: 'glm',
  doubao: 'doubao',
  wenxin: 'wenxin',
  baidu: 'wenxin',
  relay: 'relay',
  sensenova: 'sensenova',
});
const DEFAULT_POOL_TO_SERVICE_PROVIDER = Object.freeze({
  openai: 'openai',
  anthropic: 'anthropic',
  trae: 'trae',
  deepseek: 'openai',
  qwen: 'alibaba',
  glm: 'zhipu',
  doubao: 'openai',
  wenxin: 'baidu',
  relay: 'openai',
  sensenova: 'openai',
});
const DEFAULT_POOL_DEFAULT_MODEL_MAP = Object.freeze({
  deepseek: 'deepseek-chat',
  doubao: 'doubao-pro-32k',
  qwen: 'qwen-plus',
  glm: 'glm-4-plus',
  wenxin: 'ERNIE-Bot',
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
  trae: 'gpt-4o',
  relay: 'gpt-4o-mini',
  sensenova: 'sensenova-6.7-flash-lite',
});

const parseJsonMap = require('../../../utils/parseJsonObjectMap');

function getPoolAliasMap() {
  const extra = parseJsonMap(process.env.GATEWAY_API_POOL_PROVIDER_ALIAS_MAP || '');
  const merged = { ...DEFAULT_POOL_PROVIDER_ALIASES };
  for (const [k, v] of Object.entries(extra)) {
    const key = String(k || '').trim().toLowerCase();
    const value = String(v || '').trim().toLowerCase();
    if (!key || !value) continue;
    merged[key] = value;
  }
  return merged;
}

function getPoolServiceMap() {
  const extra = parseJsonMap(process.env.GATEWAY_API_POOL_SERVICE_MAP || '');
  const merged = { ...DEFAULT_POOL_TO_SERVICE_PROVIDER };
  for (const [k, v] of Object.entries(extra)) {
    const key = String(k || '').trim().toLowerCase();
    const value = String(v || '').trim().toLowerCase();
    if (!key || !value) continue;
    merged[key] = value;
  }
  return merged;
}

function getPoolDefaultModelMap() {
  const extra = parseJsonMap(process.env.GATEWAY_API_POOL_DEFAULT_MODEL_MAP || '');
  const merged = { ...DEFAULT_POOL_DEFAULT_MODEL_MAP };
  for (const [k, v] of Object.entries(extra)) {
    const key = String(k || '').trim().toLowerCase();
    const value = String(v || '').trim();
    if (!key || !value) continue;
    merged[key] = value;
  }
  return merged;
}

function getService() {
  if (!_service) {
    const MultiFreeService = require('../../multiFreeService');
    _service = new MultiFreeService();
  }
  return _service;
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
 * Check if any API provider is configured and available.
 * 检查 MultiFreeService 内置 provider + apiKeyPool 自定义 provider。
 */
function detect() {
  const svc = getService();
  const providers = svc.getAvailableProviders();
  if (providers.length > 0) return true;

  // MultiFreeService 没有可用 provider 时，检查 apiKeyPool 中的自定义 provider
  try {
    const pool = require('../../apiKeyPool');
    pool.init();
    for (const poolKey of pool.getProviders()) {
      if (pool.hasAvailableKeys(poolKey)) return true;
    }
  } catch { /* ignore */ }

  return false;
}

/**
 * 异步探测：对 apiKeyPool 中每个 provider 的 endpoint 做 HTTP 连通测试。
 * gateway.testAdapter('api') 优先调用此方法。
 */
async function detectAsync() {
  if (!detect()) return false;

  try {
    const pool = require('../../apiKeyPool');
    pool.init();
    const providers = pool.getProviders();
    if (providers.length === 0) return true;

    const PROBE_TIMEOUT = 5000;
    const results = await Promise.allSettled(
      providers.map(async (prov) => {
        const keys = pool.listAvailableKeys(prov);
        const endpoint = keys.length > 0 ? keys[0].endpoint : null;
        if (!endpoint) return { provider: prov, ok: false, ms: 0, error: 'no endpoint' };
        const t0 = Date.now();
        const url = endpoint.replace(/\/+$/, '') + '/models';
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
          const resp = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer probe' },
            signal: controller.signal,
          });
          clearTimeout(timer);
          // 任何 HTTP 响应（包括 401/403）都说明 endpoint 可达
          return { provider: prov, ok: true, ms: Date.now() - t0, status: resp.status };
        } catch (err) {
          const ms = Date.now() - t0;
          const msg = String(err && err.message ? err.message : err || '').slice(0, 60);
          // AbortError = timeout
          if (err && err.name === 'AbortError') {
            return { provider: prov, ok: false, ms, error: 'timeout' };
          }
          return { provider: prov, ok: false, ms, error: msg };
        }
      })
    );

    // 缓存探测结果，供 getStatus() 显示
    _lastProbeResults = {};
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        _lastProbeResults[r.value.provider] = r.value;
      }
    }
    return Object.values(_lastProbeResults).some(r => r.ok);
  } catch {
    return detect();
  }
}

let _lastProbeResults = null;

function parseProviderModel(rawModel) {
  const input = String(rawModel || '').trim();
  if (!input) return { provider: null, model: null };

  // 三段式 api:poolKey:model — 自定义 pool provider 格式
  const m3 = input.match(/^api[:/]([a-z0-9_-]+)[:/](.+)$/i);
  if (m3) {
    return {
      provider: m3[1].toLowerCase(),   // poolKey 作为 provider
      model: m3[2].trim(),
      poolProvider: m3[1].toLowerCase(),
    };
  }

  // 两段式 provider:model
  const m = input.match(/^([a-z0-9_-]+)[:/](.+)$/i);
  if (m) {
    return {
      provider: m[1].toLowerCase(),
      model: m[2].trim(),
    };
  }
  return { provider: null, model: input };
}

function normalizePoolProvider(raw) {
  const normalized = String(raw || '').trim().toLowerCase();
  if (!normalized) return null;
  const aliasMap = getPoolAliasMap();
  return aliasMap[normalized] || normalized;
}

function normalizeServiceProvider(raw) {
  const normalized = String(raw || '').trim().toLowerCase();
  if (!normalized) return null;
  if (SERVICE_PROVIDER_KEYS.has(normalized)) return normalized;
  const poolProvider = normalizePoolProvider(normalized);
  if (!poolProvider) return null;
  return getPoolServiceMap()[poolProvider] || null;
}

function defaultModelForPoolProvider(poolProvider) {
  const normalized = String(poolProvider || '').toLowerCase();
  const defaults = getPoolDefaultModelMap();
  if (normalized === 'deepseek') return process.env.DEEPSEEK_MODEL || defaults.deepseek;
  if (normalized === 'doubao') return process.env.DOUBAO_MODEL || defaults.doubao;
  if (normalized === 'qwen') return process.env.QWEN_MODEL || defaults.qwen;
  if (normalized === 'glm') return process.env.GLM_MODEL || process.env.ZHIPU_MODEL || defaults.glm;
  if (normalized === 'wenxin') return process.env.WENXIN_MODEL || defaults.wenxin;
  if (normalized === 'anthropic') return process.env.ANTHROPIC_MODEL || defaults.anthropic;
  if (normalized === 'openai') return process.env.OPENAI_MODEL || defaults.openai;
  if (normalized === 'trae') return process.env.TRAE_MODEL || defaults.trae;
  if (normalized === 'relay') return process.env.RELAY_API_MODEL || process.env.OPENAI_MODEL || defaults.relay;
  const mapped = getPoolDefaultModelMap()[normalized];
  if (mapped) return mapped;
  return null;
}

function resolveProviderScope(parsed, options = {}) {
  const hintedPoolProvider = normalizePoolProvider(options.apiPoolProvider);
  const scopedProvider = normalizeServiceProvider(parsed.provider || '');
  const explicitProvider = normalizeServiceProvider(options.provider || '');
  const serviceMap = getPoolServiceMap();
  const fromPoolHint = hintedPoolProvider ? (serviceMap[hintedPoolProvider] || null) : null;

  const serviceProvider = scopedProvider || explicitProvider || fromPoolHint || null;
  const poolProvider = hintedPoolProvider
    || normalizePoolProvider(parsed.provider || '')
    || normalizePoolProvider(options.provider || '')
    || null;

  return {
    serviceProvider,
    poolProvider,
  };
}

function withBaseUrl(rawEndpoint = '') {
  const endpoint = String(rawEndpoint || '').trim();
  if (!endpoint) return '';
  return endpoint.replace(/\/+$/, '');
}

function buildOverriddenService(providerKey, options = {}) {
  if (!providerKey) return null;
  const MultiFreeService = require('../../multiFreeService');
  const svc = new MultiFreeService();
  let current = svc.providers?.[providerKey];

  // 如果目标 service provider 模板不存在（如用户没配 OPENAI_API_KEY），
  // 创建一个最小模板，保证 pool 注入的 key/endpoint 能生效
  if (!current) {
    current = { name: providerKey, apiKey: '', enabled: false, model: '', priority: 4, supportsVision: false };
    svc.providers = svc.providers || {};
    svc.providers[providerKey] = current;
  }
  if (!current) return null;

  const next = {
    ...current,
    enabled: true,
  };
  if (String(options.apiKey || '').trim()) {
    next.apiKey = String(options.apiKey).trim();
  }
  if (String(options.apiEndpoint || '').trim()) {
    next.baseUrl = withBaseUrl(options.apiEndpoint);
  }

  svc.providers[providerKey] = next;
  for (const key of Object.keys(svc.providers || {})) {
    if (key === providerKey) continue;
    svc.providers[key] = {
      ...svc.providers[key],
      enabled: false,
    };
  }
  return svc;
}

/**
 * Generate a response through cloud API providers.
 */
async function generate(prompt, options = {}) {
  const parsed = parseProviderModel(options.model);
  const scope = resolveProviderScope(parsed, options);
  const timeoutMs = options.timeoutMs || DEFAULT_API_TIMEOUT_MS;
  const upstreamSignal = options.abortSignal || options.signal || null;

  // Pool provider 路由：从 apiKeyPool 取 key + endpoint 注入
  const poolKey = parsed.poolProvider || scope.poolProvider || null;
  let poolApiKey = String(options.apiKey || '').trim();
  let poolEndpoint = String(options.apiEndpoint || '').trim();
  if (poolKey && (!poolApiKey || !poolEndpoint)) {
    try {
      const pool = require('../../apiKeyPool');
      pool.init();
      const keyEntry = pool.pick(poolKey);
      if (keyEntry) {
        if (!poolApiKey && keyEntry.key) poolApiKey = keyEntry.key;
        if (!poolEndpoint && keyEntry.endpoint) poolEndpoint = keyEntry.endpoint;
      }
    } catch { /* ignore */ }
  }

  const effectiveServiceProvider = scope.serviceProvider
    || (poolKey ? (getPoolServiceMap()[poolKey] || 'openai') : null);
  const useRequestOverride = !!(
    effectiveServiceProvider && (poolApiKey || poolEndpoint)
  );
  const overrideOpts = useRequestOverride
    ? { ...options, apiKey: poolApiKey, apiEndpoint: poolEndpoint }
    : options;
  const svc = useRequestOverride
    ? (buildOverriddenService(effectiveServiceProvider, overrideOpts) || getService())
    : getService();
  let resolvedModel = parsed.model
    || defaultModelForPoolProvider(scope.poolProvider)
    || null;
  // 仅 glm 池:下线智谱模型名(如 glm-4.5)重映射到有效替代,避免直发端点撞 404
  // model_not_found(fail-soft,门控 KHY_ZHIPU_FREE_MODELS)。
  if (poolKey && resolvedModel) {
    try {
      const zf = require('../zhipuFreeModels');
      if (zf.isGlmPoolKey(poolKey)) {
        resolvedModel = zf.remapRetiredZhipuModel(resolvedModel, options.env || process.env) || resolvedModel;
      }
    } catch { /* fail-soft: keep resolvedModel */ }
  }
  const resolvedProvider = effectiveServiceProvider || null;

  try {
    const result = await fetchWithTimeout(
      (signal) => svc.generateResponse(prompt, {
        ...options,
        provider: resolvedProvider,
        model: resolvedModel,
        signal,
      }),
      {
        timeoutMs,
        signal: upstreamSignal,
        operation: 'apiAdapter.generate',
      }
    );

    const attempts = Array.isArray(result.attempts) ? result.attempts : [];
    const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
    const resolvedError = String(
      result.error
      || lastAttempt?.error
      || ''
    ).trim();
    const resolvedErrorType = String(
      result.errorType
      || lastAttempt?.errorType
      || ''
    ).trim();

    if (result.success) {
      recordRuntimeRecovery(
        options,
        `API request succeeded (${resolvedProvider || 'auto'} / ${result.model || resolvedModel || 'default'})`,
        `api adapter request completed via ${result.provider || resolvedProvider || 'auto'}`
      );
    } else {
      recordRuntimeFailure(options, {
        trigger: resolvedErrorType === 'timeout' ? 'request_timeout' : 'request_failed',
        category: mapRuntimeCategory(resolvedErrorType, resolvedError),
        phase: 'response',
        summary: `API request failed (${resolvedProvider || 'auto'} / ${resolvedModel || 'default'})`,
        diagnosis: resolvedError
          ? `api adapter returned a failed result via ${resolvedProvider || 'auto'}: ${resolvedError}`
          : `api adapter returned a failed result via ${resolvedProvider || 'auto'}`,
        lastError: resolvedError,
      });
    }

    return {
      success: result.success,
      content: result.content || '',
      provider: result.provider || '',
      adapter: 'api',
      model: result.model || resolvedModel || null,
      attempts: result.attempts || [],
      tokenUsage: result.tokenUsage || null,
      thinking: result.thinking || null,
      error: resolvedError || undefined,
      errorType: resolvedErrorType || undefined,
      toolUseBlocks: Array.isArray(result.toolUseBlocks) && result.toolUseBlocks.length > 0
        ? result.toolUseBlocks : undefined,
      // Surface the model's native finish/stop reason so the loop's stop_reason
      // trust (KHY_TRUST_STOP_REASON) works on this direct path too, not only on
      // the SSE A-class adapters. gateway aiGateway.js also folds stopReason.
      stopReason: result.stopReason || result.finishReason || null,
    };
  } catch (err) {
    const errMsg = String(err && err.message ? err.message : err || '').trim();
    recordRuntimeFailure(options, {
      trigger: /timeout/i.test(errMsg) ? 'request_timeout' : 'request_exception',
      category: mapRuntimeCategory('', errMsg),
      phase: 'request',
      summary: `API request threw before completion (${resolvedProvider || 'auto'} / ${resolvedModel || 'default'})`,
      diagnosis: `api adapter request raised an exception via ${resolvedProvider || 'auto'}: ${errMsg || 'unknown error'}`,
      lastError: errMsg,
    });
    throw err;
  }
}

/**
 * List available API models in provider-scoped form:
 *   openai:gpt-4o-mini
 *   anthropic:claude-sonnet-4-6
 */
async function listModels() {
  const svc = getService();
  const providers = svc.getAvailableProviders();
  const seen = new Set();
  const rows = [];

  for (const p of providers) {
    const models = Array.isArray(p.availableModels) && p.availableModels.length > 0
      ? p.availableModels.map(m => m.id).filter(Boolean)
      : (p.model ? [p.model] : []);

    for (const mid of models) {
      const id = `${p.key}:${mid}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id,
        name: `${p.name} / ${mid}`,
        provider: 'api',
        description: `Cloud provider: ${p.name}`,
        isDefault: mid === p.model,
      });
    }
  }

  // 追加 apiKeyPool 中自定义 provider 的模型（优先远端 /v1/models，回退静态列表）
  try {
    const pool = require('../../apiKeyPool');
    pool.init();
    const customRegistry = require('../../customProviderRegistry');
    const defaultModelMap = getPoolDefaultModelMap();

    // 收集需要远端发现的 provider
    const poolProviders = [];
    for (const cp of customRegistry.listProviders()) {
      if (!pool.hasAvailableKeys(cp.poolKey)) continue;
      poolProviders.push({ poolKey: cp.poolKey, name: cp.name, staticModels: cp.models || [], isCustom: true });
    }
    for (const poolKey of pool.getProviders()) {
      if (!pool.hasAvailableKeys(poolKey)) continue;
      if (poolProviders.some(p => p.poolKey === poolKey)) continue;
      // 智谱 key 配好后自动加入免费模型:裸 poolKey `glm` 的静态集并入免费聊天/视觉模型
      // (门控 KHY_ZHIPU_FREE_MODELS,门关/非 glm/异常 → 原样返回,逐字节回退)。远端 /v1/models
      // 发现成功时下方仍优先用远端结果;仅在占位/离线回退到此静态集时让免费模型可见。
      let staticModels = defaultModelMap[poolKey] ? [defaultModelMap[poolKey]] : [];
      try { staticModels = require('../zhipuFreeModels').augmentGlmPoolModels(poolKey, staticModels); } catch { /* fail-soft: keep base */ }
      poolProviders.push({ poolKey, name: poolKey, staticModels, isCustom: false });
    }

    // 并行获取所有 provider 的远端模型列表
    const remoteResults = await Promise.allSettled(
      poolProviders.map(async (pp) => {
        const picked = pool.pick(pp.poolKey);
        if (!picked || !picked.endpoint) return { poolKey: pp.poolKey, models: null };
        const models = await _fetchRemoteModels(picked.endpoint, picked.key);
        // pick 不算真正的请求，回退 counter
        pool.markSuccess(picked.keyId);
        return { poolKey: pp.poolKey, models };
      })
    );
    const remoteModelMap = {};
    for (const r of remoteResults) {
      if (r.status === 'fulfilled' && r.value?.models) {
        remoteModelMap[r.value.poolKey] = r.value.models;
      }
    }

    for (const pp of poolProviders) {
      const remoteModels = remoteModelMap[pp.poolKey];
      let models = (remoteModels && remoteModels.length > 0)
        ? remoteModels
        : (pp.staticModels.length > 0 ? pp.staticModels : (defaultModelMap[pp.poolKey] ? [defaultModelMap[pp.poolKey]] : []));
      // 智谱 glm 池:远端 /v1/models 常不完整枚举免费模型(尤其 glm-4.6v-flash 视觉模型),
      // 上面「非空则优先远端」会把静态免费集整个覆盖掉 → 免费视觉模型在列表里消失。这里对最终
      // models 再做一次并集补齐(augmentGlmPoolModels:门控 KHY_ZHIPU_FREE_MODELS、去重、fail-soft;
      // 非 glm/门关/异常 → 原样返回,逐字节回退),保证配好 glm key 后免费视觉模型稳定可见。
      try { models = require('../zhipuFreeModels').augmentGlmPoolModels(pp.poolKey, models); } catch { /* keep */ }
      for (const entry of models) {
        const mid = typeof entry === 'string' ? entry : entry.id;
        const ctxW = typeof entry === 'object' ? (entry.contextWindow || 0) : 0;
        const id = `api:${pp.poolKey}:${mid}`;
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push({
          id,
          name: `${pp.name} / ${mid}`,
          provider: 'api',
          description: `Pool provider: ${pp.name}`,
          isDefault: mid === (defaultModelMap[pp.poolKey] || ''),
          ...(ctxW > 0 ? { contextWindow: ctxW } : {}),
        });
      }
    }
  } catch { /* ignore */ }

  return rows;
}

/**
 * Get adapter status for display.
 */
function getStatus() {
  const svc = getService();
  const status = svc.getStatus();

  // 列出 apiKeyPool 中有可用 key 的 provider 名称及状态
  let poolDetail = '';
  try {
    const pool = require('../../apiKeyPool');
    pool.init();
    const customRegistry = require('../../customProviderRegistry');
    const customMap = {};
    for (const cp of customRegistry.listProviders()) {
      customMap[cp.poolKey] = cp.name;
    }
    const allProviders = pool.getProviders();
    if (allProviders.length > 0) {
      // 逐个显示状态：+ 可用 / - 不可用，有探测结果时附加延迟
      const parts = allProviders.map(p => {
        const name = customMap[p] || p;
        const ok = pool.hasAvailableKeys(p);
        const probe = _lastProbeResults && _lastProbeResults[p];
        if (probe) {
          // 有探测结果：显示 ✓name(120ms) 或 ✗name(err)
          if (probe.ok) return `+${name}(${probe.ms}ms)`;
          return `-${name}`;
        }
        return ok ? `+${name}` : `-${name}`;
      });
      poolDetail = parts.join(', ');
    }
  } catch { /* ignore */ }

  const hasPoolKeys = poolDetail.includes('+');
  const available = status.available || hasPoolKeys;
  // 优先显示各 provider 的可用状态
  let detail;
  if (poolDetail) {
    detail = poolDetail;
  } else if (status.available) {
    detail = status.provider || `${status.configuredProviders.length} 提供商`;
  } else {
    detail = '未配置';
  }
  return {
    name: 'API 云端服务',
    type: 'api',
    available,
    detail,
  };
}

/**
 * Reset the cached service instance (call after API keys change).
 */
function resetService() {
  _service = null;
}

function destroy() {
  _service = null;
  _runtimeDiagnostics = _runtimeDiagnosticsStore.createEmptyDiagnostic();
}

/**
 * 调用 OpenAI-compatible /v1/models 获取远端可用模型 ID 列表。
 * 超时 5s，失败返回 null（调用方回退到静态列表）。
 *
 * Delegates to the single-source upstreamModelProbe so probe semantics stay
 * identical across the admin adapter and the per-user detection service.
 */
async function _fetchRemoteModels(endpoint, apiKey) {
  return fetchUpstreamModels({ endpoint, apiKey, apiFormat: 'openai' });
}

module.exports = { detect, detectAsync, generate, listModels, getStatus, resetService, destroy, parseProviderModel, getRuntimeDiagnostics, getPoolDefaultModelMap };
