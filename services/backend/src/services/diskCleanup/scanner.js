'use strict';

/**
 * diskCleanup/scanner.js — 把 junkCatalog 落到磁盘上：枚举候选、量体积、判在用、过否决。
 *
 * 纯只读：只 stat / readdir，绝不删除任何东西（删除是 executor 的事）。全程 DI（deps.fsImpl），
 * 可在模拟磁盘上单测，无需真实 C/D 盘。
 *
 * 每个候选目录产出一条 candidate：
 *   { id, label, category, safety, reversible, path, drive,
 *     sizeBytes, fileCount, newestMtimeMs, live, protected, protectReason,
 *     userDataSignals, eligible, skipReason }
 *
 * eligible=true 的充要条件：存在 && 非受保护 && 无用户数据信号 && 非在用(live)。
 * review 类即便 eligible 也默认不清，由 planner 据 includeReview 决定。
 */

const path = require('path');
const catalog = require('./junkCatalog');
const guard = require('./protectedGuard');

let _storageRoots = null;
function storageRoots() {
  if (!_storageRoots) _storageRoots = require('../../utils/storageRoots');
  return _storageRoots;
}

function _now(deps) {
  // 可注入的时钟（测试用），默认真实时间。
  return typeof deps.now === 'function' ? deps.now() : Date.now();
}

/**
 * 递归量目录体积 + 文件数 + 最新 mtime。不跟随符号链接（只计 lstat，不进入链接目标）。
 * 深度上限防呆。fail-soft：单项出错跳过。
 * @param {number} [maxDepth] 递归深度上限；缺省(非有限数)→ 回退全局 catalog.thresholds.maxScanDepth
 *                            (逐字节等价历史行为)。调用方(用户选的扫描深度档)可覆盖。
 */
function measure(dir, deps, depth = 0, maxDepth) {
  const fsImpl = deps.fsImpl;
  const cap = Number.isFinite(maxDepth) ? maxDepth : catalog.thresholds.maxScanDepth;
  const out = { sizeBytes: 0, fileCount: 0, newestMtimeMs: 0, dirCount: 0 };
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    let st;
    try { st = fsImpl.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) {
      // 符号链接本身计数但绝不跟随（避免越界到用户数据/无限环）。
      out.fileCount += 1;
      continue;
    }
    if (st.isDirectory()) {
      out.dirCount += 1;
      if (depth < cap) {
        const sub = measure(full, deps, depth + 1, cap);
        out.sizeBytes += sub.sizeBytes;
        out.fileCount += sub.fileCount;
        out.dirCount += sub.dirCount;
        if (sub.newestMtimeMs > out.newestMtimeMs) out.newestMtimeMs = sub.newestMtimeMs;
      }
    } else if (st.isFile()) {
      out.sizeBytes += st.size;
      out.fileCount += 1;
      const m = st.mtimeMs || 0;
      if (m > out.newestMtimeMs) out.newestMtimeMs = m;
    }
  }
  return out;
}

/** 盘符归属（用于按盘分组）。Windows 取盘符，posix 取首段或 '/'。 */
function driveOf(p, deps) {
  const n = path.resolve(p);
  if (deps.platform === 'windows') {
    const m = /^([a-zA-Z]):/.exec(n);
    return m ? m[1].toUpperCase() + ':' : '?';
  }
  return '/';
}

/**
 * 解析一条 catalog 条目的所有候选目录（处理 perDrive 展开）。
 * @returns {string[]}
 */
function resolveEntryPaths(entry, deps, driveRoots) {
  const paths = [];
  if (entry.perDrive) {
    for (const root of driveRoots) {
      try {
        const ps = entry.resolve(deps, root) || [];
        paths.push(...ps);
      } catch { /* fail-soft */ }
    }
  } else {
    try {
      const ps = entry.resolve(deps) || [];
      paths.push(...ps);
    } catch { /* fail-soft */ }
  }
  return [...new Set(paths.filter(Boolean))];
}

/**
 * 扫描一条 catalog 条目 → 0..n 候选。
 */
