/**
 * 模型管护层（model curation）— 单一真源的「每适配器模型覆盖 + 探活状态」。
 *
 * 背景：各 gateway 适配器的 listModels() 有的返回硬编码静态列表（claude/cursor/warp），
 * 有的带硬编码 fallback（codex/kiro/relay）。网关的 available 只代表「已装/已登录/可达」，
 * 与模型 ID 是否真实解耦，导致 UI 出现「不存在的模型」。本模块让用户对每个适配器的
 * 展示列表做增删改（隐藏/新增/改名/设默认），并缓存按需探活结果，统一供 /chat 与
 * /admin 两页消费。
 *
 * 持久化：<dataHome>/model_overrides.json（默认 ~/.khy；env KHY_MODEL_OVERRIDES_FILE 可覆盖）。
 * 仅存「用户意图的覆盖」，原始模型列表仍由适配器实时产出；applyOverrides 把两者合并。
 *
 * 零硬编码：覆盖文件路径、探活 TTL 全部 env 可调。
 * 活跃度超时：探活结果带 TTL，过期由 unref 定时器清扫，永不无界堆积。
 */
const fs = require('fs');
const path = require('path');
const { getDataHome, getLegacyDataHome } = require('../../utils/dataHome');

function _overridesFile() {
  const override = process.env.KHY_MODEL_OVERRIDES_FILE;
  if (override && String(override).trim()) return String(override).trim();
  return path.join(getDataHome(), 'model_overrides.json');
}

// 一次性 legacy 迁移：读旧写新，绝不删旧。仅在未设显式 env 覆盖时生效。
function _migrateLegacy() {
  try {
    if (process.env.KHY_MODEL_OVERRIDES_FILE) return;
    const target = path.join(getDataHome(), 'model_overrides.json');
    const legacy = path.join(getLegacyDataHome(), 'model_overrides.json');
    if (target !== legacy && !fs.existsSync(target) && fs.existsSync(legacy)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, fs.readFileSync(legacy, 'utf-8'), 'utf-8');
    }
  } catch { /* migration is best-effort */ }
}

// ---------------------------------------------------------------------------
// 覆盖存储
// ---------------------------------------------------------------------------

let _cache = null;

function _load() {
  if (_cache) return _cache;
  _migrateLegacy();
  try {
    const raw = fs.readFileSync(_overridesFile(), 'utf-8');
    const parsed = JSON.parse(raw);
    _cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    _cache = {};
  }
  return _cache;
}

