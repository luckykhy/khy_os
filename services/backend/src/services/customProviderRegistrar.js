/**
 * customProviderRegistrar — single source of truth for registering an
 * OpenAI-compatible custom Provider (key pool + metadata + env routing).
 *
 * Both the CLI (`cli/handlers/gateway.js _addCustomProviderInteractive`) and the
 * runtime admin API (`aiManagementServer.js` custom-provider routes) call
 * `registerCustomProvider()` so the registration behaviour stays identical
 * regardless of entry point. The function is pure/non-interactive: callers
 * collect input (prompts or HTTP body), this module performs the side effects.
 *
 * Side effects, mirroring the original inline CLI flow:
 *   1. add API key(s) to the pool (apiKeyPool)
 *   2. persist provider metadata (customProviderRegistry → custom_providers.json)
 *   3. merge env routing maps (GATEWAY_API_POOL_SERVICE_MAP /
 *      GATEWAY_API_POOL_DEFAULT_MODEL_MAP / PROXY_MODEL_ROUTE_MAP) into
 *      process.env AND persist to .env
 *   4. (optional) when an explicit tier is given, merge KHY_MODEL_TIER_MAP so
 *      modelTier.resolveTier honours it for every model of this provider
 */
'use strict';

const pool = require('./apiKeyPool');
const customRegistry = require('./customProviderRegistry');
const { parseApiKeyEntries } = require('./apiKeyFormat');
const { mergeJsonEnvVar, removeJsonEnvVarKey } = require('./gatewayEnvFile');
const { getProviderPresets } = require('./gateway/providerPresets');

const VALID_TIERS = ['T0', 'T1', 'T2', 'T3'];
const POOL_KEY_RE = /^[a-z0-9][-a-z0-9]*$/;

// Wire-format services a pool key may map to in GATEWAY_API_POOL_SERVICE_MAP.
// Mirrors the switch in multiFreeService.callProvider so registerCustomProvider
// can register non-OpenAI-wire providers (e.g. a local reverse proxy exposing an
// Anthropic-compatible /v1/messages line) without a second registration path.
// Default stays 'openai' → every existing caller is byte-identical.
const VALID_SERVICES = Object.freeze([
  'openai', 'anthropic', 'zhipu', 'google', 'groq', 'openrouter',
  'trae', 'xunfei', 'baidu', 'alibaba', 'huggingface',
]);

/**
 * Built-in presets surfaced to the CLI and Web UI so common providers can be
 * configured without hand-typing base URLs / model IDs.
 *
 * Single source of truth: derived from the shared providerPresets registry.
 * registerCustomProvider() registers an OpenAI-compatible provider (service map
 * is hardcoded 'openai'), so only `apiFormat: 'openai'` presets are surfaced
 * here — anthropic/gemini presets would be mislabelled if registered this way.
 * The richer multi-protocol list lives on the per-user gateway plane.
 *
 * tier: '' means automatic classification (modelTier regex). A non-empty tier
 * is only a *suggested default* for the form — the user still decides.
 */
function getPresets() {
  return getProviderPresets()
    .filter(p => p.apiFormat === 'openai')
    .map(p => ({
      id: p.id,
      name: p.label,
      endpoint: p.baseUrl,
      defaultModel: p.defaultModel,
      models: p.models.slice(),
      tier: p.tier,
      keyExample: p.keyExample || '',
    }));
}

/**
 * Normalise / validate the requested pool key.
 * @returns {string} normalised key
 * @throws {Error} on invalid or built-in collision
 */
function normalizePoolKey(rawPoolKey) {
  const key = String(rawPoolKey || '').trim().toLowerCase();
  if (!key || !POOL_KEY_RE.test(key)) {
    throw new Error('Provider ID 只允许小写字母、数字和连字符，且需以字母或数字开头');
  }
  if (customRegistry.isBuiltinPoolKey(key)) {
    throw new Error(`"${key}" 是内置 provider，不能作为自定义名称`);
  }
  return key;
}

function normalizeTier(rawTier) {
  const tier = String(rawTier || '').trim().toUpperCase();
  if (!tier) return '';
  if (!VALID_TIERS.includes(tier)) {
    throw new Error(`无效的 tier: ${tier}（可选 ${VALID_TIERS.join('/')} 或留空）`);
  }
  return tier;
}

function buildModelList(defaultModel, extraModels) {
  const dm = String(defaultModel || '').trim();
  if (!dm) throw new Error('默认模型 ID 不能为空');
  const models = [dm];
  if (extraModels) {
    const extras = Array.isArray(extraModels)
      ? extraModels
      : String(extraModels).split(',');
    for (const m of extras.map(s => String(s).trim()).filter(Boolean)) {
      if (!models.includes(m)) models.push(m);
    }
  }
  return models;
}

