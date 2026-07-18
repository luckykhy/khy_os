'use strict';

/**
 * atProjectionCache — 经典 REPL `@` 文件选择器的「已排序基础投影」短 TTL 缓存(纯叶子)。
 *
 * 承 [[completionDirCache]](TUI 侧 @-mention 的 readdir 缓存)同族,补经典 REPL 缺口。
 *
 * 根因:`repl.js::_renderAtPickerNow`(:1368)每按键(`@` 后每次刷新)都调 `_listAtEntries` →
 * `atPicker.listAtEntries`,后者对**当前目录**跑 `fs.readdirSync` + 全量 skip-filter +
 * `localeCompare` 排序 + dir/file map。但同一目录内连续键入 filter(`@s`→`@sr`→`@src`,
 * `_atCurrentDir` 不变)时,**列举/skip-filter/排序/映射全不变**,只有子串 filter 逐键收窄。
 * 在大目录(repo 根 / monorepo 包 / node_modules 邻近)里,这个每键同步系统调用 + `localeCompare`
 * 排序直接卡在字符回显——最延迟敏感的路径上。TUI 侧已有 completionDirCache 收 readdir,经典 REPL
 * 的 atPicker **完全没接**(每键裸 readdirSync + 每键重排)。
 *
 * 修:按**目录绝对路径**记忆 buildAtProjection 的结果(短 TTL,默认 1500ms,与 completionDirCache 一致)。
 * 同一目录的连续按键复用一次「readdir + 排序 + 映射」;子串 filter 仍每键现算(廉价,由 applyAtFilter)。
 * TTL 过后重算 → 目录内新增/删除文件仍 ~1.5s 内反映(freshness 契约不破)。
 *
 * 纯叶子纪律:零**自身** IO(readdir/排序 经注入的 buildFn 承担)、时钟注入、绝不抛;
 * 门控关 / 坏输入 / 异常 → 直接跑 buildFn(逐字节回退今日行为:每键现算整份投影)。
 *
 * 门控 `KHY_AT_PROJECTION_CACHE` 默认开;关 → 每键现算,逐字节等价历史。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_AT_PROJECTION_CACHE;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

const DEFAULT_TTL_MS = 1500;
const MAX_ENTRIES = 64;

// dir(绝对路径) -> { at, projection }。仅本进程;有界封顶防长会话在很多目录累积。
const _cache = new Map();

/**
 * 取(或首建)某目录的已排序基础投影(短 TTL 缓存)。
 *
 * @param {string} dir 目录路径(缓存键)
 * @param {() => Array} buildFn 现算基础投影的函数(承担 readdir + 排序 + 映射的 IO/计算)
 * @param {{ env?:object, nowFn?:()=>number, ttlMs?:number }} [opts]
 * @returns {Array} 基础投影(TTL 内命中 → 同一引用;门控关/未命中/异常 → 现算)
 */
function getProjection(dir, buildFn, opts = {}) {
  const o = opts || {};
  const env = o.env || process.env;

  const _fresh = () => {
    try { const r = buildFn(); return Array.isArray(r) ? r : []; }
    catch { return []; }
  };

  try {
    if (!isEnabled(env) || typeof dir !== 'string' || dir === '') {
      return _fresh();
    }
    const now = typeof o.nowFn === 'function' ? o.nowFn() : Date.now();
    const ttl = Number.isFinite(o.ttlMs) && o.ttlMs > 0 ? o.ttlMs : DEFAULT_TTL_MS;

    const hit = _cache.get(dir);
    if (hit && (now - hit.at) < ttl && Array.isArray(hit.projection)) {
      return hit.projection; // 同一引用 → 复用一次 readdir + 排序 + 映射
    }
    const projection = _fresh();
    _cache.set(dir, { at: now, projection });
    if (_cache.size > MAX_ENTRIES) {
      const oldest = _cache.keys().next().value;
      _cache.delete(oldest);
    }
    return projection;
  } catch {
    return _fresh();
  }
}

// 测试/生命周期钩子:清空缓存(进程内)。
function _clearCache() { _cache.clear(); }

module.exports = { isEnabled, getProjection, _clearCache, OFF_VALUES, DEFAULT_TTL_MS };
