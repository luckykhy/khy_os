/**
 * 自定义 Provider 注册表 — 存储用户添加的 OpenAI-compatible provider 元数据。
 *
 * Key 本身由 apiKeyPool 管理（api_keys.json），此文件只存显示名、端点、默认模型等元数据。
 * 持久化路径：<dataHome>/custom_providers.json（默认 ~/.khy）
 */
const fs = require('fs');
const path = require('path');

const { getDataHome, getLegacyDataHome } = require('../utils/dataHome');

const DATA_DIR = getDataHome();
const REGISTRY_FILE = path.join(DATA_DIR, 'custom_providers.json');
const LEGACY_REGISTRY_FILE = path.join(getLegacyDataHome(), 'custom_providers.json');

// 一次性 legacy 迁移：读旧写新，绝不删旧。
function _migrateLegacy() {
  try {
    if (
      REGISTRY_FILE !== LEGACY_REGISTRY_FILE &&
      !fs.existsSync(REGISTRY_FILE) &&
      fs.existsSync(LEGACY_REGISTRY_FILE)
    ) {
      const legacy = fs.readFileSync(LEGACY_REGISTRY_FILE, 'utf-8');
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(REGISTRY_FILE, legacy, 'utf-8');
    }
  } catch {
    /* migration is best-effort */
  }
}

// 内置 provider poolKey，自定义不允许冲突
const BUILTIN_POOL_KEYS = new Set([
  'deepseek',
  'qwen',
  'glm',
  'doubao',
  'wenxin',
  'openai',
  'anthropic',
  'trae',
  'relay',
  'codex',
  'sensenova',
  'agnes',
]);

let _cache = null;

function _load() {
  if (_cache) {
    return _cache;
  }
  _migrateLegacy();
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    _cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    _cache = [];
  }
  return _cache;
}

function _save(providers) {
  _cache = providers;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(providers, null, 2), 'utf-8');
  } catch {
    /* best effort */
  }
}

function listProviders() {
  return _load().slice();
}

function getProvider(poolKey) {
  return _load().find((p) => p.poolKey === poolKey) || null;
}

// Sanitize one optional metadata defaults block ({ contextWindow, maxOutputTokens }).
// Fail-soft: non-object / non-positive fields are dropped; empty result → null.
function _sanitizeDefaults(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const out = {};
  const cw = Number(raw.contextWindow);
  if (Number.isFinite(cw) && cw > 0) {
    out.contextWindow = Math.floor(cw);
  }
  const mo = Number(raw.maxOutputTokens);
  if (Number.isFinite(mo) && mo > 0) {
    out.maxOutputTokens = Math.floor(mo);
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Normalize the models array: plain strings pass through unchanged (backward
// compatible); object entries keep only { id, contextWindow, maxOutputTokens }
// (optional per-model metadata). Entries without a usable id are dropped.
function _sanitizeModels(models) {
  if (!Array.isArray(models)) {
    return [];
  }
  const out = [];
  for (const m of models) {
    if (typeof m === 'string') {
      if (m.trim()) {
        out.push(m);
      }
      continue;
    }
    if (m && typeof m === 'object' && typeof m.id === 'string' && m.id.trim()) {
      const entry = { id: m.id };
      const meta = _sanitizeDefaults(m);
      if (meta) {
        Object.assign(entry, meta);
      }
      out.push(entry);
    }
  }
  return out;
}

function saveProvider(config) {
  if (!config || !config.poolKey || !config.name) {
    throw new Error('poolKey and name are required');
  }
  if (BUILTIN_POOL_KEYS.has(config.poolKey)) {
    throw new Error(`"${config.poolKey}" 是内置 provider，不能作为自定义名称`);
  }
  const providers = _load();
  const idx = providers.findIndex((p) => p.poolKey === config.poolKey);
  const entry = {
    name: config.name,
    poolKey: config.poolKey,
    endpoint: config.endpoint || '',
    defaultModel: config.defaultModel || '',
    serviceType: config.serviceType || 'openai',
    models: _sanitizeModels(config.models),
  };
  // Optional provider-level metadata defaults ({ contextWindow, maxOutputTokens })
  // used by the dynamic max_tokens policy when a model entry carries no own
  // values. Purely optional — absent = unchanged behavior (adapter fallbacks).
  const defaults = _sanitizeDefaults(config.defaults);
  if (defaults) {
    entry.defaults = defaults;
  }
  // Optional capability tier override (T0-T3). Empty/absent = automatic
  // classification by modelTier. Kept optional for backward compatibility.
  if (config.tier) {
    entry.tier = config.tier;
  }
  // Optional declared capabilities (e.g. { vision: true }) and per-model vision
  // list (visionModels). Preserved through re-save so hand-edited or imported
  // declarations are not stripped by the whitelist. Absent = unchanged behavior.
  if (config.capabilities && typeof config.capabilities === 'object') {
    entry.capabilities = config.capabilities;
  }
  if (Array.isArray(config.visionModels)) {
    entry.visionModels = config.visionModels;
  }
  // Optional per-provider proxy URL（如配置文件手写的 proxy 字段）。随 re-save 保留，
  // 避免白名单剥离导致代理分流失效。缺失 = 直连（行为不变）。
  if (config.proxy) {
    entry.proxy = config.proxy;
  }
  if (idx >= 0) {
    providers[idx] = entry;
  } else {
    providers.push(entry);
  }
  _save(providers);
  return entry;
}

function removeProvider(poolKey) {
  const providers = _load();
  const filtered = providers.filter((p) => p.poolKey !== poolKey);
  if (filtered.length < providers.length) {
    _save(filtered);
    return true;
  }
  return false;
}

function isBuiltinPoolKey(key) {
  return BUILTIN_POOL_KEYS.has(key);
}

// 清除内存缓存（测试用）
function _resetCache() {
  _cache = null;
}

module.exports = {
  listProviders,
  getProvider,
  saveProvider,
  removeProvider,
  isBuiltinPoolKey,
  BUILTIN_POOL_KEYS,
  _resetCache,
};