/**
 * Register (or update) an OpenAI-compatible custom provider.
 *
 * @param {object} input
 * @param {string} input.displayName  human-readable name (e.g. "Agnes AI")
 * @param {string} input.poolKey      internal id (lowercase, [-a-z0-9])
 * @param {string} input.endpoint     base URL (e.g. https://apihub.agnes-ai.com/v1)
 * @param {string} input.keyInput     raw API key string (one or many, parseApiKeyEntries format)
 * @param {string} input.defaultModel default model id
 * @param {string|string[]} [input.extraModels] extra model ids (comma string or array)
 * @param {string} [input.tier]       optional capability tier override (T0-T3); '' = auto
 * @param {string} [input.service]    wire-format service for the pool key (default 'openai';
 *                                    must be one of VALID_SERVICES, e.g. 'anthropic')
 * @param {boolean} [input.ensureInit] when true, call pool.init() first (HTTP entry)
 * @returns {{poolKey:string, displayName:string, endpoint:string, defaultModel:string,
 *            models:string[], keyCount:number, tier:string, service:string}}
 */
function registerCustomProvider(input = {}) {
  const displayName = String(input.displayName || '').trim();
  if (!displayName) throw new Error('Provider 显示名称不能为空');

  const poolKey = normalizePoolKey(input.poolKey);

  const service = String(input.service || 'openai').trim().toLowerCase();
  if (!VALID_SERVICES.includes(service)) {
    throw new Error(`无效的 service: ${input.service}（可选 ${VALID_SERVICES.join('/')}）`);
  }

  const endpoint = String(input.endpoint || '').trim().replace(/\/+$/, '');
  if (!endpoint) throw new Error('Base URL 不能为空');
  try { new URL(endpoint); } catch { throw new Error(`Base URL 无效: ${input.endpoint}`); }

  const defaultModel = String(input.defaultModel || '').trim();
  const models = buildModelList(defaultModel, input.extraModels);
  const tier = normalizeTier(input.tier);

  if (input.ensureInit) {
    try { pool.init(); } catch { /* already initialised */ }
  }

  // 1. add key(s) to the pool
  const parsedEntries = parseApiKeyEntries(input.keyInput, { endpoint, priority: 10 });
  if (parsedEntries.length === 0) {
    throw new Error('未解析到有效 API Key');
  }
  for (const entry of parsedEntries) {
    try {
      pool.addKey(poolKey, entry);
    } catch (e) {
      // Duplicate keys are tolerated (idempotent re-register); rethrow others.
      if (!/already exists/i.test(String(e && e.message))) throw e;
    }
  }

  // 2. persist provider metadata
  customRegistry.saveProvider({
    name: displayName,
    poolKey,
    endpoint,
    defaultModel,
    models,
    ...(tier ? { tier } : {}),
  });

  // 3. env routing maps (process.env + .env)
  mergeJsonEnvVar('GATEWAY_API_POOL_SERVICE_MAP', { [poolKey]: service });
  mergeJsonEnvVar('GATEWAY_API_POOL_DEFAULT_MODEL_MAP', { [poolKey]: defaultModel });

  const routeEntries = {};
  for (const m of models) {
    routeEntries[m] = { target: `api:${poolKey}:${m}`, strict: true };
  }
  mergeJsonEnvVar('PROXY_MODEL_ROUTE_MAP', routeEntries);

  // 4. optional per-model tier override
  if (tier) {
    const tierEntries = {};
    for (const m of models) tierEntries[m] = tier;
    mergeJsonEnvVar('KHY_MODEL_TIER_MAP', tierEntries);
  }

  return {
    poolKey,
    displayName,
    endpoint,
    defaultModel,
    models,
    keyCount: parsedEntries.length,
    tier,
    service,
    firstKey: parsedEntries[0].key, // for the optional connection test
  };
}

/**
 * Remove a custom provider's metadata and env routing entries.
 * The pool key (and its stored API keys) are kept by default so they can be
 * reused; pass removeKeys=true to also drop the pool key.
 *
 * @returns {{removed:boolean, poolKey:string, keptKeys:boolean}}
 */
function unregisterCustomProvider(rawPoolKey, options = {}) {
  const poolKey = String(rawPoolKey || '').trim().toLowerCase();
  if (!poolKey) throw new Error('poolKey 不能为空');
  if (customRegistry.isBuiltinPoolKey(poolKey)) {
    throw new Error(`"${poolKey}" 是内置 provider，不能删除`);
  }

  const provider = customRegistry.getProvider(poolKey);
  const models = provider && Array.isArray(provider.models) ? provider.models : [];

  const removed = customRegistry.removeProvider(poolKey);

  // Strip env routing entries for this provider.
  removeJsonEnvVarKey('GATEWAY_API_POOL_SERVICE_MAP', poolKey);
  removeJsonEnvVarKey('GATEWAY_API_POOL_DEFAULT_MODEL_MAP', poolKey);
  for (const m of models) {
    removeJsonEnvVarKey('PROXY_MODEL_ROUTE_MAP', m);
    removeJsonEnvVarKey('KHY_MODEL_TIER_MAP', m);
  }

  let keptKeys = true;
  if (options.removeKeys) {
    try {
      if (typeof pool.removeProvider === 'function') {
        pool.removeProvider(poolKey);
        keptKeys = false;
      }
    } catch { /* best effort */ }
  }

  return { removed, poolKey, keptKeys };
}

