'use strict';

/**
 * learningOverlay.js — 课程动态覆盖层的**纯持久化 + 纯合并叶子模块**
 *
 * 为什么单独成模块（分层动机）：
 *   `learningCurriculum.js`（地板）在解析源码路径 / 构建分层时需要读覆盖层并做合并
 *   （remapFile / loadOverlay / applyOverlay）；而 `learningCurriculumDynamic.js`（编排）
 *   反过来又要 require 地板的 syncCurriculum / PROJECT_ROOT 去扫描。两者互相 require 会
 *   形成 `curriculum ⇄ dynamic` 循环依赖（被 archDebtScan 判为新增环）。
 *
 *   解法：把**不依赖 curriculum** 的覆盖层原语（文件 I/O + 纯合并）下沉到本叶子模块。
 *   - 地板 `curriculum` → 只 require 本叶子（取 loadOverlay/applyOverlay/remapFile）；
 *   - 编排 `dynamic` → require 本叶子（取写入/读取）+ require curriculum（取扫描）；并
 *     **re-export** 本叶子的纯函数以保持既有测试/调用方接口不变。
 *   本叶子**绝不 require** curriculum/dynamic，因此依赖图无环（curriculum→leaf、dynamic→{leaf,curriculum}）。
 *
 * 铁律：纯函数优先、fail-soft（任何失败回落空覆盖层，绝不挂死学习流）、原子写、零硬编码
 * （阈值/开关走 KHY_LEARN_* env）。覆盖层落底座领地 `~/.khyos/growth/`，绝不改随包 curriculum.json。
 */

const fs = require('fs');
const path = require('path');

const { getBaseDataDir } = require('../utils/dataHome');