function scanEntry(entry, deps, driveRoots, opts) {
  const keepRecentMs = (opts.keepRecentHours != null
    ? opts.keepRecentHours
    : catalog.thresholds.keepRecentHours) * 3600 * 1000;
  const ageMs = (entry.ageHours != null ? entry.ageHours : catalog.thresholds.defaultAgeHours) * 3600 * 1000;
  // 用户选的扫描深度档(opts.maxDepth 有限正数)覆盖全局阈值;缺省 → 传 undefined,measure 回退阈值。
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : undefined;
  const now = _now(deps);

  const results = [];
  for (const p of resolveEntryPaths(entry, deps, driveRoots)) {
    const cand = {
      id: entry.id,
      label: entry.label,
      category: entry.category,
      safety: entry.safety,
      reversible: entry.reversible !== false,
      note: entry.note || '',
      path: p,
      drive: driveOf(p, deps),
      sizeBytes: 0,
      fileCount: 0,
      newestMtimeMs: 0,
      live: false,
      protected: false,
      protectReason: '',
      userDataSignals: [],
      eligible: false,
      skipReason: '',
    };

    // 存在性
    let exists = false;
    try { exists = deps.fsImpl.existsSync(p); } catch { exists = false; }
    if (!exists) { cand.skipReason = '不存在'; results.push(cand); continue; }

    // 受保护否决（第二道防线）
    const verdict = guard.inspect(p, deps);
    if (verdict.protected) {
      cand.protected = true;
      cand.protectReason = verdict.reason;
      cand.skipReason = `受保护: ${verdict.reason}`;
      results.push(cand);
      continue;
    }

    // 用户数据信号
    const sig = guard.userDataSignals(p, deps);
    if (sig.hasSignal) {
      cand.userDataSignals = sig.signals;
      cand.skipReason = `含用户数据信号: ${sig.signals.join('; ')}`;
      results.push(cand);
      continue;
    }

    // 量体积 + 在用判定
    const m = measure(p, deps, 0, maxDepth);
    cand.sizeBytes = m.sizeBytes;
    cand.fileCount = m.fileCount;
    cand.newestMtimeMs = m.newestMtimeMs;
    cand.live = m.newestMtimeMs > 0 && (now - m.newestMtimeMs) < keepRecentMs;

    if (cand.live) {
      cand.skipReason = `在用(最近 ${Math.round((now - m.newestMtimeMs) / 60000)} 分钟内有写入)`;
    } else if (m.fileCount === 0) {
      cand.skipReason = '已空';
    } else if (m.newestMtimeMs > 0 && (now - m.newestMtimeMs) < ageMs && entry.category === catalog.CATEGORY.SYSTEM_TEMP) {
      // 临时目录：整体太新（早于 ageHours）保守跳过。
      cand.skipReason = `临时文件过新(<${entry.ageHours != null ? entry.ageHours : catalog.thresholds.defaultAgeHours}h)`;
    } else {
      cand.eligible = true;
    }
    results.push(cand);
  }
  return results;
}

/**
 * 全量扫描。
 * @param {object} [opts] - {deps, roots, keepRecentHours, platform}
 * @returns {{ platform, candidates: object[], driveRoots: string[] }}
 */
function scan(opts = {}) {
  const deps = opts.deps || catalog.defaultDeps();
  const platform = deps.platform;

  // 盘符根（用于 perDrive 条目，如回收站）。Windows: 系统盘 + 非系统盘。
  let driveRoots = [];
  if (platform === 'windows') {
    try {
      const sys = storageRoots().getSystemDriveRoot({ platform, env: deps.env, homedir: deps.homedir });
      driveRoots.push(sys);
    } catch { /* ignore */ }
    try {
      const others = storageRoots().listNonSystemDrives({ platform, env: deps.env, fsImpl: deps.fsImpl, homedir: deps.homedir }) || [];
      for (const d of others) driveRoots.push(d.root);
    } catch { /* ignore */ }
  } else {
    driveRoots = ['/'];
  }
  // 调用方可显式限定 roots（如只清 C 或只清 D）。
  if (Array.isArray(opts.roots) && opts.roots.length) {
    const want = new Set(opts.roots.map((r) => String(r).toUpperCase().replace(/[\\/]+$/, '')));
    driveRoots = driveRoots.filter((r) => want.has(String(r).toUpperCase().replace(/[\\/]+$/, '')));
  }
  driveRoots = [...new Set(driveRoots.filter(Boolean))];

  const entries = catalog.entriesForPlatform(platform);
  const candidates = [];
  for (const entry of entries) {
    candidates.push(...scanEntry(entry, deps, driveRoots, opts));
  }
  return { platform, candidates, driveRoots };
}

module.exports = { scan, scanEntry, measure, driveOf, resolveEntryPaths };
