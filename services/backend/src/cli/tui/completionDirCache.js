'use strict';

/**
 * completionDirCache — @-mention 补全的目录读缓存(纯叶子)。
 *
 * 根因:useCompletions.computeFile 在 useMemo([value, offset]) 里对当前 @-token 的目录跑
 * fs.readdirSync,**每一次按键**都重跑。连续键入 `@s`→`@sr`→`@src`(partial 无 `/` → dir 恒为
 * `.`)对**同一目录**读三次;在大目录(repo 根 / monorepo 包 / node_modules)里,这个同步系统
 * 调用直接卡在最延迟敏感的路径上——字符回显。
 *
 * 修:按**绝对目录路径**记忆 readdir 结果(短 TTL),同一 @-token 的连续按键复用一次系统调用;
 * 过滤/切片/映射仍每次现算(廉价,且随 base 变化)。缓存的是原始 Dirent[](其 isDirectory() 基于
 * readdir 时的 d_type,事后调用安全,不再触盘)。
 *
 * 契约:纯函数式(IO 经注入的 readdirFn;时钟经注入的 nowFn),**绝不吞掉 readdir 的抛错**——
 * 读失败原样冒泡给调用方(与今日 computeFile 的 try/catch 逐路径一致),且失败不写缓存。
 * 门控 KHY_COMPLETION_READDIR_CACHE(default-on / CANON)关 → 直接调用 readdirFn 不缓存
 * (逐字节回退今日行为)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env = process.env) {
  const raw = env && env.KHY_COMPLETION_READDIR_CACHE;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

const DEFAULT_TTL_MS = 1500;
const MAX_ENTRIES = 64;

// abs(目录绝对路径) -> { at, entries }。仅本进程;有界封顶防长会话在很多目录累积。
const _cache = new Map();

/**
 * 读目录(带 TTL 记忆)。
 * @param {string} abs 目录绝对路径(缓存键)
 * @param {(abs:string)=>any[]} readdirFn 实际读目录的函数(封装 withFileTypes 等选项)
 * @param {{ env?:object, nowFn?:()=>number, ttlMs?:number }} [opts]
 * @returns {any[]} 目录项数组(命中时为缓存的同一引用;调用方只读、绝不 mutate)
 */
function readdirCached(abs, readdirFn, opts = {}) {
  const o = opts || {};
  const env = o.env || process.env;

  // 门控关:直读、不缓存 —— 逐字节回退今日 computeFile 的内联 readdirSync。
  if (!isEnabled(env)) return readdirFn(abs);

  const now = typeof o.nowFn === 'function' ? o.nowFn() : Date.now();
  const ttl = Number.isFinite(o.ttlMs) ? o.ttlMs : DEFAULT_TTL_MS;

  const hit = _cache.get(abs);
  if (hit && (now - hit.at) < ttl) return hit.entries;

  // 抛错(ENOENT/ENOTDIR/EACCES…)不写缓存、原样冒泡给调用方(与今日一致)。
  const entries = readdirFn(abs);

  _cache.set(abs, { at: now, entries });
  if (_cache.size > MAX_ENTRIES) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
  return entries;
}

// 测试/生命周期钩子:清空缓存(进程内)。
function _clearCache() { _cache.clear(); }

module.exports = { isEnabled, readdirCached, _clearCache, DEFAULT_TTL_MS };
