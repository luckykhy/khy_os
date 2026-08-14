#!/usr/bin/env node
'use strict';

/**
 * consolidate-khy-data.js
 *
 * Copy-based consolidation of user-level khy data into the project-scoped
 * data home (<project root>/.khy). Unlike relocate-khy-data-to-project-root.js
 * (move semantics, never overwrites), this script:
 *   - NEVER deletes or moves source files (pure copy).
 *   - Resolves same-name conflicts with newer-wins (mtime comparison).
 *   - Skips identical files (same size + mtime within tolerance).
 *   - Skips SQLite hot sidecars (*.db-wal / *.db-shm) and warns on
 *     EBUSY/EPERM without aborting the run.
 *
 * Sources (only processed when present):
 *   1. ~/.khy/**            -> <root>/.khy/**   (excluding .location.json
 *                              and .location-note-shown)
 *   2. ~/.khyquant/**       -> <root>/.khy/**   (children land directly under
 *                              .khy root, matching portable getAppHome())
 *   3. ~/.khyquant_history  -> <root>/.khy/.khyquant_history
 *
 * Target resolution (no hardcoded absolute paths):
 *   KHY_OS_ROOT || KHYQUANT_PORTABLE_ROOT || <script dir>/..
 *
 * Usage:
 *   node scripts/consolidate-khy-data.js            # dry-run (default)
 *   node scripts/consolidate-khy-data.js --apply    # actually copy
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const APPLY = process.argv.includes('--apply');
const TAG = '[consolidate]';

// mtime tolerance (ms) to treat files as identical (FS timestamp granularity).
const MTIME_TOLERANCE_MS = 2000;

// Files excluded from the ~/.khy source (portable-location markers).
const KHY_EXCLUDES = new Set(['.location.json', '.location-note-shown']);

// SQLite hot sidecars that must never be copied while a DB may be open.
const HOT_FILE_RE = /\.db-(wal|shm)$/i;

function resolveProjectRoot() {
  const fromEnv = process.env.KHY_OS_ROOT || process.env.KHYQUANT_PORTABLE_ROOT;
  if (fromEnv && fs.existsSync(fromEnv)) { return path.resolve(fromEnv); }
  return path.resolve(__dirname, '..', '..');
}

const PROJECT_ROOT = resolveProjectRoot();
const DEST_ROOT = path.join(PROJECT_ROOT, '.khy');
const HOME = os.homedir();

/** Return true when `child` is the same path as, or nested inside, `parent`. */
function isSameOrInside(child, parent) {
  // Resolve junctions/symlinks so ~/.khy -> <root>/.khy setups are detected.
  const realChild = (() => { try { return fs.realpathSync(child); } catch { return path.resolve(child); } })();
  const realParent = (() => { try { return fs.realpathSync(parent); } catch { return path.resolve(parent); } })();
  const rel = path.relative(realParent, realChild);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Safe lstat that returns null instead of throwing. */
function statOrNull(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

// Plan entry actions:
//   copy            - dest missing, plain copy
//   overwrite       - dest exists, source is newer (newer-wins)
//   skip-identical  - dest exists with same size + mtime
//   skip-older      - dest exists and is newer; source copy skipped
//   skip-hot        - *.db-wal / *.db-shm sidecar, never copied
//   scan-error      - source unreadable (EBUSY/EPERM/...), warn only
const plan = [];
const scanErrors = [];
// dest path -> index of the current winning copy/overwrite entry in `plan`.
const destIndex = new Map();

/** Recursively collect copy candidates from srcDir into destDir. */
function collectDir(sourceLabel, srcDir, destDir, excludes) {
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch (err) {
    scanErrors.push({ src: srcDir, code: err.code || 'ERR', message: err.message });
    return;
  }
  for (const ent of entries) {
    if (excludes && excludes.has(ent.name)) { continue; }
    const src = path.join(srcDir, ent.name);
    const dest = path.join(destDir, ent.name);
    if (ent.isSymbolicLink()) { continue; } // never follow links (loop safety)
    if (ent.isDirectory()) {
      collectDir(sourceLabel, src, dest, null);
    } else if (ent.isFile()) {
      collectFile(sourceLabel, src, dest);
    }
  }
}

/** Classify a single source file into a plan entry. */
function collectFile(sourceLabel, src, dest) {
  const srcStat = statOrNull(src);
  if (!srcStat) {
    scanErrors.push({ src, code: 'ESTAT', message: 'cannot stat source' });
    return;
  }
  const base = { sourceLabel, src, dest, size: srcStat.size, mtimeMs: srcStat.mtimeMs };

  if (HOT_FILE_RE.test(src)) {
    plan.push({ ...base, action: 'skip-hot' });
    return;
  }

  // Intra-plan collision: two sources mapping onto the same dest path
  // (e.g. ~/.khy/conversations/x vs ~/.khyquant/conversations/x).
  if (destIndex.has(dest)) {
    const prevIdx = destIndex.get(dest);
    const prev = plan[prevIdx];
    if (srcStat.mtimeMs > prev.mtimeMs) {
      plan[prevIdx] = { ...prev, action: 'skip-older', conflict: true, loser: true };
      plan.push({ ...base, action: prev.action, conflict: true });
      destIndex.set(dest, plan.length - 1);
    } else {
      plan.push({ ...base, action: 'skip-older', conflict: true, loser: true });
    }
    return;
  }

  const destStat = statOrNull(dest);
  if (!destStat) {
    plan.push({ ...base, action: 'copy' });
    destIndex.set(dest, plan.length - 1);
    return;
  }
  const sameSize = destStat.size === srcStat.size;
  const sameTime = Math.abs(destStat.mtimeMs - srcStat.mtimeMs) <= MTIME_TOLERANCE_MS;
  if (sameSize && sameTime) {
    plan.push({ ...base, action: 'skip-identical' });
    return;
  }
  if (srcStat.mtimeMs > destStat.mtimeMs + MTIME_TOLERANCE_MS) {
    plan.push({ ...base, action: 'overwrite', conflict: true, destMtimeMs: destStat.mtimeMs });
    destIndex.set(dest, plan.length - 1);
  } else {
    plan.push({ ...base, action: 'skip-older', conflict: true, destMtimeMs: destStat.mtimeMs });
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Copy one file preserving mtime. Returns null on success or an error record.
 * EBUSY/EPERM are treated as warnings (caller keeps going).
 */
function copyOne(entry) {
  try {
    ensureDir(path.dirname(entry.dest));
    fs.copyFileSync(entry.src, entry.dest);
    const srcStat = statOrNull(entry.src);
    if (srcStat) { fs.utimesSync(entry.dest, srcStat.atime, srcStat.mtime); }
    return null;
  } catch (err) {
    return { src: entry.src, dest: entry.dest, code: err.code || 'ERR', message: err.message };
  }
}

/** Group plan entries by their top-level bucket for progress reporting. */
function bucketOf(entry) {
  const rel = path.relative(DEST_ROOT, entry.dest);
  const top = rel.split(path.sep)[0];
  return top || rel;
}

function applyPlan(actionable) {
  const failures = [];
  const byBucket = new Map();
  for (const entry of actionable) {
    const b = bucketOf(entry);
    if (!byBucket.has(b)) { byBucket.set(b, []); }
    byBucket.get(b).push(entry);
  }
  let copied = 0;
  for (const [bucket, entries] of byBucket) {
    let done = 0;
    for (const entry of entries) {
      done++;
      // Progress line: action + target + progress (per project output rules).
      console.log(`${TAG} 复制 ${bucket} (${done}/${entries.length} 文件)...`);
      const err = copyOne(entry);
      if (err) {
        failures.push(err);
        console.log(`${TAG}   警告: 复制失败 ${err.src} [${err.code}] ${err.message}`);
      } else {
        copied++;
      }
    }
  }
  return { copied, failures };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function fmtBytes(n) {
  if (n < 1024) { return `${n} B`; }
  if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KB`; }
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtTime(ms) {
  return new Date(ms).toISOString();
}

function printPlanSummary(sources) {
  console.log(`${TAG} 归集计划 (按源):`);
  for (const s of sources) {
    const entries = plan.filter((e) => e.sourceLabel === s.label);
    const toCopy = entries.filter((e) => e.action === 'copy' || e.action === 'overwrite');
    const bytes = toCopy.reduce((acc, e) => acc + e.size, 0);
    console.log(`${TAG}   ${s.label} -> ${s.destDisplay}`);
    console.log(`${TAG}     扫描文件 ${entries.length} 个, 计划复制 ${toCopy.length} 个, ` +
      `共 ${fmtBytes(bytes)}`);
  }

  const conflicts = plan.filter((e) => e.conflict);
  if (conflicts.length > 0) {
    console.log(`${TAG} 冲突报告 (${conflicts.length} 项, newer-wins):`);
    for (const c of conflicts) {
      const verdict = (c.action === 'overwrite' || c.action === 'copy') ? '覆盖(源较新)' : '跳过(目标较新或同名较新)';
      const destInfo = c.destMtimeMs != null ? ` dest=${fmtTime(c.destMtimeMs)}` : '';
      console.log(`${TAG}   [${verdict}] ${c.src} -> ${c.dest} ` +
        `(src=${fmtTime(c.mtimeMs)}${destInfo})`);
    }
  }

  const hot = plan.filter((e) => e.action === 'skip-hot');
  if (hot.length > 0) {
    console.log(`${TAG} 跳过数据库热文件 (${hot.length} 项):`);
    for (const h of hot) { console.log(`${TAG}   ${h.src}`); }
  }

  if (scanErrors.length > 0) {
    console.log(`${TAG} 扫描告警 (${scanErrors.length} 项, 不中断):`);
    for (const e of scanErrors) { console.log(`${TAG}   [${e.code}] ${e.src}: ${e.message}`); }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const mode = APPLY ? 'APPLY' : 'DRY-RUN';
  console.log(`${TAG} mode=${mode}`);
  console.log(`${TAG} 项目根: ${PROJECT_ROOT}`);
  console.log(`${TAG} 目标: ${DEST_ROOT}`);

  const sources = [];

  // Source 1: ~/.khy (skip when it IS the destination, e.g. junction setups).
  const khyHome = path.join(HOME, '.khy');
  if (fs.existsSync(khyHome) && !isSameOrInside(khyHome, DEST_ROOT) &&
      !isSameOrInside(DEST_ROOT, khyHome)) {
    sources.push({ label: '~/.khy', destDisplay: '.khy/', run: () => {
      console.log(`${TAG} 扫描 ${khyHome} (排除 .location.json / .location-note-shown)...`);
      collectDir('~/.khy', khyHome, DEST_ROOT, KHY_EXCLUDES);
    } });
  } else if (fs.existsSync(khyHome)) {
    console.log(`${TAG} 跳过源 ~/.khy: 与目标相同或互相嵌套`);
  } else {
    console.log(`${TAG} 源不存在, 跳过: ${khyHome}`);
  }

  // Source 2: ~/.khyquant flattened into .khy root (portable getAppHome layout).
  const khyquantHome = path.join(HOME, '.khyquant');
  if (fs.existsSync(khyquantHome) && !isSameOrInside(khyquantHome, DEST_ROOT)) {
    sources.push({ label: '~/.khyquant', destDisplay: '.khy/ (子项直落根下)', run: () => {
      console.log(`${TAG} 扫描 ${khyquantHome} (子项归并到 .khy 根)...`);
      collectDir('~/.khyquant', khyquantHome, DEST_ROOT, null);
    } });
  } else {
    console.log(`${TAG} 源不存在, 跳过: ${khyquantHome}`);
  }

  // Source 3: ~/.khyquant_history single file.
  const historyFile = path.join(HOME, '.khyquant_history');
  if (fs.existsSync(historyFile)) {
    sources.push({ label: '~/.khyquant_history', destDisplay: '.khy/.khyquant_history', run: () => {
      console.log(`${TAG} 扫描 ${historyFile}...`);
      collectFile('~/.khyquant_history', historyFile, path.join(DEST_ROOT, '.khyquant_history'));
    } });
  } else {
    console.log(`${TAG} 源不存在, 跳过: ${historyFile}`);
  }

  if (sources.length === 0) {
    console.log(`${TAG} 没有可处理的源, 结束.`);
    return;
  }

  for (const s of sources) { s.run(); }

  printPlanSummary(sources);

  const actionable = plan.filter((e) => e.action === 'copy' || e.action === 'overwrite');
  const identical = plan.filter((e) => e.action === 'skip-identical');
  const conflicts = plan.filter((e) => e.conflict);

  let copied = 0;
  let failures = [];
  if (APPLY) {
    console.log(`${TAG} 开始复制 ${actionable.length} 个文件...`);
    const result = applyPlan(actionable);
    copied = result.copied;
    failures = result.failures;
    if (failures.length > 0) {
      console.log(`${TAG} 复制失败汇总 (${failures.length} 项):`);
      for (const f of failures) { console.log(`${TAG}   [${f.code}] ${f.src}: ${f.message}`); }
    }
  } else {
    copied = actionable.length; // planned copies in dry-run
  }

  const failed = failures.length + scanErrors.length;
  const verb = APPLY ? '复制' : '计划复制';
  console.log(`${TAG} 总结: ${verb} ${copied} 个 / ` +
    `跳过相同 ${identical.length} 个 / 冲突 ${conflicts.length} 个 / 失败 ${failed} 个`);
  if (!APPLY) {
    console.log(`${TAG} DRY-RUN 完成, 未写入任何文件. 使用 --apply 实际执行.`);
  }
}

main();