function _save(overrides) {
  _cache = overrides;
  const file = _overridesFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 原子写：temp → rename，避免半截文件
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(overrides, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch { /* best effort */ }
}

/** 规范化单个适配器覆盖记录，丢弃非法字段。 */
function _normalizeOverride(raw) {
  const out = {};
  if (Array.isArray(raw && raw.hidden)) {
    out.hidden = raw.hidden.map(x => String(x)).filter(Boolean);
  }
  if (Array.isArray(raw && raw.added)) {
    out.added = raw.added
      .filter(m => m && (m.id !== undefined && m.id !== null && String(m.id).trim()))
      .map(m => ({
        id: String(m.id).trim(),
        name: m.name ? String(m.name) : String(m.id).trim(),
        isDefault: !!m.isDefault,
      }));
  }
  if (raw && raw.renamed && typeof raw.renamed === 'object' && !Array.isArray(raw.renamed)) {
    out.renamed = {};
    for (const [k, v] of Object.entries(raw.renamed)) {
      if (k && v !== undefined && v !== null && String(v).trim()) out.renamed[String(k)] = String(v);
    }
  }
  if (raw && raw.defaultModel !== undefined && raw.defaultModel !== null) {
    const dm = String(raw.defaultModel).trim();
    if (dm) out.defaultModel = dm;
  }
  return out;
}

/** 返回全部覆盖（深拷贝）。 */
function getOverrides() {
  return JSON.parse(JSON.stringify(_load()));
}

/** 返回单个适配器的覆盖记录（深拷贝），无则返回 {}。 */
function getAdapterOverride(adapterKey) {
  const key = String(adapterKey || '');
  const all = _load();
  return all[key] ? JSON.parse(JSON.stringify(all[key])) : {};
}

/**
 * 写入/合并单个适配器的覆盖。patch 中出现的字段整体替换该字段
 * （hidden/added/renamed/defaultModel 任意子集）；未出现的字段保持原值。
 * 返回规范化后的最终记录。
 */
function setAdapterOverride(adapterKey, patch) {
  const key = String(adapterKey || '').trim();
  if (!key) throw new Error('adapterKey is required');
  const all = _load();
  const current = all[key] || {};
  const merged = { ...current };
  const incoming = patch && typeof patch === 'object' ? patch : {};
  for (const field of ['hidden', 'added', 'renamed', 'defaultModel']) {
    if (Object.prototype.hasOwnProperty.call(incoming, field)) {
      merged[field] = incoming[field];
    }
  }
  const normalized = _normalizeOverride(merged);
  all[key] = normalized;
  _save(all);
  return JSON.parse(JSON.stringify(normalized));
}

/** 清除单个适配器的全部覆盖。 */
function clearAdapterOverride(adapterKey) {
  const key = String(adapterKey || '');
  const all = _load();
  if (all[key]) {
    delete all[key];
    _save(all);
    return true;
  }
  return false;
}

/**
 * 把覆盖应用到适配器实时产出的原始模型列表。纯函数、无副作用。
 *  - 过滤 hidden
 *  - 追加 added（标 custom:true / discoverySource:'user'）
 *  - 套用 renamed（改显示名）
 *  - 按 defaultModel 重标 isDefault（唯一）
 */
function applyOverrides(adapterKey, rawModels) {
  const ov = getAdapterOverride(adapterKey);
  const hidden = new Set(ov.hidden || []);
  const renamed = ov.renamed || {};
  let list = (Array.isArray(rawModels) ? rawModels : [])
    .filter(m => m && !hidden.has(String(m.id)))
    .map(m => ({
      ...m,
      name: renamed[String(m.id)] || m.name || m.id,
      custom: m.custom || false,
    }));

  for (const add of (ov.added || [])) {
    if (hidden.has(add.id)) continue;
    if (list.some(m => String(m.id) === add.id)) continue; // 已存在则不重复追加
    list.push({
      id: add.id,
      name: renamed[add.id] || add.name || add.id,
      isDefault: !!add.isDefault,
      provider: 'user',
      connectionMode: null,
      discoverySource: 'user',
      custom: true,
    });
  }

  if (ov.defaultModel) {
    // defaultModel 指向已隐藏/不存在的模型时，不强行制造默认，保留各模型原有标记
    // （仅在确有匹配项时才整体重标，避免无意中清掉适配器自带的默认标记）。
    const matched = list.some(m => String(m.id) === ov.defaultModel);
    if (matched) {
      list = list.map(m => ({ ...m, isDefault: String(m.id) === ov.defaultModel }));
    }
  }

  return list;
}

// ---------------------------------------------------------------------------
// 探活缓存（内存 + TTL）
// ---------------------------------------------------------------------------

function _verifyTtlMs() {
  const raw = parseInt(process.env.KHY_MODEL_VERIFY_TTL_MS || '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 10 * 60 * 1000; // 默认 10 分钟
}

// key = `${adapter}::${modelId}` → { status, latencyMs, error, ts }
const _verifyCache = new Map();
let _sweepTimer = null;

function _ensureSweep() {
  if (_sweepTimer) return;
  const interval = Math.max(60 * 1000, Math.floor(_verifyTtlMs() / 2));
  _sweepTimer = setInterval(() => {
    const ttl = _verifyTtlMs();
    const now = Date.now();
    for (const [k, v] of _verifyCache) {
      if (!v || (now - v.ts) > ttl) _verifyCache.delete(k);
    }
  }, interval);
  if (_sweepTimer && typeof _sweepTimer.unref === 'function') _sweepTimer.unref();
}

function _verifyKey(adapterKey, modelId) {
  return `${String(adapterKey || '')}::${String(modelId || '')}`;
}

/** 读取探活状态；过期或未探则返回 'unknown'。 */
function getVerifyStatus(adapterKey, modelId) {
  const entry = _verifyCache.get(_verifyKey(adapterKey, modelId));
  if (!entry) return 'unknown';
  if ((Date.now() - entry.ts) > _verifyTtlMs()) {
    _verifyCache.delete(_verifyKey(adapterKey, modelId));
    return 'unknown';
  }
  return entry.status || 'unknown';
}

/** 读取完整探活记录（含 latency/error/ts），无则 null。 */
function getVerifyRecord(adapterKey, modelId) {
  const entry = _verifyCache.get(_verifyKey(adapterKey, modelId));
  if (!entry) return null;
  if ((Date.now() - entry.ts) > _verifyTtlMs()) {
    _verifyCache.delete(_verifyKey(adapterKey, modelId));
    return null;
  }
  return { ...entry };
}

/** 写入探活结果。status: 'verified' | 'failed' | 'unknown'。 */
function recordVerify(adapterKey, modelId, status, latencyMs, error) {
  _ensureSweep();
  _verifyCache.set(_verifyKey(adapterKey, modelId), {
    status: status || 'unknown',
    latencyMs: latencyMs != null ? latencyMs : null,
    error: error || null,
    ts: Date.now(),
  });
}

// 测试用：重置内存缓存
function _resetCache() {
  _cache = null;
  _verifyCache.clear();
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
}

module.exports = {
  getOverrides,
  getAdapterOverride,
  setAdapterOverride,
  clearAdapterOverride,
  applyOverrides,
  getVerifyStatus,
  getVerifyRecord,
  recordVerify,
  _resetCache,
};
