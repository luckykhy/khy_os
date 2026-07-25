'use strict';

/**
 * sourceHealPolicy.js — 纯叶子:khy 源码/文件「自愈」的决策大脑(单一真源)。
 *
 * 背景(真缺口):khy 以打包分发(四树 + 加密源码快照 `bundled/_source/*.enc`)
 * 形态落到用户机器。文件可能**丢失**(个别文件缺失)或**损坏**(如函数名少打
 * 一个字母 → 内容变了)。现有 `fileIntegrityService` 只**检测**且在打包安装里
 * 直接早退禁用(`__dirname` 含 `bundled`/`site-packages` → return true),从不
 * **修正补齐**;`khy restore` 能从快照整树覆盖但粒度太粗(全量解压)。本叶子补上
 * 缺失的一环:给定「应有文件哈希清单(来自纯净参照)」与「磁盘实际哈希」,确定性
 * 地算出**该修哪些文件**(缺失 vs 损坏)、**绝不碰哪些**(多余文件只报告不删、
 * 不安全路径拒绝),并对一次修复的文件数**封顶**(超顶=灾难性损坏,交给整树
 * `khy restore` 而非静默重写上千文件)。真正的解密/哈希/写回留给薄壳
 * sourceHealService.js。
 *
 * 契约(CONTRACT):零 IO(只读 `process.env` 做门控 + `require('path')` 纯路径
 *   判定,绝不碰 fs/网络/子进程/git/流)、确定性(输出只依赖入参,排序稳定)、
 *   绝不抛(fail-soft,任何坏输入返回安全空计划)、env 门控 `KHY_SOURCE_HEAL`
 *   默认开。门控关 → planSourceHeal 返回 `enabled:false` 的全空计划(薄壳字节
 *   回退到「不自愈任何东西」)。
 *
 * 全局门控惯例:khy 所有 KHY_* 开关读法为「仅 0/false/off/no(去空白小写)才算关」。
 */

const path = require('path');

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 一次自愈最多修复的文件数(防灾难性大规模重写);超顶交给整树 khy restore。 */
const DEFAULT_MAX_HEAL = 200;

/** 门控:KHY_SOURCE_HEAL 默认开,仅 {0,false,off,no} 关。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    const raw = env && env.KHY_SOURCE_HEAL;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_OFF.has(v);
  } catch {
    return true;
  }
}

/**
 * 解析一次自愈的文件数上限。KHY_SOURCE_HEAL_MAX 覆盖,非正整数/坏值 → 默认 200。
 * 显式 0 或负数被视为坏值回落默认(封顶永远 ≥1,避免「关掉封顶」的歧义)。
 */
function resolveMaxHeal(env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    const raw = env && env.KHY_SOURCE_HEAL_MAX;
    if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MAX_HEAL;
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return DEFAULT_MAX_HEAL;
    return n;
  } catch {
    return DEFAULT_MAX_HEAL;
  }
}

/**
 * 相对路径安全判定:必须是非空字符串、非绝对路径、规范化后不含 `..` 逃逸段。
 * 防止自愈把「纯净参照里的路径」误当作可写入宿主任意位置(路径穿越防线)。
 */
function _isSafeRelPath(rel) {
  try {
    if (typeof rel !== 'string') return false;
    const s = rel.trim();
    if (!s) return false;
    if (path.isAbsolute(s)) return false;
    // Windows 盘符(C:\ / C:/)也算绝对,path.isAbsolute 在 posix 上不识别 → 额外拦。
    if (/^[A-Za-z]:[\\/]/.test(s)) return false;
    // 规范化后若以 `..` 起头或含 `../` 段 → 逃逸,拒绝。
    const norm = path.normalize(s).replace(/\\/g, '/');
    if (norm === '..' || norm.startsWith('../') || norm.includes('/../')) return false;
    return true;
  } catch {
    return false;
  }
}

/** 把 expected/actual 归一为普通 {relPath: hash} 映射(容忍 null/非对象)。 */
function _asMap(obj) {
  if (!obj || typeof obj !== 'object') return {};
  return obj;
}