// ── Built-in SenseNova (日日新) provider ──────────────────────────────────────
// A zero-config cloud channel shipped with KHY-OS. Seeded by `khy init` and,
// idempotently, at gateway / management-server startup (so it appears even when
// the user never ran the wizard, and on fresh machines). The trial key below is
// the shared built-in credential; remote /v1/models discovery (apiAdapter)
// overrides `models` when reachable — this list is only the offline fallback.
const BUILTIN_SENSENOVA = Object.freeze({
  poolKey: 'sensenova',
  displayName: 'SenseNova',
  endpoint: 'https://token.sensenova.cn/v1',
  key: process.env.KHY_BUILTIN_SENSENOVA_KEY || 'sk-VGIvz88JG36VuWGRnvjJrtT8tMv8mgUc',
  defaultModel: 'sensenova-6.7-flash-lite',
  // Token Plan 实际可用于对话的模型：flash-lite 与转售的 deepseek-v4-flash，二者均**纯文本**
  // (实测 flash-lite 不收图像输入)。带图请求会由 decideVisionRouting 退回本地 OCR(见 visionCapability)。
  // 刻意不列 `sensenova-6.7-flash-image`(不存在) 与 `sensenova-u1-fast`(信息图生成，走独立的
  // /v1/images/generations 端点、不能当通用 chat 模型，列入会诱发 404)。
  // 远端 /v1/models discovery 可达时会覆盖本列表；这里仅作离线兜底。
  models: ['sensenova-6.7-flash-lite', 'deepseek-v4-flash'],
});

/**
 * Ensure the built-in SenseNova provider exists. Idempotent: when the pool
 * already holds a sensenova key and the registry already lists every built-in
 * model, this is a no-op fast-path. Otherwise it (re)registers via the shared
 * registerCustomProvider() so key/metadata/env-routing stay in one place, while
 * preserving any user-added models already on the registry.
 *
 * @param {{force?: boolean}} [options]
 * @returns {{seeded: boolean, poolKey: string}}
 */
function ensureBuiltinSenseNova(options = {}) {
  const force = !!options.force;
  try { pool.init(); } catch { /* already initialised */ }

  const hasKey = (pool.getPoolStatus(BUILTIN_SENSENOVA.poolKey) || []).length > 0;
  const provider = customRegistry.getProvider(BUILTIN_SENSENOVA.poolKey);
  const existingModels = provider && Array.isArray(provider.models) ? provider.models : [];
  const haveAllModels = BUILTIN_SENSENOVA.models.every(m => existingModels.includes(m));

  if (!force && hasKey && haveAllModels) {
    return { seeded: false, poolKey: BUILTIN_SENSENOVA.poolKey };
  }

  // Union of built-in models and any user-added ones (minus the default, which
  // registerCustomProvider prepends), so seeding never drops manual additions.
  const extraModels = [];
  for (const m of [...existingModels, ...BUILTIN_SENSENOVA.models]) {
    if (m && m !== BUILTIN_SENSENOVA.defaultModel && !extraModels.includes(m)) {
      extraModels.push(m);
    }
  }

  registerCustomProvider({
    displayName: BUILTIN_SENSENOVA.displayName,
    poolKey: BUILTIN_SENSENOVA.poolKey,
    endpoint: BUILTIN_SENSENOVA.endpoint,
    keyInput: BUILTIN_SENSENOVA.key,
    defaultModel: BUILTIN_SENSENOVA.defaultModel,
    extraModels,
    ensureInit: true,
  });
  return { seeded: true, poolKey: BUILTIN_SENSENOVA.poolKey };
}

