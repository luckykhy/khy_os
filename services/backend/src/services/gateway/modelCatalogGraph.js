'use strict';

/**
 * modelCatalogGraph — the SINGLE unified read layer over the fragmented model
 * configuration. It joins the three global stores (custom_providers.json,
 * api_keys.json, the GATEWAY_ / PROXY_ env maps) PLUS the image/video env
 * namespaces into one flat list of "edges". Every multi-pivot view (by-model,
 * by-provider, by-key, by-capability, by-tier, by-status, by-connection, flat)
 * is a pure group-by over this one list (see modelCatalogPivots.js) — we never
 * build six independent readers that could drift.
 *
 * Why a dedicated join: today the only place providers+keys+live-models are
 * joined is apiAdapter.listModels() (for the chat catalog). That join omits
 * capability, tier, key identity, status and connection mode, and it cannot see
 * image/video models (which live OUTSIDE the provider registry). This module is
 * the authoritative superset, reusing the SAME source functions so the two never
 * disagree.
 *
 * State transparency: the result carries a `sources` block reporting exactly
 * what was read, and the join tolerates each store independently (a provider
 * with no keys, keys with no registry entry) — partial state is surfaced, never
 * hidden.
 *
 * Zero-hardcoding: provider/key/model/url/tier all come from the registry, the
 * key pool, env maps, and the image/video services' own env-driven resolvers.
 *
 * Edge shape:
 *   { provider, providerLabel, model, keyIds[], keyCount, capability,
 *     tier, status, connectionMode, isDefault, source }
 *   - status: aggregate of the provider's keys: 'active' if any active,
 *     else 'cooldown' if any cooling down, else 'disabled' (no usable key).
 *   - connectionMode: 'direct' (image/video REST or keyless route) |
 *     'account-pool' (backed by a rotating key pool) | 'proxy' (routed via
 *     PROXY_MODEL_ROUTE_MAP but with no pool keys).
 *   - source: 'chat' | 'image' | 'video' | 'local' — origin store, drives capability.
 */

const customRegistry = require('../customProviderRegistry');
const apiKeyPool = require('../apiKeyPool');
const modelTier = require('../modelTier');
const modelCapability = require('./modelCapability');
const apiAdapter = require('./adapters/apiAdapter');
const imageGenService = require('../imageGenService');
const videoGenService = require('../videoGenService');

/**
 * Gate for the local-model catalog wire (KHY_LOCAL_MODEL_CATALOG, default-on).
 * Off only on an explicit off-word → §4 is skipped → byte-identical edge list.
 */
