'use strict';

/**
 * todoStorePath.js — 纯叶子:V1 TodoWrite 清单文件的**会话作用域**路径解析 + 陈旧孤儿判定。
 *
 * 病根(任务系统分裂·第 2 步):V1 TodoWrite 历史写死全局 `os.tmpdir()/khy-todos.json`,
 *   不与会话绑定 → ① 并发多会话互相覆盖清单;② 新会话读到上一会话残留(「重启还在」)。
 *   会话边界刀(sessionChecklistReset)以「启动清空全局文件」缓解了 ②,但 ① 未根治
 *   (两会话仍共享同一文件)。本叶子把路径按 sessionId 分文件,使**每个会话天然拥有
 *   独立、空白起步的清单**,从结构上消除共享全局文件的并发覆盖。
 *
 * 契约(CONTRACT):零 IO(仅 `require('path')`,不在 leaf-io 禁列)、零时钟(now 由壳注入)、
 *   确定性、绝不抛(fail-soft)、env 门控 `KHY_TODO_SESSION_SCOPED` 默认开。
 *   门控关 / 无 sessionId → 回退历史全局路径(`khy-todos.json`),与今日**字节一致**。
 *
 * 诚实边界:
 *   · 只**解析路径 / 判定孤儿**,绝不碰 IO(读写 / stat / unlink 由调用壳执行)。
 *   · sessionId 绝不信任地拼进文件名——先 `_sanitizeSessionId` 白名单化防路径穿越。
 *   · 孤儿判定按 mtime 年龄(壳注入),**近期修改的文件一律保留**(可能属并发活会话,
 *     绝不误删),仅清理长期未动的废弃会话清单。
 */

const path = require('path');

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 历史全局文件名(门控关 / 无 sessionId 时的字节回退路径)。 */
const LEGACY_FILE = 'khy-todos.json';

/** 会话作用域文件名前缀:`khy-todos-<sid>.json`(与 LEGACY_FILE 靠首个 `-` 区分,glob 不误伤)。 */
const SCOPED_PREFIX = 'khy-todos-';
const SCOPED_SUFFIX = '.json';

/** 会话作用域文件识别正则(用于孤儿扫描;legacy `khy-todos.json` 无 `-` 故不匹配)。 */
const SCOPED_FILE_RE = /^khy-todos-.+\.json$/;

/** 孤儿清单默认保留期(天):mtime 早于它的会话清单文件视为废弃,可清理。 */
const ORPHAN_RETENTION_DAYS = 7;
const _MS_PER_DAY = 86400000;

/** 门控:KHY_TODO_SESSION_SCOPED 默认开,仅 {0,false,off,no} 关。 */
function todoSessionScopeEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    const raw = env && env.KHY_TODO_SESSION_SCOPED;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_OFF.has(v);
  } catch {
    return true;
  }
}

/**
 * 会话 id → 安全文件名片段:仅保留 [A-Za-z0-9._-],其余折成 '_',截断防超长。
 * sessionId 通常是 JSONL transcript id(uuid / 时间戳),但绝不信任输入拼进文件名。
 * @param {*} sessionId
 * @returns {string} 安全片段;空 / 非法 → ''
 */
function _sanitizeSessionId(sessionId) {
  try {
    const s = String(sessionId == null ? '' : sessionId).trim();
    if (!s) return '';
    return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  } catch {
    return '';
  }
}

/**
 * 解析 V1 TodoWrite 清单文件的绝对路径。
 * @param {{tmpdir:string, sessionId?:*, env?:object}} [opts]
 * @returns {string}
 *   门控开 且 有合法 sessionId → `<tmpdir>/khy-todos-<sid>.json`;
 *   否则(门控关 / 无 sessionId)→ `<tmpdir>/khy-todos.json`(历史全局路径,字节回退)。
 */
function resolveTodoFilePath(opts = {}) {
  try {
    const env = opts.env || (typeof process !== 'undefined' ? process.env : {});
    const tmpdir = String(opts.tmpdir || '');
    if (!todoSessionScopeEnabled(env)) return path.join(tmpdir, LEGACY_FILE);
    const sid = _sanitizeSessionId(opts.sessionId);
    if (!sid) return path.join(tmpdir, LEGACY_FILE);
    return path.join(tmpdir, `${SCOPED_PREFIX}${sid}${SCOPED_SUFFIX}`);
  } catch {
    // 极端 fail-soft:回退历史全局路径。
    try { return path.join(String(opts.tmpdir || ''), LEGACY_FILE); } catch { return LEGACY_FILE; }
  }
}

/** 解析孤儿保留期天数。KHY_TODO_ORPHAN_DAYS 为正整数时采用,非法 / 缺失 → 默认 7。 */
function resolveOrphanRetentionDays(env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    const raw = env && env.KHY_TODO_ORPHAN_DAYS;
    if (raw === undefined || raw === null || String(raw).trim() === '') return ORPHAN_RETENTION_DAYS;
    const n = Number(String(raw).trim());
    if (Number.isInteger(n) && n > 0) return n;
    return ORPHAN_RETENTION_DAYS;
  } catch {
    return ORPHAN_RETENTION_DAYS;
  }
}

/**
 * 从「已扫描的会话作用域清单文件」里挑出应清理的**陈旧孤儿**路径。
 *
 * 只在会话作用域启用时清理(门控关 → []);近期修改的文件(mtime 年龄 < 保留期)一律保留
 * ——它们可能属于并发运行的活会话,绝不误删(这正是分文件隔离要守护的不变量)。
 * `keepPath`(当前会话文件)始终保留。mtime 缺失 / 不可解析 → 保守保留。
 *
 * @param {object} args
 * @param {Array<{path:string, mtimeMs:number}>} args.entries  壳扫描 tmpdir 后注入的候选(仅会话作用域文件)
 * @param {number} args.now       当前时间戳(ms),壳注入(叶子零时钟)
 * @param {string} [args.keepPath] 当前会话文件路径(始终保留)
 * @param {object} [args.env]
 * @returns {string[]} 应 unlink 的路径(fail-soft:门控关 / 坏输入 → [])
 */
function selectStaleTodoFiles(args = {}) {
  try {
    const env = args.env || (typeof process !== 'undefined' ? process.env : {});
    if (!todoSessionScopeEnabled(env)) return [];
    const entries = args.entries;
    const now = args.now;
    if (!Array.isArray(entries) || !Number.isFinite(now)) return [];

    const thresholdMs = resolveOrphanRetentionDays(env) * _MS_PER_DAY;
    const keep = String(args.keepPath || '');
    const stale = [];
    for (const e of entries) {
      if (!e || typeof e.path !== 'string' || !e.path) continue;
      if (keep && e.path === keep) continue;           // 当前会话文件绝不清
      const mt = Number(e.mtimeMs);
      if (!Number.isFinite(mt)) continue;              // mtime 缺失 → 保守保留
      const age = now - mt;
      if (Number.isFinite(age) && age >= thresholdMs) stale.push(e.path);
    }
    return stale;
  } catch {
    return [];
  }
}

module.exports = {
  LEGACY_FILE,
  SCOPED_PREFIX,
  SCOPED_SUFFIX,
  SCOPED_FILE_RE,
  ORPHAN_RETENTION_DAYS,
  todoSessionScopeEnabled,
  resolveTodoFilePath,
  resolveOrphanRetentionDays,
  selectStaleTodoFiles,
  _sanitizeSessionId,
};
