'use strict';

/**
 * aiManagementServer 的「AI 网关管理平面」子系统(从上帝文件抽出)。
 *
 * 承载 REST 管理面的全部处理器,均经宿主 routeRequest 分派、多数经本叶子内部
 * handleAiGatewayNamespace 子分派器扇出(故 ~75 处内部调用无需注入):
 *  - 网关模型/适配器配置:自定义 provider、模型覆盖/校验、Claude Code 模型槽、
 *    识图模型、Relay/Codex 上游配置、OAuth 凭据/看护、TLS 边车、插件增删改校验。
 *  - 资产/客户/支付/账号:资产总览、客户与令牌、支付、账号池增删改与调度/熔断。
 *  - 依赖管理 + 统一管理平面(khy manage / Web SystemManagement)。
 *
 * **可变态私有于本叶子**:_autoImportLastAt / _autoImportSummary /
 * _lastGatewayAssetsSnapshot(自动导入节流 + 资产快照缓存)——宿主不触碰,故可无环抽出。
 *
 * **反向边经依赖注入打破**:处理器体调宿主的响应工具(sendJson/sendError/parseBody/
 * corsHeaders)、§5 认证(authenticateRequest/requireManagerAccess)、§4 网关缓存
 * (cachedGatewayPayload/writeGatewayCache/invalidateGatewayCache)、§2 懒加载单例 getter
 * (getGateway/getAccountPool/…)、网关配置工具(applyGatewayConfigPatch/getGatewayConfigSnapshot)
 * 及若干纯工具(parseBooleanLike/sanitizePluginName/getPluginFilePath/账号熔断读写/handleListModels)。
 * 宿主加载时调一次 setGatewayAdminDeps 注入;被迁函数体仍按**同名**引用,故字节不变。
 * 注入目标全为宿主**函数声明**(提升)→ 加载期钉接无 TDZ。
 *
 * **刻意非纯零 IO 叶子**:懒加载各网关子系统、读写 DB / 文件 / OAuth 凭据。放置为
 * aiManagementServer.js 的**同目录兄弟**以保懒 require 相对路径字节不变。宿主对
 * routeRequest 直接分派的 8 个处理器(handleAiGatewayNamespace 等)按**同名 re-import** 接回。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { parseApiKeyEntries } = require('./apiKeyFormat');
const { resolveAnthropicBaseUrl } = require('../utils/proxyBaseUrl');

// 随簇迁入的模块常量(与宿主副本同值;宿主 _GATEWAY_CACHE_PREFIX 仍被 §4 使用故双持无害)。
const AUTO_IMPORT_INTERVAL_MS = Math.max(
  15000,
  parseInt(process.env.AI_GATEWAY_AUTO_IMPORT_INTERVAL_MS || '60000', 10) || 60000
);
const AUTO_IMPORT_ACCOUNT_PROVIDERS = ['kiro', 'cursor', 'trae', 'windsurf', 'warp', 'nirvana'];

const DEFAULT_PLUGIN_TEMPLATE = `/**
 * Gateway Plugin Template
 * Hooks: onBeforeRequest, onAfterResponse, onError, onStream
 */