function _localModelCatalogEnabled() {
  const v = String(process.env.KHY_LOCAL_MODEL_CATALOG || 'true').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/** Parse a JSON object env var into a plain object; {} on any failure. */
function _parseJsonMapEnv(name) {
  const raw = process.env[name];
  if (!raw || !String(raw).trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Aggregate a provider's key statuses into one display status + the key ids.
 * @param {string} provider
 * @returns {{keyIds:string[], status:string, hasActive:boolean}}
 */
function _providerKeyStatus(provider) {
  let entries = [];
  try { entries = apiKeyPool.getPoolStatus(provider) || []; } catch { entries = []; }
  const keyIds = entries.map(e => e.keyId);
  let hasActive = false;
  let hasCooldown = false;
  for (const e of entries) {
    if (e.status === 'active') hasActive = true;
    else if (e.status === 'cooldown') hasCooldown = true;
  }
  const status = hasActive ? 'active' : (hasCooldown ? 'cooldown' : 'disabled');
  return { keyIds, status, hasActive };
}

/**
 * Build the unified catalog graph.
 *
 * @param {{live?: boolean}} [opts] live=true enables remote /v1/models discovery
 *   per provider (slower, network). Default false → static models only
 *   (registry models[] + default-model map), deterministic and fast.
 * @returns {Promise<{edges:Array, generatedAt:number, sources:object}>}
 */
async function buildCatalogGraph(opts = {}) {
  const live = Boolean(opts.live);
  try { apiKeyPool.init(); } catch { /* already initialised */ }

  const edges = [];
  const sources = {
    customProviders: 0,
    poolOnlyProviders: 0,
    imageBackends: 0,
    videoBackends: 0,
    localModels: 0,
    live,
  };

  const defaultModelMap = apiAdapter.getPoolDefaultModelMap();
  const proxyRouteMap = _parseJsonMapEnv('PROXY_MODEL_ROUTE_MAP');

  // ── 1. Chat providers: registry first, then pool-only (keys but no registry) ──
  const providers = [];
  const registry = customRegistry.listProviders();
  for (const cp of registry) {
    providers.push({
      poolKey: cp.poolKey,
      label: cp.name || cp.poolKey,
      staticModels: Array.isArray(cp.models) ? cp.models.slice() : [],
      tier: cp.tier || null,
      defaultModel: cp.defaultModel || '',
    });
  }
  sources.customProviders = providers.length;

  let poolProviders = [];
  try { poolProviders = apiKeyPool.getProviders() || []; } catch { poolProviders = []; }
  for (const poolKey of poolProviders) {
    if (providers.some(p => p.poolKey === poolKey)) continue;
    const dm = defaultModelMap[poolKey];
    // 智谱 key 配好后自动加入免费模型:裸 poolKey `glm` 的静态集并入免费聊天/视觉模型
    // (门控 KHY_ZHIPU_FREE_MODELS,门关/非 glm/异常 → 原样返回,逐字节回退)。
    let staticModels = dm ? [dm] : [];
    try { staticModels = require('./zhipuFreeModels').augmentGlmPoolModels(poolKey, staticModels); } catch { /* fail-soft: keep base */ }
    providers.push({
      poolKey,
      label: poolKey,
      staticModels,
      tier: null,
      defaultModel: dm || '',
    });
    sources.poolOnlyProviders += 1;
  }

  // Optional live discovery: reuse apiAdapter.listModels() (which already does
  // the global remote /v1/models join) and bucket its rows per provider via the
  // canonical id form `api:<poolKey>:<model>`. Falls back to static on failure.
  const liveModelMap = {};
  if (live) {
    try {
      const rows = await apiAdapter.listModels();
      for (const r of (rows || [])) {
        const m = /^api:([^:]+):(.+)$/.exec(String(r && r.id || ''));
        if (!m) continue;
        const pk = m[1];
        const mid = m[2];
        (liveModelMap[pk] = liveModelMap[pk] || []).push(mid);
      }
    } catch { /* ignore discovery failure; static fallback below */ }
  }

  for (const p of providers) {
    const { keyIds, status } = _providerKeyStatus(p.poolKey);
    let models = (liveModelMap[p.poolKey] && liveModelMap[p.poolKey].length)
      ? liveModelMap[p.poolKey]
      : p.staticModels;
    if (!models || models.length === 0) {
      // Provider configured but no enumerable model yet — emit a placeholder edge
      // using the default model if known, else skip (surfaced via sources count).
      if (p.defaultModel) models = [p.defaultModel];
      else continue;
    }
    for (const raw of models) {
      const model = typeof raw === 'string' ? raw : (raw && raw.id);
      if (!model) continue;
      const tier = p.tier || modelTier.resolveTier(model);
      // Chat-registry models: do NOT force source:'text'. The provider registry is
      // reached via the chat endpoint, but a model listed there can still be a
      // multimodal/image/video model (e.g. "<name>-image"). Letting it fall through
      // to the env-override + regex + 'text' default classifies it by what it is,
      // not merely by which endpoint exposes it. Origin-based hints are reserved for
      // the image/video services below, where the origin truly is authoritative.
      const capability = modelCapability.classifyCapability(model);
      const isDefault = model === (p.defaultModel || defaultModelMap[p.poolKey] || '');
      // connectionMode precedence: pooled keys → account-pool; else a proxy
      // route entry with no keys → proxy; else direct.
      let connectionMode;
      if (keyIds.length > 0) connectionMode = 'account-pool';
      else if (proxyRouteMap[model]) connectionMode = 'proxy';
      else connectionMode = 'direct';
      edges.push({
        provider: p.poolKey,
        providerLabel: p.label,
        model,
        keyIds,
        keyCount: keyIds.length,
        capability,
        tier,
        status,
        connectionMode,
        isDefault,
        source: 'chat',
      });
    }
  }

  // ── 2. Image models (OUTSIDE the provider registry) ──
  try {
    const imageModels = imageGenService.catalogModels() || [];
    const seenImg = new Set();
    for (const m of imageModels) {
      const key = `${m.backend}:${m.model}`;
      if (seenImg.has(key)) continue;
      seenImg.add(key);
      edges.push({
        provider: m.backend,
        providerLabel: `${m.backend} (image)`,
        model: m.model,
        keyIds: [],
        keyCount: 0,
        capability: modelCapability.classifyCapability(m.model, { source: 'image' }),
        tier: modelTier.resolveTier(m.model),
        status: 'active', // backendStatus() already gated on required env
        connectionMode: 'direct',
        isDefault: false,
        source: 'image',
        supportsEdit: Boolean(m.supportsEdit),
      });
    }
    sources.imageBackends = seenImg.size;
  } catch { /* image service optional */ }

  // ── 3. Video models (OUTSIDE the provider registry) ──
  try {
    const videoModels = videoGenService.catalogModels() || [];
    const seenVid = new Set();
    for (const m of videoModels) {
      const key = `${m.backend}:${m.model}`;
      if (seenVid.has(key)) continue;
      seenVid.add(key);
      edges.push({
        provider: m.backend,
        providerLabel: `${m.backend} (video)`,
        model: m.model,
        keyIds: [],
        keyCount: 0,
        capability: modelCapability.classifyCapability(m.model, { source: 'video' }),
        tier: modelTier.resolveTier(m.model),
        status: 'active',
        connectionMode: 'direct',
        isDefault: false,
        source: 'video',
      });
    }
    sources.videoBackends = seenVid.size;
  } catch { /* video service optional */ }

  // ── 4. Local models served by a running Ollama instance (OUTSIDE the registry) ──
  // Wires the localOllamaProbe leaf (previously zero production consumers) into the
  // authoritative catalog. Gate KHY_LOCAL_MODEL_CATALOG default-on AND `live`: local
  // models are only knowable by probing a running server, so they belong in the opt-in
  // live-discovery path (never on the fast static path). The probe is never-throw +
  // non-blocking (empty list when Ollama is not running / installed / times out), so
  // gate-off, non-live, or no-Ollama all collapse to a byte-identical edge list.
  if (live && _localModelCatalogEnabled()) {
    try {
      const { fetchLocalModels } = require('./localOllamaProbe');
      const probe = await fetchLocalModels();
      if (probe && probe.running && Array.isArray(probe.models)) {
        const seenLocal = new Set();
        for (const m of probe.models) {
          const model = m && m.id;
          if (!model || seenLocal.has(model)) continue;
          seenLocal.add(model);
          edges.push({
            provider: 'ollama',
            providerLabel: 'ollama (local)',
            model,
            keyIds: [],
            keyCount: 0,
            capability: modelCapability.classifyCapability(model),
            tier: modelTier.resolveTier(model),
            status: 'active', // the server answered → the model is reachable
            connectionMode: 'direct',
            isDefault: false,
            source: 'local',
          });
        }
        sources.localModels = seenLocal.size;
      }
    } catch { /* local probe optional; never breaks catalog assembly */ }
  }

  return { edges, generatedAt: Date.now(), sources };
}

module.exports = {
  buildCatalogGraph,
  // test hooks
  __testHooks: { _parseJsonMapEnv, _providerKeyStatus },
};
