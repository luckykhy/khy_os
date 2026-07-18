'use strict';

/**
 * diskAnalyze/walker.js — 有界目录遍历 + 重复文件内容 hash(**服务**,做 fs / crypto,非纯叶子)。
 *
 * 为什么不是纯叶子:它真读盘(readdirSync/lstatSync)、真算内容摘要(crypto sha1)。分类/阈值/分组
 * 等纯决策已抽到 diskAnalyzeCatalog.js;此处只负责「把决策落到磁盘」并受三重上限约束,结构上根治
 * 「全盘递归静默跑到被 60s 空闲超时杀掉」:
 *   ① 墙钟预算   —— 复用 tools/_walkBudget 的 createWalkDeadline(KHY_FS_WALK_BUDGET / _MS,默认 8000ms)。
 *   ② 条目上限   —— KHY_DISKANALYZE_MAX_ENTRIES(默认 200000)。
 *   ③ hash 上限  —— 候选文件总数 / 单文件大小(由 catalog 叶子 selectHashCandidates 决策)。
 * 任一上限触发 → 提前返回部分结果并标记 truncated:true(诚实上报,非静默截断)。
 *
 * 全程 DI:deps.fsImpl / deps.cryptoImpl / deps.now / deps.platform,可在模拟磁盘上单测,无需真盘。
 * lstat 不跟随符号链接 / junction(避免越界与回环);墙钟预算兜住 Windows junction 这类 lstat 认不出的环。
 */

const path = require('path');
const walkBudget = require('../../tools/_walkBudget');

// 遍历时跳过的目录名(小写):系统/元数据/包管理产物,既非用户「大文件/安装包」诉求所在,
// 又极易膨胀遍历成本。大小写不敏感匹配。
const SKIP_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'windows', 'winsxs',
  '.git', '.svn', '.hg', 'node_modules', '.cache', '__pycache__',
  'proc', 'sys', 'dev', '.trash', '.trash-1000',
]);

function _now(deps) {
  return typeof deps.now === 'function' ? deps.now() : Date.now();
}

function _resolveMaxEntries(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  try {
    const flagRegistry = require('../flagRegistry');
    const v = flagRegistry.resolveNumeric('KHY_DISKANALYZE_MAX_ENTRIES', e);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* fall through */ }
  const raw = Number.parseInt((e && e.KHY_DISKANALYZE_MAX_ENTRIES) || '', 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(5000000, Math.max(1000, raw));
  return 200000;
}

function _isSkippedDir(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return true;
  if (SKIP_DIRS.has(n)) return true;
  // 隐藏目录(以点开头)在磁盘分析里通常是缓存/元数据,跳过以聚焦用户可见大文件。
  return false;
}

/**
 * 有界递归遍历一批根,收集全部文件的 {path, size, mtimeMs}。绝不抛。
 * @param {string[]} roots
 * @param {object} deps { fsImpl, now, platform }
 * @param {object} [opts] { maxDepth, env, deadline }
 * @returns {{ files: Array<{path,size,mtimeMs}>, scanned:number, bytes:number, truncated:boolean, reason:string }}
 */
function walk(roots, deps, opts = {}) {
  const out = { files: [], scanned: 0, bytes: 0, truncated: false, reason: '' };
  try {
    const fsImpl = deps.fsImpl;
    if (!fsImpl || typeof fsImpl.readdirSync !== 'function') { out.reason = 'no-fs'; return out; }
    const env = opts.env || (typeof process !== 'undefined' ? process.env : {});
    const maxEntries = _resolveMaxEntries(env);
    const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 24;
    const deadline = opts.deadline !== undefined
      ? opts.deadline
      : walkBudget.createWalkDeadline(env, typeof deps.now === 'function' ? deps.now : undefined);

    // 显式栈,避免超深递归爆栈;每弹一个目录读其子项。
    const stack = [];
    for (const r of (Array.isArray(roots) ? roots : [])) {
      if (r) stack.push({ dir: String(r), depth: 0 });
    }

    while (stack.length) {
      if (out.scanned >= maxEntries) { out.truncated = true; out.reason = 'max-entries'; break; }
      if (deadline && typeof deadline.exceeded === 'function' && deadline.exceeded()) {
        out.truncated = true; out.reason = 'time-budget'; break;
      }
      const { dir, depth } = stack.pop();
      let entries;
      try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        out.scanned += 1;
        if (out.scanned >= maxEntries) { out.truncated = true; out.reason = 'max-entries'; break; }
        const name = ent && ent.name;
        if (!name) continue;
        const full = path.join(dir, name);
        let st;
        try { st = fsImpl.lstatSync(full); } catch { continue; }
        if (st.isSymbolicLink && st.isSymbolicLink()) continue;   // 不跟随链接/junction
        if (st.isDirectory && st.isDirectory()) {
          if (depth < maxDepth && !_isSkippedDir(name)) stack.push({ dir: full, depth: depth + 1 });
        } else if (st.isFile && st.isFile()) {
          const size = Number(st.size) || 0;
          out.bytes += size;
          out.files.push({ path: full, size, mtimeMs: Number(st.mtimeMs) || 0 });
        }
      }
    }
    return out;
  } catch {
    out.reason = out.reason || 'error';
    return out;
  }
}

/**
 * 对 catalog 叶子挑好的候选文件算内容 sha1,按摘要分组 → 返回真正内容相同的重复组。绝不抛。
 * @param {Array<{path,size,sizeBytes}>} candidates selectHashCandidates().toHash
 * @param {object} deps { fsImpl, cryptoImpl }
 * @returns {Array<{ hash:string, sizeBytes:number, files:string[] }>}  按 sizeBytes 降序
 */
function hashDuplicates(candidates, deps) {
  try {
    if (!Array.isArray(candidates) || !candidates.length) return [];
    const fsImpl = deps.fsImpl;
    const cryptoImpl = deps.cryptoImpl || (() => { try { return require('crypto'); } catch { return null; } })();
    if (!fsImpl || typeof fsImpl.readFileSync !== 'function' || !cryptoImpl) return [];

    const byHash = new Map();
    for (const c of candidates) {
      if (!c || !c.path) continue;
      let buf;
      try { buf = fsImpl.readFileSync(c.path); } catch { continue; }
      let digest;
      try {
        digest = cryptoImpl.createHash('sha1').update(buf).digest('hex');
      } catch { continue; }
      const sizeBytes = Number(c.sizeBytes != null ? c.sizeBytes : c.size) || 0;
      const key = `${sizeBytes}:${digest}`;
      let g = byHash.get(key);
      if (!g) { g = { hash: digest, sizeBytes, files: [] }; byHash.set(key, g); }
      g.files.push(c.path);
    }
    const groups = [];
    for (const g of byHash.values()) {
      if (g.files.length >= 2) { g.files.sort(); groups.push(g); }
    }
    groups.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return groups;
  } catch {
    return [];
  }
}

module.exports = { walk, hashDuplicates, SKIP_DIRS };
