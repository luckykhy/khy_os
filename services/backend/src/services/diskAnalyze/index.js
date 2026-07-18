'use strict';

/**
 * diskAnalyze/index.js — 跨平台磁盘分析引擎门面(**服务**)。
 *
 * 对外单一入口 analyze(opts):把「找大文件 / 旧安装包 / 重复文件」编排成一次有界只读扫描。
 *   roots → walker.walk(有界遍历) → catalog 叶子(分类/阈值/分组决策) → walker.hashDuplicates(内容比对)
 *         → diskAnalyzeReport 叶子(ASCII 报告)。
 *
 * 只读:全程 stat/readdir/readFile,绝不写盘/删除。三重上限(墙钟预算 + 条目上限 + hash 候选上限)
 * 保证不会退化成「全盘递归静默跑到被空闲超时杀掉」——耗尽即返回部分结果并 truncated:true。
 *
 * 决策与阈值集中在纯叶子 diskAnalyzeCatalog(门控 KHY_DISKANALYZE_CATALOG);报告在纯叶子
 * diskAnalyzeReport(门控 KHY_DISKANALYZE_REPORT);walker 做真实 fs/crypto。全程 DI 可单测。
 */

const os = require('os');
const walker = require('./walker');
const catalog = require('../diskAnalyzeCatalog');
const report = require('../diskAnalyzeReport');

const DEFAULT_TOP = 20;
const FIND_ALL = ['large', 'installers', 'duplicates'];

function _detectPlatform() {
  try {
    const p = process.platform;
    if (p === 'win32') return 'windows';
    if (p === 'darwin') return 'macos';
    return 'linux';
  } catch { return 'linux'; }
}

function _defaultDeps() {
  let fsImpl = null;
  let cryptoImpl = null;
  try { fsImpl = require('fs'); } catch { /* ignore */ }
  try { cryptoImpl = require('crypto'); } catch { /* ignore */ }
  return { fsImpl, cryptoImpl, now: Date.now, platform: _detectPlatform() };
}

function _normalizeRoots(opts) {
  const raw = [];
  if (Array.isArray(opts.roots)) raw.push(...opts.roots);
  if (opts.path) raw.push(opts.path);
  const seen = new Set();
  const roots = [];
  for (const r of raw) {
    const s = String(r || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    // 裸盘符 "D:" → "D:\"(readdirSync 需要有分隔符的根)。
    roots.push(/^[a-zA-Z]:$/.test(s) ? s + '\\' : s);
  }
  if (!roots.length) roots.push(process.cwd ? process.cwd() : '.');
  return roots;
}

/**
 * 主入口。绝不抛(fail-soft 返回结构化空结果 + note)。
 * @param {object} [opts] { roots|path, find, top, maxDepth, deps, env }
 * @returns {{ success, platform, roots, largeFiles, oldInstallers, duplicateGroups,
 *             totals, truncated, notes, report }}
 */
function analyze(opts = {}) {
  const env = opts.env || (typeof process !== 'undefined' ? process.env : {});
  const deps = opts.deps || _defaultDeps();
  const roots = _normalizeRoots(opts);
  const find = Array.isArray(opts.find) && opts.find.length
    ? opts.find.filter((f) => FIND_ALL.includes(f))
    : FIND_ALL.slice();
  const top = Number.isFinite(opts.top) && opts.top > 0 ? Math.min(1000, Math.floor(opts.top)) : DEFAULT_TOP;
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();

  const result = {
    success: true,
    platform: deps.platform || _detectPlatform(),
    roots,
    largeFiles: [],
    oldInstallers: [],
    duplicateGroups: [],
    totals: { scanned: 0, bytes: 0, files: 0, largeCount: 0, installerCount: 0, dupGroups: 0 },
    truncated: false,
    notes: [],
    report: '',
  };

  try {
    const walked = walker.walk(roots, deps, { maxDepth: opts.maxDepth, env });
    const files = Array.isArray(walked.files) ? walked.files : [];
    result.truncated = !!walked.truncated;
    result.totals.scanned = walked.scanned || 0;
    result.totals.bytes = walked.bytes || 0;
    result.totals.files = files.length;
    if (walked.truncated) result.notes.push(`扫描在上限内提前结束(${walked.reason || 'limit'}),结果为部分视图`);

    // 大文件
    if (find.includes('large')) {
      const minBytes = catalog.resolveMinSizeBytes(env);
      const large = files.filter((f) => f && Number(f.size) >= minBytes);
      large.sort((a, b) => b.size - a.size);
      result.largeFiles = large.slice(0, top).map((f) => ({ path: f.path, size: f.size }));
      result.totals.largeCount = large.length;
    }

    // 旧安装包
    if (find.includes('installers')) {
      const inst = [];
      for (const f of files) {
        if (catalog.isOldInstaller(f, now, env)) {
          const ageDays = f.mtimeMs > 0 ? (now - f.mtimeMs) / (24 * 3600 * 1000) : null;
          inst.push({ path: f.path, size: f.size, ageDays });
        }
      }
      inst.sort((a, b) => b.size - a.size);
      result.oldInstallers = inst.slice(0, top);
      result.totals.installerCount = inst.length;
    }

    // 重复文件(按大小分组 → 决策候选 → 内容 hash → 真重复组)
    if (find.includes('duplicates')) {
      const sizeGroups = catalog.groupBySize(files, env);
      const picked = catalog.selectHashCandidates(sizeGroups, env);
      if (picked.skippedTooBig) result.notes.push(`${picked.skippedTooBig} 个超大文件未参与重复比对(超单文件 hash 上限)`);
      if (picked.skippedOverCount) result.notes.push(`${picked.skippedOverCount} 个候选未参与重复比对(超候选总数上限)`);
      const groups = walker.hashDuplicates(picked.toHash, deps);
      result.duplicateGroups = groups.slice(0, top).map((g) => ({
        sizeBytes: g.sizeBytes,
        files: g.files,
        wastedBytes: g.sizeBytes * Math.max(0, g.files.length - 1),
      }));
      result.totals.dupGroups = groups.length;
    }

    result.report = report.renderAnalyzeReport(result, env);
    return result;
  } catch (err) {
    result.success = false;
    result.notes.push(`分析异常: ${err && err.message ? err.message : String(err)}`);
    try { result.report = report.renderAnalyzeReport(result, env); } catch { /* ignore */ }
    return result;
  }
}

module.exports = { analyze, walker, os };