// ── Built-in Qoder reverse-proxy provider (opt-in) ───────────────────────────
// qoder-proxy is a LOCAL HTTP proxy (default http://127.0.0.1:3000) wrapping the
// qoderclicn/qodercli CLI, exposing BOTH an OpenAI-compatible line
// (/v1/chat/completions) and an Anthropic-compatible line (/v1/messages). We seed
// it as TWO custom providers — `qoder` (openai wire) and `qoder-anthropic`
// (anthropic wire) — sharing one local root.
//
// STRICT opt-in: the proxy runs on the user's machine, so when 127.0.0.1:3000 is
// not up every seeded model becomes a dead ECONNREFUSED entry in every user's
// /model picker (same class of bug as the built-in GLM placeholder key). Therefore
// we only seed when the user opts in via QODER_PROXY_ENDPOINT / QODER_PROXY_API_KEY
// or KHY_QODER_PROXY=true (qoderProxyModels.qoderOptedIn). Endpoints are derived
// from a single root so the anthropic line stays bare (no /v1) — callAnthropic
// appends /v1/messages and would otherwise produce /v1/v1/messages.
function ensureBuiltinQoder(options = {}) {
  try {
    const env = options.env || process.env;
    const qoder = require('./gateway/qoderProxyModels');

    // opt-in gate: no-op unless the user explicitly enabled qoder.
    if (!options.force && !qoder.qoderOptedIn(env)) {
      return { seeded: false, reason: 'not-opted-in', pools: [] };
    }

    try { pool.init(); } catch { /* already initialised */ }

    const specs = qoder.qoderProxySpecs(env);
    const seededPools = [];
    for (const spec of specs) {
      try {
        // Idempotent fast-path: pool already keyed AND registry lists every model.
        const hasKey = (pool.getPoolStatus(spec.poolKey) || []).length > 0;
        const provider = customRegistry.getProvider(spec.poolKey);
        const existingModels = provider && Array.isArray(provider.models) ? provider.models : [];
        const haveAllModels = spec.models.every((m) => existingModels.includes(m));
        if (!options.force && hasKey && haveAllModels) {
          seededPools.push(spec.poolKey);
          continue;
        }

        // Union existing + built-in models (minus default, which registerCustomProvider
        // prepends) so re-seeding never drops user-added models.
        const extraModels = [];
        for (const m of [...existingModels, ...spec.models]) {
          if (m && m !== spec.defaultModel && !extraModels.includes(m)) {
            extraModels.push(m);
          }
        }

        registerCustomProvider({
          displayName: spec.displayName,
          poolKey: spec.poolKey,
          endpoint: spec.endpoint,
          keyInput: spec.key,
          defaultModel: spec.defaultModel,
          extraModels,
          service: spec.service,
          ensureInit: true,
        });
        seededPools.push(spec.poolKey);
      } catch { /* one line failing must not block the other */ }
    }

    return { seeded: seededPools.length > 0, pools: seededPools };
  } catch {
    // Never let opt-in seeding throw at a startup call site.
    return { seeded: false, reason: 'error', pools: [] };
  }
}

/**
 * Replace ALL keys of an already-registered custom provider with a new key (or
 * keys). Provider metadata and env routing are left untouched — only the pool's
 * key set for this poolKey is swapped. New keys are added first, then the
 * pre-existing ones removed, so a parse/add failure never leaves the provider
 * keyless.
 *
 * @param {string} rawPoolKey
 * @param {string} newKeyInput  raw API key string (parseApiKeyEntries format)
 * @returns {{poolKey:string, keyCount:number}}
 */
function replaceProviderKeys(rawPoolKey, newKeyInput) {
  const poolKey = String(rawPoolKey || '').trim().toLowerCase();
  if (!poolKey) throw new Error('poolKey 不能为空');

  const provider = customRegistry.getProvider(poolKey);
  if (!provider) throw new Error(`自定义 provider "${poolKey}" 未注册`);

  try { pool.init(); } catch { /* already initialised */ }

  const endpoint = String(provider.endpoint || '').trim().replace(/\/+$/, '');
  const parsedEntries = parseApiKeyEntries(newKeyInput, { endpoint, priority: 10 });
  if (parsedEntries.length === 0) {
    throw new Error('未解析到有效 API Key');
  }

  // Snapshot the existing key ids BEFORE adding new ones, so we only remove the
  // old set even when a new key happens to duplicate an old one.
  const oldKeyIds = (pool.getPoolStatus(poolKey) || []).map((e) => e.keyId);

  let added = 0;
  for (const entry of parsedEntries) {
    try {
      pool.addKey(poolKey, entry);
      added += 1;
    } catch (e) {
      if (!/already exists/i.test(String(e && e.message))) throw e;
    }
  }

  for (const keyId of oldKeyIds) {
    try { pool.removeKey(poolKey, keyId); } catch { /* best effort */ }
  }

  const keyCount = (pool.getPoolStatus(poolKey) || []).length;
  return { poolKey, keyCount, added };
}

module.exports = {
  getPresets,
  registerCustomProvider,
  unregisterCustomProvider,
  replaceProviderKeys,
  normalizePoolKey,
  normalizeTier,
  VALID_TIERS,
  VALID_SERVICES,
  BUILTIN_SENSENOVA,
  ensureBuiltinSenseNova,
  ensureBuiltinQoder,
};