/**
 * 计算自愈计划:纯净参照(expected)对比磁盘实际(actual)。
 *
 * @param {Object<string,string>} expected - 应有文件哈希 {relPath: sha256}(纯净参照)。
 * @param {Object<string,string|null>} actual - 磁盘实际哈希 {relPath: sha256|null}
 *        (null/undefined/'' 表示缺失或不可读)。
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @returns {{
 *   enabled: boolean,
 *   missing: string[],         // 应有但磁盘缺失 → 补齐
 *   corrupt: string[],         // 两侧都有但哈希不符 → 修正(覆盖损坏内容)
 *   ok: string[],              // 哈希一致
 *   extra: string[],           // 磁盘有但参照无 → 只报告,绝不删除
 *   skippedUnsafe: string[],   // 不安全相对路径 → 拒绝自愈(仅报告)
 *   plan: Array<{relPath:string, reason:'missing'|'corrupt'}>,  // 排序 + 封顶后的执行计划
 *   capped: {applied:boolean, dropped:number, limit:number},
 *   summary: {expected:number, actual:number, missing:number, corrupt:number, ok:number, extra:number, toHeal:number}
 * }}
 *
 * fail-soft:门控关 → enabled:false 的全空计划;坏输入 → 安全空计划。
 */
function planSourceHeal(expected, actual, opts = {}) {
  const empty = (enabled) => ({
    enabled,
    missing: [],
    corrupt: [],
    ok: [],
    extra: [],
    skippedUnsafe: [],
    plan: [],
    capped: { applied: false, dropped: 0, limit: 0 },
    summary: { expected: 0, actual: 0, missing: 0, corrupt: 0, ok: 0, extra: 0, toHeal: 0 },
  });

  try {
    const env = (opts && opts.env) || (typeof process !== 'undefined' ? process.env : {});
    if (!isEnabled(env)) return empty(false);

    const exp = _asMap(expected);
    const act = _asMap(actual);
    const expKeys = Object.keys(exp);
    const actKeys = Object.keys(act);

    const missing = [];
    const corrupt = [];
    const ok = [];
    const skippedUnsafe = [];

    for (const rel of expKeys) {
      const wantRaw = exp[rel];
      const want = typeof wantRaw === 'string' ? wantRaw : '';
      if (!_isSafeRelPath(rel)) { skippedUnsafe.push(rel); continue; }
      const haveRaw = act[rel];
      const have = typeof haveRaw === 'string' ? haveRaw : '';
      if (!have) {
        missing.push(rel);
      } else if (want && have === want) {
        ok.push(rel);
      } else {
        // 有内容但哈希不符(或参照哈希缺失时保守视为需修) → 损坏。
        corrupt.push(rel);
      }
    }

    // 磁盘有但参照无:多余文件。只报告,绝不删除(用户/插件的合法产物不碰)。
    const extra = [];
    const expSet = new Set(expKeys);
    for (const rel of actKeys) {
      if (!expSet.has(rel)) extra.push(rel);
    }

    missing.sort();
    corrupt.sort();
    ok.sort();
    extra.sort();
    skippedUnsafe.sort();

    // 执行计划:先补缺失、再修损坏(稳定排序);封顶防灾难性大规模重写。
    const ordered = [
      ...missing.map((relPath) => ({ relPath, reason: 'missing' })),
      ...corrupt.map((relPath) => ({ relPath, reason: 'corrupt' })),
    ];
    const limit = resolveMaxHeal(env);
    let plan = ordered;
    let dropped = 0;
    if (ordered.length > limit) {
      plan = ordered.slice(0, limit);
      dropped = ordered.length - limit;
    }

    return {
      enabled: true,
      missing,
      corrupt,
      ok,
      extra,
      skippedUnsafe,
      plan,
      capped: { applied: dropped > 0, dropped, limit },
      summary: {
        expected: expKeys.length,
        actual: actKeys.length,
        missing: missing.length,
        corrupt: corrupt.length,
        ok: ok.length,
        extra: extra.length,
        toHeal: ordered.length,
      },
    };
  } catch {
    return empty(true);
  }
}

module.exports = {
  isEnabled,
  resolveMaxHeal,
  planSourceHeal,
  _isSafeRelPath,
  DEFAULT_MAX_HEAL,
};
