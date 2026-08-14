'use strict';

/**
 * dynamicFreeModelService — 动态免费模型列表服务。
 *
 * 数据源（优先级从高到低）：
 *   1. 本地文件缓存（TTL 5 分钟）
 *   2. 在线拉取：https://opencode.ai/zen/v1/models + https://models.dev/api.json
 *
 * 免费模型判定：
 *   - Zen 端点：返回的模型列表即为免费可用模型
 *   - models.dev 端点：cost.input === 0 && cost.output === 0 的模型
 *
 * 刷新策略：
 *   - 启动时：检查缓存 TTL，过期则重新拉取
 *   - 后台定时：每 60 分钟自动刷新
 *   - 手动触发：调用 refresh() 强制刷新
 *
 * @pattern Singleton
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 配置 ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟缓存 TTL
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 60 分钟后台刷新间隔
const FETCH_TIMEOUT_MS = parseInt(process.env.KHY_FREE_MODEL_FETCH_TIMEOUT_MS || '10000', 10);

// models.dev 数据源（OpenCode 使用的中央模型注册库）
const MODELS_DEV_URL = 'https://models.dev/api.json';
// OpenCode Zen 网关免费模型端点
const ZEN_FREE_MODELS_URL = 'https://opencode.ai/zen/v1/models';

// ── 缓存路径 ─────────────────────────────────────────────────────────────────

let _cacheDir = null;
function getCacheDir() {
  if (_cacheDir) {
    return _cacheDir;
  }
  try {
    const dataHome = require('../utils/dataHome').getDataDir('cache');
    _cacheDir = path.join(dataHome, 'free-models');
  } catch {
    _cacheDir = path.join(os.homedir(), '.khy', 'cache', 'free-models');
  }
  try {
    fs.mkdirSync(_cacheDir, { recursive: true });
  } catch {
    /* best effort */
  }
  return _cacheDir;
}

const CACHE_FILE = () => path.join(getCacheDir(), 'free-models.json');
const CACHE_META_FILE = () => path.join(getCacheDir(), 'free-models-meta.json');

// ── 状态 ─────────────────────────────────────────────────────────────────────

let _refreshTimer = null;
let _refreshPromise = null; // 防止并发刷新

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/** Fail-soft: 任何错误返回 null */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || FETCH_TIMEOUT_MS);
  if (timeoutId.unref) {
    timeoutId.unref();
  }

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      signal: controller.signal,
    });
    if (!resp.ok) {
      return null;
    }
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 从 models.dev 数据中提取免费模型 */
function extractFreeModelsFromModelsDev(data) {
  if (!data || typeof data !== 'object') {
    return [];
  }
  const free = [];
  // models.dev 结构: { providers: { [id]: { models: [{ id, cost: { input, output } }] } } }
  // 或者: { data: [{ id, cost: { input, output } }] }
  const providers = data.providers || {};
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || !Array.isArray(provider.models)) {
      continue;
    }
    for (const m of provider.models) {
      const costIn = Number(m.cost?.input ?? m.inputCost ?? 0);
      const costOut = Number(m.cost?.output ?? m.outputCost ?? 0);
      if (costIn === 0 && costOut === 0) {
        free.push({
          id: String(m.id || '').trim(),
          provider: providerId,
          providerName: provider.name || providerId,
          contextWindow: m.contextWindow || m.context_window || 0,
          source: 'models.dev',
        });
      }
    }
  }
  return free;
}

/** 从 Zen 端点提取免费模型 */
function extractFreeModelsFromZen(data) {
  if (!data || !Array.isArray(data)) {
    return [];
  }
  return data
    .filter((m) => m && m.id)
    .map((m) => ({
      id: String(m.id).trim(),
      provider: 'zen',
      providerName: m.owned_by || 'OpenCode Zen',
      contextWindow: m.context_window || m.context_length || 0,
      source: 'zen',
    }));
}

