'use strict';

/**
 * Recent-models store — persists the last N (model, adapter) pairs the user
 * explicitly selected, so the TUI and frontend model pickers can surface a
 * "最近使用" section and F2 can cycle through them.
 *
 * Persistence: <dataHome>/recent_models.json (default ~/.khy; override via
 * KHY_RECENT_MODELS_FILE). Same dynamic resolution + atomic temp→rename
 * pattern as sibling lastVerifiedModelStore.js. Zero hardcoded paths.
 *
 * Fail-soft everywhere: read/write errors degrade to "no memory" and never
 * affect the request path.
 */

const fs = require('fs');
const path = require('path');

const { getDataHome } = require('../../utils/dataHome');

const RECENT_LIMIT = 5;

function _storeFile() {
  const override = process.env.KHY_RECENT_MODELS_FILE;
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  return path.join(getDataHome(), 'recent_models.json');
}

let _cache = null;
let _cacheLoaded = false;

function _normalize(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const adapter = String(rec.adapter || '').trim();
  if (!adapter || adapter === 'none') return null;
  return {
    model: String(rec.model || '').trim() || null,
    adapter,
    timestamp: Number(rec.timestamp) || Date.now(),
  };
}

/**
 * @returns {Array<{model: string|null, adapter: string, timestamp: number}>}
 */
function readRecentModels() {
  if (_cacheLoaded) return _cache || [];
  try {
    const raw = fs.readFileSync(_storeFile(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      _cache = parsed.map(_normalize).filter(Boolean).slice(0, RECENT_LIMIT);
    } else {
      _cache = [];
    }
  } catch {
    _cache = [];
  }
  _cacheLoaded = true;
  return _cache;
}

/**
 * Prepend a (model, adapter) pair, de-duplicate, and cap at RECENT_LIMIT.
 * Skips disk IO when the pair is already at the front of the list.
 * @param {{model?: string|null, adapter?: string|null}} rec
 * @returns {boolean} true when the list changed and was persisted
 */
function pushRecentModel(rec = {}) {
  const next = _normalize(rec);
  if (!next) return false;
  const list = readRecentModels();
  if (list.length && list[0].adapter === next.adapter && list[0].model === next.model) {
    return false;
  }
  const merged = [next, ...list.filter((m) => !(m.adapter === next.adapter && m.model === next.model))].slice(
    0,
    RECENT_LIMIT
  );
  try {
    const file = _storeFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    _cache = merged;
    _cacheLoaded = true;
    return true;
  } catch {
    return false;
  }
}

/** Test helper: drop the in-process cache so the next read hits disk. */
function _resetCache() {
  _cache = null;
  _cacheLoaded = false;
}

/** 一条 recent 记录的规范化 key。adapter 与 model 都按小写比较,model 为 null 记空串。 */
function recordKey(rec) {
  if (!rec) {
    return '';
  }
  const adapter = String(rec.adapter || '')
    .trim()
    .toLowerCase();
  const model = String(rec.model || '')
    .trim()
    .toLowerCase();
  return adapter ? `${adapter}/${model}` : '';
}

/**
 * 按「当前真实存在的模型集合」剪枝 —— 忘掉那些**已经不在 catalog 里**的 (adapter, model)。
 *
 * 为什么需要:本 store 记的是「用户曾选过什么」,不是「什么现在还存在」。一次基于猜测模型
 * (静态目录 / 本机扫描)的选择会永久留在 recent_models.json 里;F2「最近模型」轮换与
 * ModelPicker 的 ★最近 标记会把它捞回来并直接应用 → 用户看到 TUI「莫名跳到不存在的模型」,
 * 下一次生成才报 model_not_found。剪枝把「历史选择」收敛回「当前可选项」。
 *
 * 契约:fail-soft;isKnown 非函数 → 零剪枝(绝不因此清空历史);写盘仍是原子 temp→rename。
 *
 * @param {(rec: {model: string|null, adapter: string, timestamp: number}) => boolean|Set<string>|string[]} isKnown
 *        谓词,或 `${adapter}/${model}` key 的 Set/数组(大小写不敏感)
 * @returns {{removed:number, list:Array}} 剪掉几条 + 剪枝后的列表
 */
function pruneRecentModels(isKnown) {
  const list = readRecentModels();
  let predicate = null;
  try {
    if (typeof isKnown === 'function') {
      predicate = isKnown;
    } else if (isKnown instanceof Set) {
      const set = new Set([...isKnown].map((k) => String(k).toLowerCase()));
      predicate = (rec) => set.has(recordKey(rec));
    } else if (Array.isArray(isKnown)) {
      const set = new Set(isKnown.map((k) => String(k).toLowerCase()));
      predicate = (rec) => set.has(recordKey(rec));
    }
  } catch {
    predicate = null;
  }
  if (!predicate) {
    return { removed: 0, list };
  }
  let kept;
  try {
    kept = list.filter((rec) => {
      try {
        return !!predicate(rec);
      } catch {
        return true; // 谓词抛 → 该条保留,宁可留也不误删
      }
    });
  } catch {
    return { removed: 0, list };
  }
  const removed = list.length - kept.length;
  if (removed <= 0) {
    return { removed: 0, list };
  }
  try {
    const file = _storeFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(kept, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    _cache = kept;
    _cacheLoaded = true;
  } catch {
    /* 写盘失败:内存里也不假装已剪(下次读盘仍是旧值),返回 removed=0 保持诚实 */
    return { removed: 0, list };
  }
  return { removed, list: kept };
}

module.exports = {
  readRecentModels,
  pushRecentModel,
  pruneRecentModels,
  recordKey,
  RECENT_LIMIT,
  _storeFile,
  _resetCache,
};