// ── 环境开关（零硬编码；与 dynamic 保持同名同义，三行小助手就地复刻避免跨模块耦合） ──
function _envBool(name, def) {
  const v = String(process.env[name] == null ? '' : process.env[name]).trim().toLowerCase();
  if (v === '') return def;
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** 动态化总开关：KHY_LEARN_DYNAMIC=0 一键回到纯地板。 */
function isDynamicEnabled() { return _envBool('KHY_LEARN_DYNAMIC', true); }

const OVERLAY_VERSION = 1;

// ── 覆盖层文件 ────────────────────────────────────────────────────────
// 收敛到 utils/growthDataDir 单一真源(逐字节委托,调用点不变) // ~/.khyos/growth
const _overlayDir = require('../utils/growthDataDir');
function _overlayFile() { return path.join(_overlayDir(), 'curriculum_overlay.json'); }
function _overlayTmp() { return path.join(_overlayDir(), 'curriculum_overlay.tmp'); }

function _emptyOverlay() {
  return {
    version: OVERLAY_VERSION,
    generatedAt: null,
    fingerprint: null,
    capabilities: { fs: false, network: false, model: 'none' },
    fileRemaps: {},
    topics: [],
    layers: [],
  };
}

// mtime 缓存：_resolveSourceAbs 会按文件引用逐个调用 loadOverlay，避免每次读盘。
let _overlayCache = null;
let _overlayMtime = 0;

/** 读覆盖层；缺失/损坏/被禁用 → 空覆盖层（地板照常）。绝不抛。 */
function loadOverlay() {
  if (!isDynamicEnabled()) return _emptyOverlay();
  try {
    const file = _overlayFile();
    let stat;
    try { stat = fs.statSync(file); } catch { _overlayCache = null; _overlayMtime = 0; return _emptyOverlay(); }
    if (_overlayCache && stat.mtimeMs === _overlayMtime) return _overlayCache;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object') return _emptyOverlay();
    // 结构兜底：字段缺失即补空，绝不让脏数据污染合并。
    const overlay = {
      version: Number(raw.version) || OVERLAY_VERSION,
      generatedAt: raw.generatedAt || null,
      fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : null,
      capabilities: (raw.capabilities && typeof raw.capabilities === 'object') ? raw.capabilities : { fs: false, network: false, model: 'none' },
      fileRemaps: (raw.fileRemaps && typeof raw.fileRemaps === 'object') ? raw.fileRemaps : {},
      topics: Array.isArray(raw.topics) ? raw.topics : [],
      layers: Array.isArray(raw.layers) ? raw.layers : [],
    };
    _overlayCache = overlay;
    _overlayMtime = stat.mtimeMs;
    return overlay;
  } catch {
    return _emptyOverlay();
  }
}

/** 删除覆盖层（回到纯地板）。返回是否删除成功，fail-soft。 */
function clearOverlay() {
  try {
    const file = _overlayFile();
    _overlayCache = null; _overlayMtime = 0;
    if (fs.existsSync(file)) { fs.rmSync(file, { force: true }); return true; }
  } catch { /* ignore */ }
  return false;
}

/** 原子写覆盖层（.tmp → rename）并失效内存缓存。fail-soft 返回布尔。 */
function writeOverlay(overlay) {
  const dir = _overlayDir();
  const tmp = _overlayTmp();
  const file = _overlayFile();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(overlay, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, file);                 // 原子替换
    _overlayCache = null; _overlayMtime = 0;  // 失效缓存，下次 loadOverlay 读新内容
    return true;
  } catch {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

// ── 合并：地板 + 覆盖层（纯函数，不改入参） ──────────────────────────
/**
 * 把覆盖层叠加到地板层数组之上。
 *  - overlay.topics 注入到匹配 id 的地板层（去重，打 _dynamic/_source 徽标）；
 *  - overlay.layers 作为全新动态层追加（同样打徽标）；
 *  - 按 id 排序返回。地板对象**不被修改**（受影响的层浅拷贝 + 新 topics 数组）。
 */
function applyOverlay(floorLayers, overlay) {
  if (!Array.isArray(floorLayers)) return floorLayers;
  if (!overlay || typeof overlay !== 'object') return floorLayers.slice();

  const injectByLayer = new Map();   // layerId -> [topic, ...]
  for (const t of (overlay.topics || [])) {
    if (!t || t.layer == null || !t.id) continue;
    const lid = Number(t.layer);
    if (!injectByLayer.has(lid)) injectByLayer.set(lid, []);
    injectByLayer.get(lid).push({
      id: String(t.id),
      title: String(t.title || t.id),
      desc: String(t.desc || ''),
      files: Array.isArray(t.files) ? t.files.slice() : [],
      _dynamic: true,
      _source: t.source === 'ai' ? 'ai' : 'discovered',
    });
  }

  const merged = floorLayers.map((layer) => {
    const extra = injectByLayer.get(Number(layer.id));
    if (!extra || extra.length === 0) return layer;
    const existingIds = new Set((layer.topics || []).map(t => String(t.id)));
    const fresh = extra.filter(t => !existingIds.has(String(t.id)));
    if (fresh.length === 0) return layer;
    return { ...layer, topics: [...(layer.topics || []), ...fresh] };
  });

  // 追加动态层（id 不与地板层冲突时）
  const floorIds = new Set(floorLayers.map(l => Number(l.id)));
  for (const dl of (overlay.layers || [])) {
    if (!dl || dl.id == null || floorIds.has(Number(dl.id))) continue;
    merged.push({
      id: Number(dl.id),
      title: String(dl.title || `动态层 ${dl.id}`),
      summary: String(dl.summary || ''),
      _dynamic: true,
      _source: 'ai',
      topics: (Array.isArray(dl.topics) ? dl.topics : []).map(t => ({
        id: String(t.id),
        title: String(t.title || t.id),
        desc: String(t.desc || ''),
        files: Array.isArray(t.files) ? t.files.slice() : [],
        _dynamic: true,
        _source: 'ai',
      })),
    });
  }

  return merged.sort((a, b) => a.id - b.id);
}

/** 失效引用自愈：返回 fileRemaps 命中的新相对路径，否则 null。 */
function remapFile(relPath, overlay) {
  try {
    if (overlay && overlay.fileRemaps && typeof overlay.fileRemaps === 'object') {
      const to = overlay.fileRemaps[relPath];
      if (to && typeof to === 'string') return to;
    }
  } catch { /* ignore */ }
  return null;
}

/** 覆盖层摘要（供 banner 显示）。 */
function overlaySummary(overlay) {
  const o = overlay || loadOverlay();
  const dyn = (o.topics || []).length;
  const heal = Object.keys(o.fileRemaps || {}).length;
  return { topics: dyn, remaps: heal, generatedAt: o.generatedAt };
}

module.exports = {
  OVERLAY_VERSION,
  isDynamicEnabled,
  loadOverlay,
  clearOverlay,
  writeOverlay,
  applyOverlay,
  remapFile,
  overlaySummary,
  _emptyOverlay,
};