/** 合并并去重模型列表 */
function mergeModels(zenModels, devModels) {
  const seen = new Set();
  const merged = [];
  for (const m of [...zenModels, ...devModels]) {
    const key = `${m.provider}::${m.id.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push({
      id: m.id,
      provider: m.provider,
      providerName: m.providerName,
      contextWindow: m.contextWindow || 0,
      source: m.source,
    });
  }
  return merged;
}

// ── 文件缓存 ─────────────────────────────────────────────────────────────────

function readCacheFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCacheFile(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* best effort */
  }
}

function loadFromCache() {
  const meta = readCacheFile(CACHE_META_FILE());
  if (!meta || !meta.expiresAt || Date.now() > meta.expiresAt) {
    return null;
  }
  const data = readCacheFile(CACHE_FILE());
  if (!data) {
    return null;
  }
  return { models: data, cachedAt: meta.cachedAt, expiresAt: meta.expiresAt };
}

function saveToCache(models) {
  const now = Date.now();
  writeCacheFile(CACHE_FILE(), models);
  writeCacheFile(CACHE_META_FILE(), {
    cachedAt: now,
    expiresAt: now + CACHE_TTL_MS,
    count: models.length,
  });
}

// ── 在线拉取 ─────────────────────────────────────────────────────────────────

async function fetchZenFreeModels() {
  try {
    const data = await fetchWithTimeout(ZEN_FREE_MODELS_URL);
    if (!data) {
      return [];
    }
    return extractFreeModelsFromZen(data);
  } catch {
    return [];
  }
}

async function fetchModelsDevFreeModels() {
  try {
    const data = await fetchWithTimeout(MODELS_DEV_URL);
    if (!data) {
      return [];
    }
    return extractFreeModelsFromModelsDev(data);
  } catch {
    return [];
  }
}

async function fetchAllOnline() {
  const [zenModels, devModels] = await Promise.all([
    fetchZenFreeModels(),
    fetchModelsDevFreeModels(),
  ]);
  return mergeModels(zenModels, devModels);
}

// ── 核心 API ─────────────────────────────────────────────────────────────────

/**
 * 获取免费模型列表（优先读缓存）。
 * @returns {Promise<{models: Array, cachedAt: number|null, source: string}>}
 */
async function listFreeModels() {
  // 1. 尝试本地缓存
  const cached = loadFromCache();
  if (cached) {
    return {
      models: cached.models,
      cachedAt: cached.cachedAt,
      source: 'cache',
    };
  }

  // 2. 无有效缓存 → 在线拉取
  return refresh();
}

/**
 * 强制刷新：在线拉取并更新缓存。
 * @returns {Promise<{models: Array, cachedAt: number, source: string}>}
 */
async function refresh() {
  // 防止并发刷新
  if (_refreshPromise) {
    return _refreshPromise;
  }

  _refreshPromise = (async () => {
    const models = await fetchAllOnline();
    saveToCache(models);
    const now = Date.now();
    return {
      models,
      cachedAt: now,
      source: 'online',
    };
  })();

  try {
    return await _refreshPromise;
  } finally {
    _refreshPromise = null;
  }
}

/**
 * 获取缓存状态（TTL 信息 + 模型数量）。
 */
function getCacheStatus() {
  const meta = readCacheFile(CACHE_META_FILE());
  if (!meta) {
    return { hasCache: false, cachedAt: null, expiresAt: null, ttlMs: CACHE_TTL_MS, count: 0 };
  }
  return {
    hasCache: true,
    cachedAt: meta.cachedAt,
    expiresAt: meta.expiresAt,
    ttlMs: CACHE_TTL_MS,
    remainingMs: Math.max(0, meta.expiresAt - Date.now()),
    count: meta.count || 0,
  };
}

// ── 后台定时刷新 ─────────────────────────────────────────────────────────────

function startBackgroundRefresh() {
  if (_refreshTimer) {
    return;
  }
  // 首次延迟 30 秒启动，避免启动即并发
  _refreshTimer = setInterval(() => {
    refresh().catch(() => {
      /* fire-and-forget */
    });
  }, REFRESH_INTERVAL_MS);
  if (_refreshTimer.unref) {
    _refreshTimer.unref();
  }
}

function stopBackgroundRefresh() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}

// ── 启动时预热 ───────────────────────────────────────────────────────────────

// 启动时检查缓存 TTL，过期则在后台刷新（不阻塞）
function warmUp() {
  const cached = loadFromCache();
  if (!cached) {
    // 无缓存，后台拉取
    refresh().catch(() => {});
  }
  // 启动后台定时刷新
  startBackgroundRefresh();
}

// ── 模块接口 ─────────────────────────────────────────────────────────────────

module.exports = {
  listFreeModels,
  refresh,
  getCacheStatus,
  startBackgroundRefresh,
  stopBackgroundRefresh,
  warmUp,
  // 配置常量（可被测试覆盖）
  _CONFIG: { CACHE_TTL_MS, REFRESH_INTERVAL_MS, FETCH_TIMEOUT_MS },
};