module.exports = {
  name: 'my-plugin',
  priority: 100,
  enabled: true,
  hooks: {
    async onBeforeRequest(ctx, next) {
      return next(ctx);
    },
    async onAfterResponse(ctx, next) {
      return next(ctx);
    },
    async onError(ctx, next) {
      return next(ctx);
    },
    onStream(chunk) {
      return chunk;
    },
  },
};
`;
const _GATEWAY_CACHE_PREFIX = 'aigw:';

// 随簇迁入的私有可变态(自动导入节流 + 资产快照缓存),仅本叶子读写。
let _autoImportLastAt = 0;
let _autoImportSummary = null;
let _lastGatewayAssetsSnapshot = null;

// 宿主注入的反向边(响应/认证/缓存/懒加载 getter/网关配置工具),加载时由 setGatewayAdminDeps 注入一次。
let applyGatewayConfigPatch = null;
let authenticateRequest = null;
let cachedGatewayPayload = null;
let corsHeaders = null;
let invalidateGatewayCache = null;
let writeGatewayCache = null;
let parseBody = null;
let sendError = null;
let sendJson = null;
let requireManagerAccess = null;
let parseBooleanLike = null;
let getGatewayConfigSnapshot = null;
let handleListModels = null;
let readAccountCircuitBreakerConfig = null;
let saveAccountCircuitBreakerConfig = null;
let getPluginFilePath = null;
let sanitizePluginName = null;
let getAccountPool = null;
let getAiMonitor = null;
let getApiKeyPool = null;
let getConcurrencySlots = null;
let getCustomerRegistry = null;
let getGateway = null;
let getModelRouter = null;
let getOauthManager = null;
let getPaymentGatewayService = null;
let getPluginChain = null;
let getProtocolConverter = null;
let getProxyServer = null;
let getTlsSidecar = null;
function setGatewayAdminDeps(deps = {}) {
  if (typeof deps.applyGatewayConfigPatch === 'function') applyGatewayConfigPatch = deps.applyGatewayConfigPatch;
  if (typeof deps.authenticateRequest === 'function') authenticateRequest = deps.authenticateRequest;
  if (typeof deps.cachedGatewayPayload === 'function') cachedGatewayPayload = deps.cachedGatewayPayload;
  if (typeof deps.corsHeaders === 'function') corsHeaders = deps.corsHeaders;
  if (typeof deps.invalidateGatewayCache === 'function') invalidateGatewayCache = deps.invalidateGatewayCache;
  if (typeof deps.writeGatewayCache === 'function') writeGatewayCache = deps.writeGatewayCache;
  if (typeof deps.parseBody === 'function') parseBody = deps.parseBody;
  if (typeof deps.sendError === 'function') sendError = deps.sendError;
  if (typeof deps.sendJson === 'function') sendJson = deps.sendJson;
  if (typeof deps.requireManagerAccess === 'function') requireManagerAccess = deps.requireManagerAccess;
  if (typeof deps.parseBooleanLike === 'function') parseBooleanLike = deps.parseBooleanLike;
  if (typeof deps.getGatewayConfigSnapshot === 'function') getGatewayConfigSnapshot = deps.getGatewayConfigSnapshot;
  if (typeof deps.handleListModels === 'function') handleListModels = deps.handleListModels;
  if (typeof deps.readAccountCircuitBreakerConfig === 'function') readAccountCircuitBreakerConfig = deps.readAccountCircuitBreakerConfig;
  if (typeof deps.saveAccountCircuitBreakerConfig === 'function') saveAccountCircuitBreakerConfig = deps.saveAccountCircuitBreakerConfig;
  if (typeof deps.getPluginFilePath === 'function') getPluginFilePath = deps.getPluginFilePath;
  if (typeof deps.sanitizePluginName === 'function') sanitizePluginName = deps.sanitizePluginName;
  if (typeof deps.getAccountPool === 'function') getAccountPool = deps.getAccountPool;
  if (typeof deps.getAiMonitor === 'function') getAiMonitor = deps.getAiMonitor;
  if (typeof deps.getApiKeyPool === 'function') getApiKeyPool = deps.getApiKeyPool;
  if (typeof deps.getConcurrencySlots === 'function') getConcurrencySlots = deps.getConcurrencySlots;
  if (typeof deps.getCustomerRegistry === 'function') getCustomerRegistry = deps.getCustomerRegistry;
  if (typeof deps.getGateway === 'function') getGateway = deps.getGateway;
  if (typeof deps.getModelRouter === 'function') getModelRouter = deps.getModelRouter;
  if (typeof deps.getOauthManager === 'function') getOauthManager = deps.getOauthManager;
  if (typeof deps.getPaymentGatewayService === 'function') getPaymentGatewayService = deps.getPaymentGatewayService;
  if (typeof deps.getPluginChain === 'function') getPluginChain = deps.getPluginChain;
  if (typeof deps.getProtocolConverter === 'function') getProtocolConverter = deps.getProtocolConverter;
  if (typeof deps.getProxyServer === 'function') getProxyServer = deps.getProxyServer;
  if (typeof deps.getTlsSidecar === 'function') getTlsSidecar = deps.getTlsSidecar;
}

function validatePluginCode(code) {
  try {
    const vm = require('vm');
    new vm.Script(String(code || ''), { filename: 'plugin.js' });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

function toGatewayModelId(adapterKey, rawModelId) {
  const prefixMap = getModelRouter().DEFAULT_ADAPTER_TO_PREFIX || {};
  const prefix = prefixMap[adapterKey] || adapterKey;
  const modelId = String(rawModelId || '').trim();
  if (!modelId) return '';
  if (modelId.startsWith(`${prefix}/`)) return modelId;
  return `${prefix}/${modelId}`;
}

function parseProviderFromModelId(modelId) {
  const m = String(modelId || '').trim().toLowerCase().match(/^([a-z0-9_-]+)[/:](.+)$/);
  return m ? m[1] : '';
}

async function runAutoImportIfNeeded() {
  if (String(process.env.AI_GATEWAY_AUTO_IMPORT || 'true').toLowerCase() === 'false') {
    return _autoImportSummary;
  }

  const now = Date.now();
  if (_autoImportSummary && (now - _autoImportLastAt) < AUTO_IMPORT_INTERVAL_MS) {
    return _autoImportSummary;
  }

  const summary = {
    at: new Date(now).toISOString(),
    providers: [],
  };

  try {
    const accountPool = getAccountPool();
    await accountPool.init();
    for (const provider of AUTO_IMPORT_ACCOUNT_PROVIDERS) {
      try {
        const imported = await accountPool.importProviderTokens(provider, { activateIfNone: true });
        summary.providers.push({
          provider,
          found: imported?.found || 0,
          inserted: imported?.inserted || 0,
          updated: imported?.updated || 0,
          activated: imported?.activated || null,
        });
      } catch (err) {
        summary.providers.push({
          provider,
          error: err?.message || String(err),
        });
      }
    }
  } catch (err) {
    summary.error = err?.message || String(err);
  }

  _autoImportLastAt = now;
  _autoImportSummary = summary;
  return summary;
}

function ensureAutoSharedCustomerFromSnapshot(gatewayAssets, apiPoolStatus = {}) {
  try {
    const customerRegistry = getCustomerRegistry();
    const discoveredProviders = new Set();

    for (const item of gatewayAssets?.list || []) {
      const provider = parseProviderFromModelId(item?.id || '');
      if (provider) discoveredProviders.add(provider);
    }
    for (const provider of Object.keys(apiPoolStatus || {})) {
      if (provider) discoveredProviders.add(String(provider).toLowerCase());
    }
    for (const row of gatewayAssets?.adapters || []) {
      if (row?.enabled && row?.available && row?.key) {
        discoveredProviders.add(String(row.key).toLowerCase());
      }
    }

    customerRegistry.ensureAutoSharedCustomer({
      modelIds: (gatewayAssets?.list || []).map(item => item.id).filter(Boolean),
      providers: [...discoveredProviders],
    });
  } catch {
    // best-effort auto customer sync
  }
}

async function collectGatewayModelsSnapshot() {
  const gw = getGateway();
  if (!gw._initialized) await gw.init();
  const statuses = gw.getStatus().filter(row => row.enabled !== false);

  const adapters = [];
  const list = [];
  const seen = new Set();

  for (const row of statuses) {
    let models = [];
    let modelError = '';
    if (row.available) {
      try {
        models = await gw.listModels(row.type) || [];
      } catch (err) {
        modelError = err.message || String(err);
      }
    }

    let modelCount = 0;
    for (const model of models) {
      const rawId = String(model?.id || model?.name || '').trim();
      if (!rawId) continue;
      modelCount += 1;

      const canonicalId = toGatewayModelId(row.type, rawId);
      if (!seen.has(canonicalId)) {
        seen.add(canonicalId);
        list.push({
          id: canonicalId,
          name: model?.name || rawId,
          adapter: row.type,
          isDefault: model?.isDefault === true,
        });
      }

      if (row.type === 'trae') {
        const antiId = `antigravity/${rawId}`;
        const nirvanaId = `nirvana/${rawId}`;
        if (!seen.has(antiId)) {
          seen.add(antiId);
          list.push({ id: antiId, name: model?.name || rawId, adapter: row.type, isDefault: false });
        }
        if (!seen.has(nirvanaId)) {
          seen.add(nirvanaId);
          list.push({ id: nirvanaId, name: model?.name || rawId, adapter: row.type, isDefault: false });
        }
      }
    }

    adapters.push({
      key: row.type,
      name: row.name,
      enabled: row.enabled !== false,
      available: row.available !== false,
      modelCount,
      modelError,
    });
  }

  try {
    const discovery = require('./gateway/modelDiscovery').discoverModels();
    for (const id of discovery.models || []) {
      const normalized = String(id || '').trim();
      if (!normalized) continue;
      let guessed = normalized;
      if (!normalized.includes('/')) {
        const looksLocalOllama = normalized.includes(':')
          && /(qwen|llama|mistral|gemma|phi|yi|baichuan|deepseek|qwq|qvq)/i.test(normalized);
        guessed = looksLocalOllama ? `ollama/${normalized}` : `api/${normalized}`;
      }
      if (seen.has(guessed)) continue;
      seen.add(guessed);
      list.push({
        id: guessed,
        name: normalized,
        adapter: 'discovered',
        isDefault: false,
      });
    }
  } catch {
    // Best-effort model discovery
  }

  list.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));

  return {
    enabledAdapters: adapters.length,
    totalModels: list.length,
    adapters,
    list,
  };
}

async function handleAiGatewayStatus(req, res) {
  const gw = getGateway();
  if (!gw._initialized) await gw.init();
  const adapters = gw.getStatus();
  const active = gw.getActiveAdapter();
  sendJson(res, 200, {
    adapters,
    active: active ? { name: active.name, type: active.type } : null,
  });
}

async function handleAiGatewayPool(req, res) {
  const pool = getApiKeyPool();
  pool.init();
  sendJson(res, 200, pool.getAllStatus());
}

/**
 * GET /api/ai-gateway/catalog — the unified model catalog graph (flat edges).
 * Single source for every multi-pivot view; CLI and Web both pivot client-side
 * from this dump so they never drift. ?live=1 enables remote model discovery.
 */
async function handleAiGatewayCatalog(req, res, searchParams) {
  try {
    const live = !!(searchParams && parseBooleanLike(searchParams.get('live'), false));
    const graph = require('./gateway/modelCatalogGraph');
    // ?live=1 is an explicit "discover now" refresh: always compute fresh, and
    // warm the default (non-live) cache so the next page navigation is instant.
    // Default loads are served read-through from cache.
    const cacheKey = `${_GATEWAY_CACHE_PREFIX}catalog`;
    let result;
    if (live) {
      result = await graph.buildCatalogGraph({ live: true });
      await writeGatewayCache(cacheKey, result);
    } else {
      result = await cachedGatewayPayload(cacheKey, () => graph.buildCatalogGraph({ live: false }));
    }
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
  }
}

async function handleAiGatewayPoolAddKey(req, res, provider) {
  const body = await parseBody(req);
  const pool = getApiKeyPool();
  pool.init();
  const defaults = {
    endpoint: body.endpoint || '',
    priority: Number.isFinite(Number(body.priority)) ? Number(body.priority) : 10,
    label: body.label || '',
  };
  const rawKeys = body.keys !== undefined ? body.keys : body.key;
  const entries = parseApiKeyEntries(rawKeys, defaults);
  if (entries.length === 0) return sendError(res, 400, 'key or keys is required');

  let added = 0;
  let skippedDuplicates = 0;
  const errors = [];
  for (const entry of entries) {
    try {
      pool.addKey(provider, entry);
      added += 1;
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (/already exists/i.test(msg)) {
        skippedDuplicates += 1;
      } else {
        errors.push(msg);
      }
    }
  }
  if (added === 0 && errors.length > 0) {
    return sendError(res, 400, errors[0]);
  }
  sendJson(res, 200, { success: true, added, skippedDuplicates, errors });
}

async function handleAiGatewayPoolRemoveKey(req, res, provider, keyId) {
  const pool = getApiKeyPool();
  pool.init();
  pool.removeKey(provider, keyId);
  sendJson(res, 200, { success: true });
}

async function handleAiGatewayPoolUpdateKey(req, res, provider, keyId) {
  const body = await parseBody(req);
  const pool = getApiKeyPool();
  pool.init();
  const entries = pool.getPoolStatus(provider) || [];
  const entry = entries.find(e => e.id === keyId || e.keyId === keyId);
  if (!entry) return sendError(res, 404, `Key ${keyId} not found for provider ${provider}`);
  // 手动更新字段并持久化
  if (body.endpoint !== undefined) entry.endpoint = String(body.endpoint || '').trim();
  if (body.label !== undefined) entry.label = String(body.label || '').trim();
  if (body.priority !== undefined) entry.priority = Number(body.priority) || 0;
  pool.save();
  sendJson(res, 200, { success: true });
}

// ── Custom Providers (OpenAI-compatible) ──
// Shared with the CLI via customProviderRegistrar so registration behaviour is
// identical regardless of entry point (CLI prompts vs. this HTTP body).

async function handleAiGatewayCustomProvidersList(req, res) {
  const customRegistry = require('./customProviderRegistry');
  const registrar = require('./customProviderRegistrar');
  sendJson(res, 200, {
    success: true,
    providers: customRegistry.listProviders(),
    presets: registrar.getPresets(),
  });
}

async function handleAiGatewayCustomProvidersAdd(req, res) {
  const body = await parseBody(req);
  const registrar = require('./customProviderRegistrar');
  try {
    const result = registrar.registerCustomProvider({
      displayName: body.displayName || body.name,
      poolKey: body.poolKey,
      endpoint: body.endpoint || body.baseUrl,
      keyInput: body.keyInput !== undefined ? body.keyInput : (body.keys !== undefined ? body.keys : body.key),
      defaultModel: body.defaultModel,
      extraModels: body.extraModels,
      tier: body.tier,
      ensureInit: true,
    });
    // Never echo the raw API key back to the client.
    const { firstKey, ...safe } = result;
    sendJson(res, 200, { success: true, provider: safe });
  } catch (err) {
    sendError(res, 400, String(err && err.message ? err.message : err));
  }
}

async function handleAiGatewayCustomProvidersRemove(req, res, poolKey, searchParams) {
  const registrar = require('./customProviderRegistrar');
  try {
    const removeKeys = searchParams && String(searchParams.get('removeKeys') || '').toLowerCase() === 'true';
    const result = registrar.unregisterCustomProvider(poolKey, { removeKeys });
    if (!result.removed) return sendError(res, 404, `Custom provider "${poolKey}" not found`);
    sendJson(res, 200, { success: true, ...result });
  } catch (err) {
    sendError(res, 400, String(err && err.message ? err.message : err));
  }
}

async function handleAiGatewayCustomProvidersReplace(req, res, poolKey) {
  const body = await parseBody(req);
  const registrar = require('./customProviderRegistrar');
  try {
    const newKey = body.keyInput !== undefined ? body.keyInput
      : (body.keys !== undefined ? body.keys : body.key);
    const result = registrar.replaceProviderKeys(poolKey, newKey);
    sendJson(res, 200, { success: true, ...result });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    sendError(res, /未注册/.test(msg) ? 404 : 400, msg);
  }
}

// ── Model Curation (per-adapter overrides + verify) ──

async function handleModelOverridesList(req, res) {
  const modelCuration = require('./gateway/modelCuration');
  sendJson(res, 200, { success: true, overrides: modelCuration.getOverrides() });
}

async function handleModelOverridesPut(req, res, adapterKey) {
  const modelCuration = require('./gateway/modelCuration');
  const body = await parseBody(req);
  try {
    // Only forward the recognized fields; unknown keys are ignored by the layer.
    const patch = {};
    for (const field of ['hidden', 'added', 'renamed', 'defaultModel']) {
      if (body && Object.prototype.hasOwnProperty.call(body, field)) patch[field] = body[field];
    }
    const override = modelCuration.setAdapterOverride(adapterKey, patch);
    sendJson(res, 200, { success: true, adapter: adapterKey, override });
  } catch (err) {
    sendError(res, 400, String(err && err.message ? err.message : err));
  }
}

async function handleModelVerify(req, res, adapterKey, searchParams) {
  const gw = getGateway();
  if (!gw._initialized) await gw.init();
  const singleModel = searchParams && searchParams.get('model');
  try {
    let targets;
    if (singleModel) {
      targets = [String(singleModel)];
    } else {
      const modelCuration = require('./gateway/modelCuration');
      const raw = await gw.listModels(adapterKey).catch(() => []);
      targets = modelCuration.applyOverrides(adapterKey, raw || []).map(m => m.id);
    }
    const results = [];
    for (const modelId of targets) {
      const r = await gw.verifyModel(adapterKey, modelId);
      results.push({ id: modelId, ...r });
    }
    sendJson(res, 200, { success: true, adapter: adapterKey, results });
  } catch (err) {
    sendError(res, 400, String(err && err.message ? err.message : err));
  }
}

// ── Claude Code Model Slots ──

const MODEL_SLOT_ENV_KEYS = {
  default: 'ANTHROPIC_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  subagent: 'CLAUDE_CODE_SUBAGENT_MODEL',
};

function _shouldWriteClaudeSettings() {
  // 布尔解析走 parseBoolean 单一真源（base tier）。与 routes/aiGatewayAdmin 的
  // 同名孪生此前逐字节相同却各自内联，收敛后共用单一解析语义，杜绝两处漂移矛盾。
  const _parseBoolean = require('../utils/parseBoolean');
  return _parseBoolean(
    process.env.KHY_ALLOW_WRITE_CLAUDE_SETTINGS
      || process.env.KHY_MANAGE_CLAUDE_SETTINGS,
    false,
    { extended: false },
  );
}

function _readClaudeSettings() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { return {}; }
}

function _writeClaudeSettings(obj) {
  const dir = path.join(os.homedir(), '.claude');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.json');
  const tmp = settingsPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, settingsPath);
}

function _buildModelSlotsSnapshot() {
  const settings = _readClaudeSettings();
  const env = settings.env || {};
  const slots = {};
  for (const [slot, envKey] of Object.entries(MODEL_SLOT_ENV_KEYS)) {
    slots[slot] = { envKey, model: process.env[envKey] || env[envKey] || '' };
  }
  return { slots, baseUrl: resolveAnthropicBaseUrl({ settingsEnv: env }) };
}

async function handleAiGatewayModelSlotsGet(req, res) {
  sendJson(res, 200, { success: true, data: _buildModelSlotsSnapshot() });
}

async function handleAiGatewayModelSlotsPut(req, res) {
  const body = await parseBody(req);
  const updates = {};
  for (const slot of Object.keys(MODEL_SLOT_ENV_KEYS)) {
    if (body[slot] !== undefined) updates[slot] = String(body[slot]).trim();
  }
  if (Object.keys(updates).length === 0) return sendError(res, 400, '至少需要提供一个槽位更新');
  const canWriteClaudeSettings = _shouldWriteClaudeSettings();
  // 1) ~/.claude/settings.json (explicit opt-in only)
  const settings = _readClaudeSettings();
  if (!settings.env || typeof settings.env !== 'object') settings.env = {};
  for (const [slot, model] of Object.entries(updates)) {
    if (canWriteClaudeSettings) settings.env[MODEL_SLOT_ENV_KEYS[slot]] = model;
  }
  if (canWriteClaudeSettings) _writeClaudeSettings(settings);
  // 2) .env + process.env
  let envContent = '';
  const envPath = path.join(__dirname, '../../.env');
  try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch { /* ignore */ }
  for (const [slot, model] of Object.entries(updates)) {
    const envKey = MODEL_SLOT_ENV_KEYS[slot];
    const line = `${envKey}=${model}`;
    const regex = new RegExp(`^${envKey}=.*$`, 'm');
    envContent = regex.test(envContent) ? envContent.replace(regex, line) : (envContent.trimEnd() ? `${envContent.trimEnd()}\n${line}\n` : `${line}\n`);
    process.env[envKey] = model;
  }
  const tmpEnv = envPath + '.tmp';
  fs.writeFileSync(tmpEnv, envContent, 'utf-8');
  fs.renameSync(tmpEnv, envPath);
  sendJson(res, 200, {
    success: true,
    data: _buildModelSlotsSnapshot(),
    meta: {
      claudeSettingsWriteEnabled: canWriteClaudeSettings,
      wroteClaudeSettings: canWriteClaudeSettings,
    },
  });
}

// ── Image-generation model selection ──
// Persisted in the KHY_IMAGE_GEN_* env namespace that imageGenService already
// reads on every call. "auto" = no pinned backend (empty KHY_IMAGE_GEN_BACKEND),
// which makes resolveBackend() auto-detect by its fixed quality order.

const IMAGE_MODEL_ENV_KEYS = {
  openai: 'KHY_IMAGE_GEN_OPENAI_MODEL',
  agnes: 'KHY_IMAGE_GEN_AGNES_MODEL',
  domestic: 'KHY_IMAGE_GEN_DOMESTIC_MODEL',
  // sd_webui has no model env (model is fixed by the local WebUI).
};

function _imageBackendEnv() {
  return String(
    process.env.KHY_IMAGE_GEN_BACKEND || process.env.GATEWAY_IMAGE_GEN_BACKEND || '',
  ).trim().toLowerCase();
}

function _buildImageConfigSnapshot() {
  const imageGenService = require('./imageGenService');
  const backend = _imageBackendEnv();
  const modelKey = IMAGE_MODEL_ENV_KEYS[backend];
  const model = modelKey ? String(process.env[modelKey] || '').trim() : '';
  return {
    current: { backend: backend || 'auto', model },
    options: imageGenService.catalogModels(),
    autoOrder: imageGenService.AUTO_ORDER,
    status: imageGenService.backendStatus(),
  };
}

async function handleAiGatewayImageConfigGet(req, res) {
  sendJson(res, 200, { success: true, data: _buildImageConfigSnapshot() });
}

async function handleAiGatewayImageConfigPut(req, res) {
  const imageGenService = require('./imageGenService');
  const gatewayEnvFile = require('./gatewayEnvFile');
  const body = await parseBody(req);
  const rawBackend = String(body && body.backend != null ? body.backend : '').trim().toLowerCase();
  const rawModel = String(body && body.model != null ? body.model : '').trim();

  // "auto" (or empty) clears the pin; otherwise the backend must be a known id.
  const isAuto = !rawBackend || rawBackend === 'auto';
  if (!isAuto && !imageGenService.AUTO_ORDER.includes(rawBackend)) {
    return sendError(res, 400, `未知的图像后端: ${rawBackend}（可选: ${imageGenService.AUTO_ORDER.join(', ')} 或 auto）`);
  }

  const envMap = {};
  const unsetKeys = [];
  if (isAuto) {
    unsetKeys.push('KHY_IMAGE_GEN_BACKEND');
  } else {
    envMap.KHY_IMAGE_GEN_BACKEND = rawBackend;
    const modelKey = IMAGE_MODEL_ENV_KEYS[rawBackend];
    if (rawModel && modelKey) envMap[modelKey] = rawModel;
  }
  gatewayEnvFile.writeEnvPatch(envMap, unsetKeys);

  sendJson(res, 200, { success: true, data: _buildImageConfigSnapshot() });
}

async function handleAiGatewayMonitorTraces(req, res, searchParams) {
  const monitor = getAiMonitor();
  const filter = {};
  const limit = parseInt(searchParams.get('limit') || '', 10);
  const offset = parseInt(searchParams.get('offset') || '', 10);
  const provider = String(searchParams.get('provider') || '').trim();
  const success = searchParams.get('success');
  const since = String(searchParams.get('since') || '').trim();
  if (Number.isFinite(limit) && limit > 0) filter.limit = limit;
  if (Number.isFinite(offset) && offset >= 0) filter.offset = offset;
  if (provider) filter.provider = provider;
  if (success !== null) filter.success = success === 'true';
  if (since) filter.since = since;
  sendJson(res, 200, monitor.getTraces(filter));
}

async function handleAiGatewayMonitorStats(req, res) {
  sendJson(res, 200, getAiMonitor().getStats());
}

/**
 * GET /api/ai-gateway/monitor/attribution?requestId=…
 *
 * Drill-down endpoint behind the frontend's human-readable failure card: given the
 * requestId stamped on a terminal `error` event, return the server-side staged
 * timeline (model_request → tool_call → tool_result → model_response → delivery)
 * plus which stage broke, so a user can trace from "what to do" all the way to the
 * root cause. Desensitization is enforced inside traceAuditService by projecting on
 * the caller's role (owner/admin/auditor see internal fields; others get summary).
 * An unknown/expired requestId yields a 200 with an empty timeline — never a leak.
 */
async function handleAttributionDetail(req, res, searchParams) {
  const requestId = String(searchParams.get('requestId') || '').trim();
  if (!requestId) {
    return sendJson(res, 400, { ok: false, reason: 'missing_request_id', timeline: [] });
  }
  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    return sendJson(res, 401, { ok: false, reason: 'unauthorized', timeline: [] });
  }
  const role = (auth.user && auth.user.role) || 'user';
  let summary;
  try {
    summary = require('./traceAuditService').getRequestTraceSummary({ requestId, role });
  } catch (err) {
    return sendJson(res, 200, { ok: false, reason: 'trace_unavailable', requestId, timeline: [], error: err.message });
  }
  // ok:false (no session / no events / not found) is a normal "nothing to show"
  // outcome, not an error — answer 200 with an empty timeline so the card degrades
  // gracefully instead of surfacing a scary failure on top of a failure.
  if (!summary || summary.ok !== true) {
    return sendJson(res, 200, {
      ok: false,
      reason: (summary && summary.reason) || 'not_found',
      requestId,
      summary: (summary && summary.summary) || '',
      timeline: [],
    });
  }
  return sendJson(res, 200, summary);
}

function handleAiGatewayMonitorStream(req, res) {
  const monitor = getAiMonitor();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders(),
  });

  const events = monitor.createEventStream();
  const onTrace = (trace) => {
    res.write(`data: ${JSON.stringify(trace)}\n\n`);
  };

  events.on('trace:start', onTrace);
  events.on('trace:end', onTrace);
  events.on('trace:cascade', onTrace);

  req.on('close', () => {
    events.removeListener('trace:start', onTrace);
    events.removeListener('trace:end', onTrace);
    events.removeListener('trace:cascade', onTrace);
  });
}

async function handleAiGatewayOAuthStatus(req, res) {
  const oauth = getOauthManager();
  oauth.init();
  sendJson(res, 200, oauth.getAllStatus());
}

async function handleAiGatewayOAuthRefresh(req, res, provider) {
  const oauth = getOauthManager();
  oauth.init();
  const token = await oauth.refreshToken(provider);
  sendJson(res, 200, { success: !!token, token: token ? '***' : null });
}

async function handleAiGatewayPlugins(req, res) {
  sendJson(res, 200, getPluginChain().list());
}

async function handleAiGatewayTogglePlugin(req, res, name) {
  const body = await parseBody(req);
  const success = getPluginChain().toggle(name, body.enabled !== false);
  sendJson(res, 200, { success });
}

async function handleAiGatewayPluginCode(req, res, name) {
  let pluginPath;
  try {
    pluginPath = getPluginFilePath(name);
  } catch (err) {
    return sendError(res, 400, err.message);
  }
  if (!fs.existsSync(pluginPath)) return sendError(res, 404, 'plugin not found');
  const code = fs.readFileSync(pluginPath, 'utf-8');
  sendJson(res, 200, { code });
}

async function handleAiGatewayCreatePlugin(req, res) {
  const body = await parseBody(req);
  let pluginPath;
  try {
    pluginPath = getPluginFilePath(body.name);
  } catch (err) {
    return sendError(res, 400, err.message);
  }
  if (fs.existsSync(pluginPath)) return sendError(res, 409, 'plugin already exists');
  const code = String(body.code || '').trim();
  if (!code) return sendError(res, 400, 'code is required');
  const valid = validatePluginCode(code);
  if (!valid.valid) return sendError(res, 400, valid.error || 'invalid plugin code');
  fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
  fs.writeFileSync(pluginPath, code, 'utf-8');
  getPluginChain().reload();
  sendJson(res, 200, { success: true, name: sanitizePluginName(body.name) });
}

async function handleAiGatewayUpdatePlugin(req, res, name) {
  const body = await parseBody(req);
  let pluginPath;
  try {
    pluginPath = getPluginFilePath(name);
  } catch (err) {
    return sendError(res, 400, err.message);
  }
  const code = String(body.code || '').trim();
  if (!code) return sendError(res, 400, 'code is required');
  const valid = validatePluginCode(code);
  if (!valid.valid) return sendError(res, 400, valid.error || 'invalid plugin code');
  fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
  fs.writeFileSync(pluginPath, code, 'utf-8');
  getPluginChain().reload();
  sendJson(res, 200, { success: true, name: sanitizePluginName(name) });
}

async function handleAiGatewayDeletePlugin(req, res, name) {
  let pluginPath;
  try {
    pluginPath = getPluginFilePath(name);
  } catch (err) {
    return sendError(res, 400, err.message);
  }
  if (!fs.existsSync(pluginPath)) return sendError(res, 404, 'plugin not found');
  fs.unlinkSync(pluginPath);
  getPluginChain().reload();
  sendJson(res, 200, { success: true });
}

async function handleAiGatewayValidatePlugin(req, res) {
  const body = await parseBody(req);
  sendJson(res, 200, validatePluginCode(String(body.code || '')));
}

async function handleAiGatewayPluginTemplate(req, res) {
  sendJson(res, 200, { code: DEFAULT_PLUGIN_TEMPLATE });
}

async function handleAiGatewayReloadPlugins(req, res) {
  const loaded = getPluginChain().reload();
  sendJson(res, 200, { success: true, loaded });
}

async function handleAiGatewayTlsStatus(req, res) {
  sendJson(res, 200, getTlsSidecar().getStatus());
}

async function handleAiGatewayTlsStart(req, res) {
  const body = await parseBody(req);
  const result = await getTlsSidecar().start(body || {});
  sendJson(res, 200, { success: true, ...result });
}

async function handleAiGatewayTlsStop(req, res) {
  await getTlsSidecar().stop();
  sendJson(res, 200, { success: true });
}

async function handleAiGatewayProtocols(req, res) {
  sendJson(res, 200, { protocols: getProtocolConverter().getSupportedProtocols() });
}

async function handleAiGatewaySlots(req, res) {
  sendJson(res, 200, getConcurrencySlots().getAllStatus());
}

async function handleAiGatewayConfigGet(req, res) {
  sendJson(res, 200, getGatewayConfigSnapshot());
}

async function handleAiGatewayConfigPut(req, res) {
  const body = await parseBody(req);
  const result = applyGatewayConfigPatch(body || {});
  sendJson(res, 200, { updated: result.updated, config: result.config });
}

// ── Model Config (Relay) ─────────────────────────────────────
// The snapshot/mask/write logic lives in the management resource
// (management/resources/modelConfig.resource.js); both handlers below invoke it
// through the single registry funnel so CLI and Web never diverge.

async function handleAiGatewayModelConfigGet(req, res) {
  const registry = require('./management');
  try {
    const data = await registry.invoke('model-config', 'get', {}, { source: 'web' });
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleAiGatewayModelConfigPut(req, res) {
  const body = await parseBody(req);
  const registry = require('./management');
  try {
    // Single funnel: the same managementRegistry op the CLI uses. The op
    // delegates to gatewayEnvFile (canonical + mirror + KHY_ENV_FILE), so the
    // Web admin no longer writes a hardcoded backend/.env behind the CLI's back.
    const result = await registry.invoke('model-config', 'set', {
      baseUrl: body?.baseUrl,
      modelId: body?.modelId,
      compatibility: body?.compatibility,
      apiKey: body?.apiKey,
      clearApiKey: body?.clearApiKey === true,
    }, { source: 'web' });
    sendJson(res, 200, { success: true, data: result });
  } catch (err) {
    const msg = String(err && err.message || '');
    if (/is required/.test(msg)) return sendError(res, 400, msg);
    sendError(res, 500, msg);
  }
}

// ── Codex upstream provider config ─────────────────────────────────────────
// Lets the admin point the codex CLI at ANY OpenAI-compatible upstream (not
// only the value that happens to be in config.toml today) by writing
// ~/.codex/config.toml + auth.json via the codex adapter. Mirrors the relay
// model-config flow above but targets codex instead of the relay_api adapter.

function _getCodexAdapter() {
  // Lazy require: the adapter pulls in gateway internals we don't want to load
  // unless the codex-config endpoints are actually hit.
  return require('./gateway/adapters/codexAdapter');
}

async function handleAiGatewayCodexConfigGet(req, res) {
  try {
    const codex = _getCodexAdapter();
    const snapshot = typeof codex.getCodexUpstreamSnapshot === 'function'
      ? codex.getCodexUpstreamSnapshot()
      : {};
    const preferredAdapter = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim();
    sendJson(res, 200, { success: true, data: { ...snapshot, active: preferredAdapter.toLowerCase() === 'codex', preferredAdapter } });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleAiGatewayCodexConfigPut(req, res) {
  const body = await parseBody(req);
  const providerName = String(body?.providerName || '').trim();
  const baseUrl = String(body?.baseUrl || '').trim();
  const model = String(body?.model || '').trim();
  if (!providerName) return sendError(res, 400, 'providerName is required');
  if (!baseUrl) return sendError(res, 400, 'baseUrl is required');
  if (!model) return sendError(res, 400, 'model is required');

  try {
    const codex = _getCodexAdapter();
    if (typeof codex.setCodexUpstream !== 'function') {
      return sendError(res, 500, 'codex adapter does not support upstream configuration');
    }
    const apiKeyInput = String(body?.apiKey || '').trim();
    const written = codex.setCodexUpstream({
      providerName,
      baseUrl,
      model,
      reasoningEffort: body?.reasoningEffort,
      wireApi: body?.wireApi,
      // Only pass apiKey when provided — omitting keeps the existing auth.json key.
      ...(apiKeyInput ? { apiKey: apiKeyInput } : {}),
    });

    // Optionally make codex the preferred gateway adapter (env patch, mirrors
    // the relay model-config path) when the caller asks to activate it.
    let activated = false;
    if (body?.activate === true) {
      const envPath = path.resolve(__dirname, '../../.env');
      let envContent = '';
      try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch { /* no .env */ }
      const envMap = {
        GATEWAY_PREFERRED_ADAPTER: 'codex',
        GATEWAY_PREFERRED_MODEL: model,
      };
      for (const [key, value] of Object.entries(envMap)) {
        const regex = new RegExp(`^${key}=.*$`, 'm');
        const line = `${key}=${value}`;
        if (regex.test(envContent)) envContent = envContent.replace(regex, line);
        else envContent = envContent.trimEnd() + '\n' + line + '\n';
        process.env[key] = String(value);
      }
      const tmpPath = envPath + '.tmp.' + process.pid;
      fs.writeFileSync(tmpPath, envContent, 'utf-8');
      fs.renameSync(tmpPath, envPath);
      activated = true;
    }

    const snapshot = typeof codex.getCodexUpstreamSnapshot === 'function'
      ? codex.getCodexUpstreamSnapshot()
      : {};
    sendJson(res, 200, {
      success: true,
      data: {
        updated: true,
        activated,
        written: { provider: written.provider, baseUrl: written.baseUrl, model: written.model, wireApi: written.wireApi, configPath: written.configPath },
        config: { ...snapshot, active: String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim().toLowerCase() === 'codex' },
      },
    });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleAiGatewayOAuthProviders(req, res) {
  try {
    const oauthMgr = getOauthManager();
    const providers = oauthMgr.getProviderCapabilities ? oauthMgr.getProviderCapabilities() : [];
    const status = oauthMgr.getStatus ? oauthMgr.getStatus() : {};
    sendJson(res, 200, { providers, status });
  } catch (err) {
    sendJson(res, 200, { providers: [], status: {} });
  }
}

async function handleAiGatewayOAuthCredentialGet(req, res, provider) {
  try {
    const oauthMgr = getOauthManager();
    const cred = oauthMgr.getCredential ? oauthMgr.getCredential(provider) : null;
    sendJson(res, 200, cred || {});
  } catch {
    sendJson(res, 200, {});
  }
}

async function handleAiGatewayOAuthCredentialPut(req, res, provider) {
  try {
    const body = await parseBody(req);
    const oauthMgr = getOauthManager();
    if (oauthMgr.saveCredential) await oauthMgr.saveCredential(provider, body || {});
    sendJson(res, 200, { success: true });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleAiGatewayOAuthCredentialDelete(req, res, provider) {
  try {
    const oauthMgr = getOauthManager();
    if (oauthMgr.deleteCredential) await oauthMgr.deleteCredential(provider);
    sendJson(res, 200, { success: true });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleAiGatewayCredentialWatcherStatus(req, res) {
  try {
    const pool = getAccountPool();
    const status = pool.getWatcherStatus ? pool.getWatcherStatus() : { running: false };
    sendJson(res, 200, status);
  } catch {
    sendJson(res, 200, { running: false });
  }
}

async function handleAiGatewayCredentialWatcherScan(req, res) {
  try {
    const pool = getAccountPool();
    const result = pool.triggerWatcherScan ? await pool.triggerWatcherScan() : {};
    sendJson(res, 200, result);
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleAiGatewayCredentialWatcherStart(req, res) {
  try {
    const pool = getAccountPool();
    if (pool.startWatcher) pool.startWatcher();
    const status = pool.getWatcherStatus ? pool.getWatcherStatus() : { running: true };
    sendJson(res, 200, { status });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleAiGatewayCredentialWatcherStop(req, res) {
  try {
    const pool = getAccountPool();
    if (pool.stopWatcher) pool.stopWatcher();
    sendJson(res, 200, { success: true });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleAiGatewayAssetsOverview(req, res) {
  const autoImport = await runAutoImportIfNeeded();
  const gatewayAssets = await collectGatewayModelsSnapshot();
  _lastGatewayAssetsSnapshot = gatewayAssets;

  const apiPool = getApiKeyPool();
  apiPool.init();
  const apiPoolStatus = apiPool.getAllStatus();
  let totalKeys = 0;
  for (const rows of Object.values(apiPoolStatus)) {
    totalKeys += Array.isArray(rows) ? rows.length : 0;
  }

  const accountPool = getAccountPool();
  let accountStatus = { totalAccounts: 0 };
  try {
    await accountPool.init();
    accountStatus = await accountPool.getStatus();
  } catch {
    accountStatus = { totalAccounts: 0 };
  }

  const customerRegistry = getCustomerRegistry();
  ensureAutoSharedCustomerFromSnapshot(gatewayAssets, apiPoolStatus);
  const customers = customerRegistry.listCustomers({ includeSecrets: false });
  const customerSummary = customerRegistry.getCustomerSummary(customers);

  const proxy = getProxyServer();
  const proxyRuntime = proxy.getRuntimeStatus();
  const proxyAuth = proxy.getAuthStatus();

  sendJson(res, 200, {
    assets: {
      gateway: gatewayAssets,
      apiKeyPool: {
        totalKeys,
        providers: Object.keys(apiPoolStatus),
      },
      accountPool: {
        totalAccounts: accountStatus.totalAccounts || 0,
        byProvider: accountStatus.byProvider || {},
      },
      customers: customerSummary,
      autoImport: autoImport || null,
      proxy: {
        runtime: proxyRuntime,
        auth: {
          tokenCount: proxyAuth.tokenCount,
          managedTokenCount: proxyAuth.managedTokenCount,
          managedTokenEnabledCount: proxyAuth.managedTokenEnabledCount,
          managedTokens: proxyAuth.managedTokens,
        },
      },
    },
  });
}

async function handleAiGatewayListCustomers(req, res, searchParams) {
  const includeSecrets = parseBooleanLike(searchParams.get('includeSecrets'), false);
  const model = String(searchParams.get('model') || '').trim();
  const apiPool = getApiKeyPool();
  apiPool.init();
  const apiPoolStatus = apiPool.getAllStatus();

  if (!_lastGatewayAssetsSnapshot) {
    try {
      _lastGatewayAssetsSnapshot = await collectGatewayModelsSnapshot();
    } catch {
      _lastGatewayAssetsSnapshot = { adapters: [], list: [] };
    }
  }
  ensureAutoSharedCustomerFromSnapshot(_lastGatewayAssetsSnapshot, apiPoolStatus);

  const rows = getCustomerRegistry().listCustomers({ includeSecrets, model });
  sendJson(res, 200, rows);
}

async function handleAiGatewayCreateCustomer(req, res) {
  const body = await parseBody(req);
  const created = getCustomerRegistry().createCustomer(body || {});
  sendJson(res, 200, created);
}

async function handleAiGatewayUpdateCustomer(req, res, customerId) {
  const body = await parseBody(req);
  const updated = getCustomerRegistry().updateCustomer(customerId, body || {});
  sendJson(res, 200, updated);
}

async function handleAiGatewaySetCustomerEnabled(req, res, customerId, enabled) {
  const updated = getCustomerRegistry().setCustomerEnabled(customerId, enabled);
  sendJson(res, 200, updated);
}

async function handleAiGatewayIssueToken(req, res, customerId) {
  try {
    const body = await parseBody(req);
    const created = getCustomerRegistry().issueToken(customerId, body || {});
    sendJson(res, 200, created);
  } catch (err) {
    const message = String(err?.message || 'issue token failed');
    if (
      message.includes('not found')
      || message.includes('only supports count=1')
      || message.includes('already exists')
    ) {
      return sendError(res, 400, message);
    }
    return sendError(res, 500, message);
  }
}

async function handleAiGatewayRotateToken(req, res, customerId, tokenId) {
  const body = await parseBody(req);
  const rotated = getCustomerRegistry().rotateToken(customerId, tokenId, body.token || '');
  sendJson(res, 200, rotated);
}

async function handleAiGatewaySetTokenEnabled(req, res, customerId, tokenId, enabled) {
  const updated = getCustomerRegistry().setTokenEnabled(customerId, tokenId, enabled);
  sendJson(res, 200, updated);
}

async function handleAiGatewayDeleteToken(req, res, customerId, tokenId) {
  const removed = getCustomerRegistry().deleteToken(customerId, tokenId);
  sendJson(res, 200, removed);
}

async function handleAiGatewayListPayments(req, res, searchParams) {
  const actorUser = requireManagerAccess(req, res);
  if (!actorUser) return;

  try {
    const data = await getPaymentGatewayService().listPayments({
      page: searchParams.get('page'),
      pageSize: searchParams.get('pageSize'),
      status: searchParams.get('status'),
      customerId: searchParams.get('customerId'),
      provider: searchParams.get('provider'),
    }, { actorUser });
    sendJson(res, 200, data);
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleAiGatewayCreatePayment(req, res) {
  const actorUser = requireManagerAccess(req, res);
  if (!actorUser) return;

  try {
    const body = await parseBody(req);
    const service = getPaymentGatewayService();
    const created = await service.createPayment(body || {}, {
      actorUser,
      baseUrl: service.inferBaseUrl(req),
    });
    sendJson(res, 200, created);
  } catch (err) {
    const message = String(err?.message || 'create payment failed');
    const status = /required|greater than 0|unsupported payment provider/i.test(message)
      ? 400
      : (/customer not found/i.test(message) ? 404 : 500);
    sendError(res, status, message);
  }
}

async function handleAiGatewayGetPayment(req, res, paymentId) {
  const actorUser = requireManagerAccess(req, res);
  if (!actorUser) return;

  try {
    const service = getPaymentGatewayService();
    const data = await service.getPayment(paymentId, {
      actorUser,
      includeEvents: true,
      includeCheckout: true,
      baseUrl: service.inferBaseUrl(req),
    });
    sendJson(res, 200, data);
  } catch (err) {
    const message = String(err?.message || 'get payment failed');
    const status = /forbidden/i.test(message)
      ? 403
      : (/not found/i.test(message) ? 404 : 500);
    sendError(res, status, message);
  }
}

async function handleAiGatewayCancelPayment(req, res, paymentId) {
  const actorUser = requireManagerAccess(req, res);
  if (!actorUser) return;

  try {
    const body = await parseBody(req);
    const service = getPaymentGatewayService();
    const data = await service.cancelPayment(paymentId, body || {}, {
      actorUser,
      baseUrl: service.inferBaseUrl(req),
    });
    sendJson(res, 200, data);
  } catch (err) {
    const message = String(err?.message || 'cancel payment failed');
    const status = /cannot be cancelled/i.test(message)
      ? 409
      : (/not found/i.test(message) ? 404 : 500);
    sendError(res, status, message);
  }
}

async function handleAiGatewayConfirmMockPayment(req, res, paymentId) {
  const actorUser = requireManagerAccess(req, res);
  if (!actorUser) return;

  try {
    const body = await parseBody(req);
    const service = getPaymentGatewayService();
    const data = await service.confirmMockPayment(paymentId, body || {}, {
      actorUser,
      baseUrl: service.inferBaseUrl(req),
    });
    sendJson(res, 200, data);
  } catch (err) {
    const message = String(err?.message || 'mock confirm failed');
    const status = /not found/i.test(message) ? 404 : 500;
    sendError(res, status, message);
  }
}

async function handlePublicPaymentWebhook(req, res, provider) {
  try {
    const body = await parseBody(req);
    const service = getPaymentGatewayService();
    const data = await service.processWebhook(provider, body || {}, {
      signature: req.headers['x-khy-signature'] || req.headers['x-signature'] || '',
      source: 'daemon_public_webhook',
      baseUrl: service.inferBaseUrl(req),
    });
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    const message = String(err?.message || 'payment webhook failed');
    const status = /signature|amount mismatch|unsupported webhook status|orderId is required/i.test(message)
      ? 400
      : (/not found/i.test(message) ? 404 : 500);
    sendError(res, status, message);
  }
}

async function handleAiGatewayListAccounts(req, res) {
  const pool = getAccountPool();
  await pool.init();
  const rows = await pool.getAllAccounts();
  sendJson(res, 200, rows);
}

async function handleAiGatewayAddAccount(req, res) {
  const body = await parseBody(req);
  const pool = getAccountPool();
  await pool.init();
  const created = await pool.addAccount(body || {});
  sendJson(res, 200, created || {});
}

async function handleAiGatewayUpdateAccount(req, res, accountId) {
  const body = await parseBody(req);
  const pool = getAccountPool();
  await pool.init();
  if (!pool.updateAccount) return sendError(res, 501, 'updateAccount is not implemented');
  const updated = await pool.updateAccount(accountId, body || {});
  sendJson(res, 200, updated || {});
}

async function handleAiGatewayDeleteAccount(req, res, accountId) {
  const pool = getAccountPool();
  await pool.init();
  await pool.removeAccount(accountId);
  sendJson(res, 200, { success: true });
}

async function handleAiGatewaySetAccountEnabled(req, res, accountId, enabled) {
  const pool = getAccountPool();
  await pool.init();
  if (enabled) await pool.enableAccount(accountId);
  else await pool.disableAccount(accountId);
  sendJson(res, 200, { success: true });
}

// Batch delete: { ids: [..] } removes the listed accounts; { all: true, provider? }
// clears every account (optionally scoped to one provider). Mirrors the legacy
// ai-backend router so the frontend's POST /accounts/batch-delete resolves
// against the same daemon-native pool that GET /accounts reads.
async function handleAiGatewayBatchDeleteAccounts(req, res) {
  const body = (await parseBody(req)) || {};
  const pool = getAccountPool();
  await pool.init();
  if (body.all === true) {
    const provider = String(body.provider || '').trim();
    const result = await pool.removeAllAccounts(provider || undefined);
    return sendJson(res, 200, { success: true, ...(result || {}) });
  }
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (ids.length === 0) {
    return sendError(res, 400, 'ids must be a non-empty array (or pass all:true)');
  }
  const result = await pool.removeAccounts(ids);
  sendJson(res, 200, { success: true, ...(result || {}) });
}

// Promote one account to active for its provider pool.
async function handleAiGatewayUseAccount(req, res, provider, accountId) {
  const pool = getAccountPool();
  await pool.init();
  const account = await pool.useAccount(provider, accountId);
  sendJson(res, 200, { success: true, account: account || null });
}

// Import locally-discovered credentials for a provider into the pool.
async function handleAiGatewayImportAccounts(req, res, provider) {
  const pool = getAccountPool();
  await pool.init();
  const result = await pool.importProviderTokens(provider);
  sendJson(res, 200, { success: true, ...(result || {}) });
}

// Clear a banned/cooled-down account back to available.
async function handleAiGatewayUnbanAccount(req, res, accountId) {
  const pool = getAccountPool();
  await pool.init();
  if (!pool.updateAccount) return sendError(res, 501, 'updateAccount is not implemented');
  await pool.updateAccount(accountId, { status: 'available' });
  sendJson(res, 200, { success: true });
}

async function handleAiGatewayGetScheduling(req, res) {
  const pool = getAccountPool();
  await pool.init();
  const cfg = await pool.getSchedulingConfig();
  sendJson(res, 200, cfg);
}

async function handleAiGatewayUpdateScheduling(req, res) {
  const body = await parseBody(req);
  const pool = getAccountPool();
  await pool.init();
  const next = await pool.setSchedulingConfig(body || {});
  sendJson(res, 200, next);
}

async function handleAiGatewayGetCircuitBreaker(req, res) {
  sendJson(res, 200, readAccountCircuitBreakerConfig());
}

async function handleAiGatewayUpdateCircuitBreaker(req, res) {
  const body = await parseBody(req);
  const next = saveAccountCircuitBreakerConfig(body || {});
  sendJson(res, 200, next);
}

// ── Dependency management ─────────────────────────────────────
// 依赖清单（运行时/工具链 + 应用依赖）展示与按需安装。分级：低风险/项目级
// 直接安装；高危/需提权只回显命令，绝不静默提权。

async function handleDependencyList(req, res) {
  try {
    const inventory = require('./dependencyInventory');
    const data = await inventory.listInventory();
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleDependencyInstall(req, res, depId) {
  try {
    const resolver = require('./dependency/resolver');
    const inventory = require('./dependencyInventory');
    const { runInstall } = require('./dependency/installRunner');

    const env = resolver.defaultEnv();
    const plan = resolver.buildInstallPlan(depId, env);
    if (!plan) return sendError(res, 404, `未知或不可安装的依赖: ${depId}`);

    // 服务端独立判分级——绝不信任前端的 installable 标记。
    if (!inventory._isPlanAutoInstallable(plan)) {
      return sendJson(res, 200, {
        success: false,
        manualOnly: true,
        displayCommand: plan.displayCommand,
        docsUrl: plan.docsUrl,
        reason: plan.requiresElevation || plan.scope !== 'project'
          ? '该依赖为系统级/需管理员授权，仅提供命令，请手动执行。'
          : '该依赖风险较高，仅提供命令，请手动执行。',
      });
    }

    if (plan.needsNetwork) {
      try {
        const net = require('./networkDetector');
        if (typeof net.isOnline === 'function' && net.isOnline() === false) {
          return sendJson(res, 409, { success: false, error: '当前离线，无法下载安装该依赖。请联网后重试。' });
        }
      } catch { /* networkDetector 不可用时不阻断安装 */ }
    }

    const result = await runInstall(plan, { cwd: env.cwd });
    sendJson(res, 200, {
      success: !!result.ok,
      depId,
      command: result.command,
      steps: result.steps,
      error: result.error || null,
      hint: result.hint || null,
    });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

// ── Unified management plane (khy manage / Web SystemManagement) ───────────
// Both surfaces invoke services/management's single funnel, so CLI and Web
// can never diverge. resource id and op come from the URL; the body (if any)
// carries op args. ctx.source = 'web' is informational only — it never changes
// which source-of-truth a resource reads/writes.

async function handleManageList(req, res) {
  try {
    const registry = require('./management');
    sendJson(res, 200, { success: true, data: registry.describe() });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleManageResource(req, res, resourceId) {
  try {
    const registry = require('./management');
    const contract = registry.get(resourceId);
    if (!contract) return sendError(res, 404, `未知资源: ${resourceId}`);
    sendJson(res, 200, {
      success: true,
      data: {
        id: contract.id,
        label: contract.label,
        source: contract.source,
        sourceDetail: contract.sourceDetail,
        capabilities: contract.capabilities,
        schema: contract.schema || {},
      },
    });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleManageInvoke(req, res, resourceId, op) {
  try {
    const registry = require('./management');
    const contract = registry.get(resourceId);
    if (!contract) return sendError(res, 404, `未知资源: ${resourceId}`);
    if (!contract.capabilities.includes(op)) {
      return sendError(res, 400, `资源 ${resourceId} 不支持操作: ${op}`);
    }

    let args = {};
    try {
      const body = await parseBody(req);
      if (body && typeof body === 'object') args = body;
    } catch { /* empty / non-JSON body → no args */ }

    const user = req.khyUser || req.user || null;
    const result = await registry.invoke(resourceId, op, args, { source: 'web', user });
    sendJson(res, 200, { success: true, data: result });
  } catch (err) {
    const code = err && err.code ? 400 : 500;
    sendError(res, code, err.message);
  }
}

async function handleAiGatewayNamespace(req, res, pathname, searchParams) {
  const method = req.method;
  let apiPath = String(pathname || '');
  if (apiPath.startsWith('/api/gateway')) {
    apiPath = `/api/ai-gateway${apiPath.slice('/api/gateway'.length)}`;
  }
  if (!apiPath.startsWith('/api/ai-gateway')) return false;

  // Any mutating request (POST/PUT/DELETE/PATCH) can change what the cached
  // catalog/model reads return — drop the gateway read caches once the mutation
  // response finishes. Over-invalidation is intentional: one extra recompute on
  // the next read beats per-handler bookkeeping across dozens of mutations.
  if (method !== 'GET' && method !== 'HEAD') {
    res.once('finish', () => { invalidateGatewayCache(); });
  }

  // Monitor SSE stream must short-circuit with persistent connection.
  if (method === 'GET' && apiPath === '/api/ai-gateway/monitor/stream') {
    handleAiGatewayMonitorStream(req, res);
    return true;
  }

  if (method === 'GET' && apiPath === '/api/ai-gateway/status') return handleAiGatewayStatus(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/models') return handleListModels(req, res, null, searchParams);
  if (method === 'GET' && apiPath === '/api/ai-gateway/pool') return handleAiGatewayPool(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/catalog') return handleAiGatewayCatalog(req, res, searchParams);
  if (method === 'GET' && apiPath === '/api/ai-gateway/custom-providers') return handleAiGatewayCustomProvidersList(req, res);
  if (method === 'POST' && apiPath === '/api/ai-gateway/custom-providers') return handleAiGatewayCustomProvidersAdd(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/config') return handleAiGatewayConfigGet(req, res);
  if (method === 'PUT' && apiPath === '/api/ai-gateway/config') return handleAiGatewayConfigPut(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/model-config') return handleAiGatewayModelConfigGet(req, res);
  if (method === 'PUT' && apiPath === '/api/ai-gateway/model-config') return handleAiGatewayModelConfigPut(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/codex-config') return handleAiGatewayCodexConfigGet(req, res);
  if (method === 'PUT' && apiPath === '/api/ai-gateway/codex-config') return handleAiGatewayCodexConfigPut(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/model-slots') return handleAiGatewayModelSlotsGet(req, res);
  if (method === 'PUT' && apiPath === '/api/ai-gateway/model-slots') return handleAiGatewayModelSlotsPut(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/image-config') return handleAiGatewayImageConfigGet(req, res);
  if (method === 'PUT' && apiPath === '/api/ai-gateway/image-config') return handleAiGatewayImageConfigPut(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/model-overrides') return handleModelOverridesList(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/oauth/providers') return handleAiGatewayOAuthProviders(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/credential-watcher/status') return handleAiGatewayCredentialWatcherStatus(req, res);
  if (method === 'POST' && apiPath === '/api/ai-gateway/credential-watcher/scan') return handleAiGatewayCredentialWatcherScan(req, res);
  if (method === 'POST' && apiPath === '/api/ai-gateway/credential-watcher/start') return handleAiGatewayCredentialWatcherStart(req, res);
  if (method === 'POST' && apiPath === '/api/ai-gateway/credential-watcher/stop') return handleAiGatewayCredentialWatcherStop(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/slots') return handleAiGatewaySlots(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/protocols') return handleAiGatewayProtocols(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/plugins') return handleAiGatewayPlugins(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/oauth/status') return handleAiGatewayOAuthStatus(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/tls/status') return handleAiGatewayTlsStatus(req, res);
  if (method === 'POST' && apiPath === '/api/ai-gateway/tls/start') return handleAiGatewayTlsStart(req, res);
  if (method === 'POST' && apiPath === '/api/ai-gateway/tls/stop') return handleAiGatewayTlsStop(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/monitor/stats') return handleAiGatewayMonitorStats(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/monitor/traces') return handleAiGatewayMonitorTraces(req, res, searchParams);
  if (method === 'GET' && apiPath === '/api/ai-gateway/monitor/attribution') return handleAttributionDetail(req, res, searchParams);
  if (method === 'GET' && apiPath === '/api/ai-gateway/assets/overview') return handleAiGatewayAssetsOverview(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/customers') return handleAiGatewayListCustomers(req, res, searchParams);
  if (method === 'POST' && apiPath === '/api/ai-gateway/customers') return handleAiGatewayCreateCustomer(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/payments') return handleAiGatewayListPayments(req, res, searchParams);
  if (method === 'POST' && apiPath === '/api/ai-gateway/payments') return handleAiGatewayCreatePayment(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/accounts') return handleAiGatewayListAccounts(req, res);
  if (method === 'POST' && apiPath === '/api/ai-gateway/accounts') return handleAiGatewayAddAccount(req, res);
  if (method === 'POST' && apiPath === '/api/ai-gateway/accounts/batch-delete') return handleAiGatewayBatchDeleteAccounts(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/accounts/scheduling') return handleAiGatewayGetScheduling(req, res);
  if (method === 'PUT' && apiPath === '/api/ai-gateway/accounts/scheduling') return handleAiGatewayUpdateScheduling(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/accounts/circuit-breaker') return handleAiGatewayGetCircuitBreaker(req, res);
  if (method === 'PUT' && apiPath === '/api/ai-gateway/accounts/circuit-breaker') return handleAiGatewayUpdateCircuitBreaker(req, res);
  if (method === 'POST' && apiPath === '/api/ai-gateway/plugins') return handleAiGatewayCreatePlugin(req, res);
  if (method === 'POST' && apiPath === '/api/ai-gateway/plugins/validate') return handleAiGatewayValidatePlugin(req, res);
  if (method === 'GET' && apiPath === '/api/ai-gateway/plugins/template') return handleAiGatewayPluginTemplate(req, res);
  if (method === 'POST' && apiPath === '/api/ai-gateway/plugins/reload') return handleAiGatewayReloadPlugins(req, res);

  let match = apiPath.match(/^\/api\/ai-gateway\/custom-providers\/([a-z0-9_-]+)$/i);
  if (match && method === 'DELETE') return handleAiGatewayCustomProvidersRemove(req, res, match[1], searchParams);
  if (match && method === 'PUT') return handleAiGatewayCustomProvidersReplace(req, res, match[1]);

  match = apiPath.match(/^\/api\/ai-gateway\/model-overrides\/([a-z0-9_-]+)$/i);
  if (match && method === 'PUT') return handleModelOverridesPut(req, res, match[1]);

  match = apiPath.match(/^\/api\/ai-gateway\/models\/([a-z0-9_-]+)\/verify$/i);
  if (match && method === 'POST') return handleModelVerify(req, res, match[1], searchParams);

  match = apiPath.match(/^\/api\/ai-gateway\/pool\/([a-z0-9_-]+)\/keys$/i);
  if (match && method === 'POST') return handleAiGatewayPoolAddKey(req, res, match[1]);

  match = apiPath.match(/^\/api\/ai-gateway\/pool\/([a-z0-9_-]+)\/keys\/([a-z0-9_-]+)$/i);
  if (match && method === 'DELETE') return handleAiGatewayPoolRemoveKey(req, res, match[1], match[2]);
  if (match && method === 'PUT') return handleAiGatewayPoolUpdateKey(req, res, match[1], match[2]);

  match = apiPath.match(/^\/api\/ai-gateway\/oauth\/([a-z0-9_-]+)\/refresh$/i);
  if (match && method === 'POST') return handleAiGatewayOAuthRefresh(req, res, match[1]);

  match = apiPath.match(/^\/api\/ai-gateway\/oauth\/credentials\/([a-z0-9_-]+)$/i);
  if (match && method === 'GET') return handleAiGatewayOAuthCredentialGet(req, res, match[1]);
  if (match && method === 'PUT') return handleAiGatewayOAuthCredentialPut(req, res, match[1]);
  if (match && method === 'DELETE') return handleAiGatewayOAuthCredentialDelete(req, res, match[1]);

  match = apiPath.match(/^\/api\/ai-gateway\/plugins\/([a-z0-9_-]+)\/toggle$/i);
  if (match && method === 'POST') return handleAiGatewayTogglePlugin(req, res, match[1]);

  match = apiPath.match(/^\/api\/ai-gateway\/plugins\/([a-z0-9_-]+)\/code$/i);
  if (match && method === 'GET') return handleAiGatewayPluginCode(req, res, match[1]);

  match = apiPath.match(/^\/api\/ai-gateway\/plugins\/([a-z0-9_-]+)$/i);
  if (match && method === 'PUT') return handleAiGatewayUpdatePlugin(req, res, match[1]);
  if (match && method === 'DELETE') return handleAiGatewayDeletePlugin(req, res, match[1]);

  match = apiPath.match(/^\/api\/ai-gateway\/customers\/([a-z0-9_-]+)$/i);
  if (match && method === 'PUT') return handleAiGatewayUpdateCustomer(req, res, match[1]);

  match = apiPath.match(/^\/api\/ai-gateway\/customers\/([a-z0-9_-]+)\/(enable|disable)$/i);
  if (match && method === 'POST') return handleAiGatewaySetCustomerEnabled(req, res, match[1], match[2] === 'enable');

  match = apiPath.match(/^\/api\/ai-gateway\/customers\/([a-z0-9_-]+)\/tokens$/i);
  if (match && method === 'POST') return handleAiGatewayIssueToken(req, res, match[1]);

  match = apiPath.match(/^\/api\/ai-gateway\/customers\/([a-z0-9_-]+)\/tokens\/([a-z0-9_-]+)\/rotate$/i);
  if (match && method === 'POST') return handleAiGatewayRotateToken(req, res, match[1], match[2]);

  match = apiPath.match(/^\/api\/ai-gateway\/customers\/([a-z0-9_-]+)\/tokens\/([a-z0-9_-]+)\/(enable|disable)$/i);
  if (match && method === 'POST') {
    return handleAiGatewaySetTokenEnabled(req, res, match[1], match[2], match[3] === 'enable');
  }

  match = apiPath.match(/^\/api\/ai-gateway\/customers\/([a-z0-9_-]+)\/tokens\/([a-z0-9_-]+)$/i);
  if (match && method === 'DELETE') return handleAiGatewayDeleteToken(req, res, match[1], match[2]);

  match = apiPath.match(/^\/api\/ai-gateway\/payments\/([a-z0-9_-]+)$/i);
  if (match && method === 'GET') return handleAiGatewayGetPayment(req, res, match[1]);

  match = apiPath.match(/^\/api\/ai-gateway\/payments\/([a-z0-9_-]+)\/cancel$/i);
  if (match && method === 'POST') return handleAiGatewayCancelPayment(req, res, match[1]);

  match = apiPath.match(/^\/api\/ai-gateway\/payments\/([a-z0-9_-]+)\/mock\/confirm$/i);
  if (match && method === 'POST') return handleAiGatewayConfirmMockPayment(req, res, match[1]);

  match = apiPath.match(/^\/api\/ai-gateway\/accounts\/([0-9]+)$/i);
  if (match && method === 'PUT') return handleAiGatewayUpdateAccount(req, res, match[1]);
  if (match && method === 'DELETE') return handleAiGatewayDeleteAccount(req, res, match[1]);

  match = apiPath.match(/^\/api\/ai-gateway\/accounts\/([0-9]+)\/(enable|disable)$/i);
  if (match && method === 'POST') return handleAiGatewaySetAccountEnabled(req, res, match[1], match[2] === 'enable');

  match = apiPath.match(/^\/api\/ai-gateway\/accounts\/([0-9]+)\/unban$/i);
  if (match && method === 'POST') return handleAiGatewayUnbanAccount(req, res, match[1]);

  match = apiPath.match(/^\/api\/ai-gateway\/accounts\/([a-z0-9_-]+)\/use\/([0-9]+)$/i);
  if (match && method === 'POST') return handleAiGatewayUseAccount(req, res, match[1], match[2]);

  match = apiPath.match(/^\/api\/ai-gateway\/accounts\/([a-z0-9_-]+)\/import$/i);
  if (match && method === 'POST') return handleAiGatewayImportAccounts(req, res, match[1]);

  sendError(res, 404, 'Not found');
  return true;
}

module.exports = {
  // 宿主 routeRequest 直接分派 / __test__ 暴露的处理器(同名 re-import 接回)
  handleAiGatewayNamespace,
  handleAttributionDetail,
  handlePublicPaymentWebhook,
  handleDependencyList,
  handleDependencyInstall,
  handleManageList,
  handleManageResource,
  handleManageInvoke,
  // 内部(导出供测)
  toGatewayModelId,
  validatePluginCode,
  collectGatewayModelsSnapshot,
  // 依赖注入
  setGatewayAdminDeps,
};
