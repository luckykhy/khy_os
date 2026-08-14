'use strict';

/**
 * portableSyncService.js — Cross-platform incremental sync engine for
 * `khy portable sync` (dev tree → portable copy).
 *
 * Pure Node built-ins only (fs/path/crypto/child_process), so the engine
 * works from the CLI handler, the scripts/ thin wrapper and future callers
 * without extra dependencies.
 *
 * Design highlights:
 *  - size + mtime (2s tolerance, FAT/exFAT friendly) incremental compare
 *  - target-side PROTECTED_TARGET_DIRS are never written nor deleted
 *  - node_modules is mirrored ONLY when package-lock.json SHA256 differs
 *    (robocopy on win32 for speed, fs.cp fallback elsewhere)
 *  - idle-based watchdog only (engineering rule 3): the timer resets on every
 *    completed file / robocopy output line; there is NO fixed wall-clock kill
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const {
  EXCLUDE_DIRS,
  EXCLUDE_FILES,
  PROTECTED_TARGET_DIRS,
  DEP_LOCK_FILES,
  CRITICAL_ENTRY_FILES,
  MANIFEST_FILE,
} = require('./portableSyncRules');

// mtime comparison tolerance (ms) — FAT/exFAT store mtimes at 2s granularity.
const MTIME_TOLERANCE_MS = 2000;
// Idle watchdog: abort only when NO progress happened for this long.
const IDLE_TIMEOUT_MS = 120000;

// ── Pattern helpers ──────────────────────────────────────────────────────────

/**
 * Match a bare file/dir name against a rule pattern.
 * Supports one leading '*' wildcard ('*.db', '*_history'); otherwise exact
 * case-insensitive match.
 */
function matchesPattern(name, pattern) {
  const n = String(name).toLowerCase();
  const p = String(pattern).toLowerCase();
  if (p.startsWith('*')) {
    return n.endsWith(p.slice(1));
  }
  return n === p;
}

function matchesAny(name, patterns) {
  return patterns.some((p) => matchesPattern(name, p));
}

/** True when any path segment of relPath hits the protection list. */
function isProtectedRelPath(relPath) {
  const segments = String(relPath)
    .split(/[\\/]+/)
    .filter(Boolean);
  return segments.some((seg) => matchesAny(seg, PROTECTED_TARGET_DIRS));
}

// ── Target validation ────────────────────────────────────────────────────────

/**
 * True when `child` resolves strictly inside `parent`.
 * path.relative yields '' for identical paths and a '..'-prefixed or absolute
 * path for outside paths — anything else means `child` is nested in `parent`.
 */
function _isSubPath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Validate the sync target: it must exist, look like a portable khy-os copy
 * (khy.bat + services/backend/package.json), must not be the source tree and
 * must not be nested with the source in either direction (a nested pair
 * would self-mirror into portable/portable/… and corrupt both trees).
 * @returns {{ok:boolean, reason?:string}}
 */
function validateTarget(targetRoot, sourceRoot) {
  if (!targetRoot) {
    return { ok: false, reason: '未指定目标目录（--target 或 KHY_PORTABLE_ROOT）' };
  }
  const target = path.resolve(targetRoot);
  const source = path.resolve(sourceRoot);
  if (target === source) {
    return { ok: false, reason: `目标目录与源目录相同（${target}），拒绝同步` };
  }
  if (_isSubPath(source, target)) {
    return {
      ok: false,
      reason: `目标目录 ${target} 位于源目录 ${source} 内部，同步会造成自我嵌套复制，拒绝同步`,
    };
  }
  if (_isSubPath(target, source)) {
    return {
      ok: false,
      reason: `源目录 ${source} 位于目标目录 ${target} 内部，镜像模式会破坏源目录结构，拒绝同步`,
    };
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return {
      ok: false,
      reason: `目标目录不存在或不是目录: ${target}（请先用 run-portable 构建便携版）`,
    };
  }
  const markers = ['khy.bat', path.join('services', 'backend', 'package.json')];
  for (const marker of markers) {
    if (!fs.existsSync(path.join(target, marker))) {
      return {
        ok: false,
        reason: `目标缺少便携版特征文件 ${marker}，看起来不是便携版根目录: ${target}`,
      };
    }
  }
  return { ok: true };
}

// ── Source health check ──────────────────────────────────────────────────────

/** Run `node --check` for one file; resolves {ok, output}. Never rejects. */
function nodeCheckFile(absFile) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(process.execPath, ['--check', absFile], { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, output: String((err && err.message) || err) });
      return;
    }
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      out += String(d);
    });
    child.on('error', (err) => resolve({ ok: false, output: String((err && err.message) || err) }));
    child.on('close', (code) => resolve({ ok: code === 0, output: out.trim() }));
  });
}

/**
 * Syntax-check every CRITICAL_ENTRY_FILES in the source tree.
 * @returns {Promise<{ok:boolean, failures:Array<{file:string, output:string}>}>}
 */
async function checkSourceHealth(sourceRoot) {
  const failures = [];
  for (const rel of CRITICAL_ENTRY_FILES) {
    const abs = path.join(sourceRoot, rel);
    if (!fs.existsSync(abs)) {
      failures.push({ file: rel, output: '文件不存在' });
      continue;
    }
    const res = await nodeCheckFile(abs);
    if (!res.ok) {
      failures.push({ file: rel, output: res.output });
    }
  }
  return { ok: failures.length === 0, failures };
}

// ── Tree walking / plan ──────────────────────────────────────────────────────

/**
 * Recursively collect files under root applying EXCLUDE rules.
 * Returns Map<relPath, {size, mtimeMs}> with '/'-normalized rel paths.
 */
async function collectTree(root, { extraDirPatterns = [] } = {}) {
  const files = new Map();
  const dirPatterns = EXCLUDE_DIRS.concat(extraDirPatterns);

  async function walk(dirAbs, relBase) {
    let entries;
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip silently (best-effort walk)
    }
    for (const entry of entries) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (matchesAny(entry.name, dirPatterns)) {
          continue;
        }
        await walk(path.join(dirAbs, entry.name), rel);
      } else if (entry.isFile()) {
        if (matchesAny(entry.name, EXCLUDE_FILES)) {
          continue;
        }
        try {
          const st = await fsp.stat(path.join(dirAbs, entry.name));
          files.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* vanished mid-walk — ignore */
        }
      }
      // symlinks/sockets are intentionally not synced
    }
  }

  await walk(root, '');
  return files;
}

/**
 * Build the incremental sync plan.
 * @param {string} sourceRoot
 * @param {string} targetRoot
 * @param {{mirror?:boolean}} [opts]
 * @returns {Promise<{copy:string[], delete:string[], skipCount:number,
 *                    sourceCount:number, protectedSkips:number}>}
 */
async function planSync(sourceRoot, targetRoot, opts = {}) {
  const mirror = Boolean(opts.mirror);
  const sourceFiles = await collectTree(sourceRoot);

  const copy = [];
  let skipCount = 0;
  let protectedSkips = 0;

  for (const [rel, meta] of sourceFiles) {
    // Never write into protected target paths, in any mode.
    if (isProtectedRelPath(rel)) {
      protectedSkips++;
      continue;
    }
    let tst = null;
    try {
      tst = await fsp.stat(path.join(targetRoot, rel));
    } catch {
      /* missing on target → copy */
    }
    if (
      tst &&
      tst.isFile() &&
      tst.size === meta.size &&
      Math.abs(tst.mtimeMs - meta.mtimeMs) <= MTIME_TOLERANCE_MS
    ) {
      skipCount++;
      continue;
    }
    copy.push(rel);
  }

  const del = [];
  if (mirror) {
    // Walk target with the SAME exclusions plus the protection list so we
    // never even descend into protected dirs — they can never be deleted.
    const targetFiles = await collectTree(targetRoot, { extraDirPatterns: PROTECTED_TARGET_DIRS });
    for (const rel of targetFiles.keys()) {
      if (sourceFiles.has(rel)) {
        continue;
      }
      if (isProtectedRelPath(rel)) {
        continue;
      } // double safety net
      del.push(rel);
    }
  }

  return {
    copy,
    delete: del,
    skipCount,
    sourceCount: sourceFiles.size,
    protectedSkips,
  };
}

// ── node_modules gate ────────────────────────────────────────────────────────

function sha256File(absFile) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absFile)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Compare DEP_LOCK_FILES hashes between source and target.
 * @returns {{needs:boolean, sourceHash:string|null, targetHash:string|null, lockFile:string}}
 */
function needsNodeModulesSync(sourceRoot, targetRoot) {
  const lockRel = DEP_LOCK_FILES[0];
  const sourceHash = sha256File(path.join(sourceRoot, lockRel));
  const targetHash = sha256File(path.join(targetRoot, lockRel));
  // Missing either lock → be safe and refresh dependencies.
  const needs = !sourceHash || !targetHash || sourceHash !== targetHash;
  return { needs, sourceHash, targetHash, lockFile: lockRel };
}

// ── Idle watchdog (rule 3: idle-based only, no wall-clock kill) ─────────────

function createIdleWatchdog(label, onIdle) {
  let lastActivity = Date.now();
  const timer = setInterval(() => {
    const idleMs = Date.now() - lastActivity;
    if (idleMs >= IDLE_TIMEOUT_MS) {
      onIdle(idleMs, label);
    }
  }, 5000);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return {
    touch() {
      lastActivity = Date.now();
    },
    stop() {
      clearInterval(timer);
    },
  };
}

// ── Execution ────────────────────────────────────────────────────────────────

async function copyOneFile(srcAbs, dstAbs) {
  await fsp.mkdir(path.dirname(dstAbs), { recursive: true });
  await fsp.copyFile(srcAbs, dstAbs);
  // Preserve mtime so the next plan pass sees the file as up-to-date.
  const st = await fsp.stat(srcAbs);
  await fsp.utimes(dstAbs, st.atime, st.mtime);
}

/**
 * Mirror node_modules: robocopy /MIR on win32 (exit codes 0-7 = success),
 * fs.cp recursive fallback elsewhere. Idle watchdog resets on every robocopy
 * output line — a silent 120s hang is reported honestly, never a hard kill
 * of active progress.
 */
function mirrorNodeModules(srcDir, dstDir, onProgress) {
  if (process.platform !== 'win32') {
    return fsp
      .rm(dstDir, { recursive: true, force: true })
      .then(() => fsp.cp(srcDir, dstDir, { recursive: true }))
      .then(() => ({ ok: true, method: 'fs.cp', lines: 0 }));
  }
  return new Promise((resolve, reject) => {
    // /NJH /NJS /NDL /NP: silence headers/summary/dir-lines/percent, keep the
    // per-file lines as the liveness signal for the idle watchdog.
    const rcArgs = [
      srcDir,
      dstDir,
      '/MIR',
      '/COPY:DAT',
      '/R:1',
      '/W:1',
      '/NJH',
      '/NJS',
      '/NDL',
      '/NP',
    ];
    let child;
    try {
      child = spawn('robocopy', rcArgs, { windowsHide: true });
    } catch (err) {
      reject(new Error(`robocopy 启动失败: ${(err && err.message) || err}`));
      return;
    }
    let lines = 0;
    let settled = false;
    const watchdog = createIdleWatchdog('robocopy node_modules', (idleMs) => {
      if (settled) {
        return;
      }
      settled = true;
      watchdog.stop();
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      reject(
        new Error(
          `robocopy 已 ${Math.round(idleMs / 1000)} 秒无任何输出（已输出 ${lines} 行），判定卡死并中止`
        )
      );
    });
    const onData = (buf) => {
      const chunk = String(buf);
      const n = chunk.split('\n').filter((l) => l.trim()).length;
      if (n > 0) {
        lines += n;
        watchdog.touch();
        if (typeof onProgress === 'function') {
          onProgress({ action: 'robocopy', lines });
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      watchdog.stop();
      reject(new Error(`robocopy 执行出错: ${(err && err.message) || err}`));
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      watchdog.stop();
      // robocopy exit codes 0-7 mean success (files copied / extras removed).
      if (code >= 0 && code <= 7) {
        resolve({ ok: true, method: 'robocopy', lines, exitCode: code });
      } else {
        reject(new Error(`robocopy 失败（退出码 ${code}，已输出 ${lines} 行）`));
      }
    });
  });
}

/**
 * Execute a sync plan: batched copies, mirror deletes, optional node_modules
 * mirror. Progress is surfaced via onProgress({done,total,action,file}).
 * The idle watchdog resets after EVERY completed file — only a genuine
 * 120s stall aborts, and the error honestly reports done/remaining counts.
 *
 * @param {string} sourceRoot
 * @param {string} targetRoot
 * @param {{copy:string[], delete:string[]}} plan
 * @param {{syncNodeModules?:boolean}} [opts]
 * @param {(p:{done:number,total:number,action:string,file?:string,lines?:number})=>void} [onProgress]
 */
async function executeSync(sourceRoot, targetRoot, plan, opts = {}, onProgress) {
  const total = plan.copy.length + plan.delete.length;
  let done = 0;
  let idleAbort = null;
  // Idle-timeout semantics (rule 3): the watchdog only RECORDS idleness here;
  // the abort takes effect before the NEXT file operation starts and never
  // interrupts an in-flight single-file copy. No wall-clock hard kill.
  const watchdog = createIdleWatchdog('文件同步', (idleMs) => {
    idleAbort = new Error(
      `同步已 ${Math.round(idleMs / 1000)} 秒无进展（已完成 ${done}/${total}，剩余 ${total - done}），判定卡死并中止`
    );
  });
  const report = (action, file) => {
    if (typeof onProgress === 'function') {
      onProgress({ done, total, action, file });
    }
  };

  const errors = [];
  try {
    for (const rel of plan.copy) {
      if (idleAbort) {
        throw idleAbort;
      }
      try {
        await copyOneFile(path.join(sourceRoot, rel), path.join(targetRoot, rel));
      } catch (err) {
        errors.push({ file: rel, action: 'copy', message: String((err && err.message) || err) });
      }
      done++;
      watchdog.touch();
      report('copy', rel);
    }
    for (const rel of plan.delete) {
      if (idleAbort) {
        throw idleAbort;
      }
      // Final safety net: protected paths are unreachable here by plan
      // construction, but never delete one even if a caller mangles the plan.
      if (isProtectedRelPath(rel)) {
        done++;
        continue;
      }
      try {
        await fsp.rm(path.join(targetRoot, rel), { recursive: true, force: true });
      } catch (err) {
        errors.push({ file: rel, action: 'delete', message: String((err && err.message) || err) });
      }
      done++;
      watchdog.touch();
      report('delete', rel);
    }
  } finally {
    watchdog.stop();
  }

  let nodeModules = { synced: false, method: null, lines: 0 };
  if (opts.syncNodeModules) {
    const srcNm = path.join(sourceRoot, 'services', 'backend', 'node_modules');
    const dstNm = path.join(targetRoot, 'services', 'backend', 'node_modules');
    if (!fs.existsSync(srcNm)) {
      errors.push({
        file: 'services/backend/node_modules',
        action: 'mirror',
        message: '源侧 node_modules 不存在，跳过依赖镜像',
      });
    } else {
      const res = await mirrorNodeModules(srcNm, dstNm, onProgress);
      nodeModules = { synced: true, method: res.method, lines: res.lines || 0 };
    }
  }

  return {
    copied: plan.copy.length,
    deleted: plan.delete.length,
    skipped: plan.skipCount || 0,
    errors,
    nodeModules,
  };
}

// ── Manifest ─────────────────────────────────────────────────────────────────

/**
 * Write .sync-manifest.json at the target root.
 * @param {string} targetRoot
 * @param {{sourceRoot:string, copied:number, deleted:number, skipped:number,
 *          lockHash:string|null, nodeModulesSynced:boolean}} result
 */
async function writeManifest(targetRoot, result) {
  const manifest = {
    syncedAt: new Date().toISOString(),
    sourceRoot: path.resolve(result.sourceRoot),
    copied: result.copied,
    deleted: result.deleted,
    skipped: result.skipped,
    lockHash: result.lockHash || null,
    nodeModulesSynced: Boolean(result.nodeModulesSynced),
  };
  const file = path.join(targetRoot, MANIFEST_FILE);
  await fsp.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** Read the target manifest; returns the parsed object or null. */
function readManifest(targetRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(targetRoot, MANIFEST_FILE), 'utf8'));
  } catch {
    return null;
  }
}

// ── Best-effort "target may be running" probe ───────────────────────────────

/**
 * Heuristic: recently-touched runtime files at the target suggest the
 * portable copy is currently running. Best-effort only — returns false when
 * nothing can be determined.
 */
function detectTargetActivity(targetRoot, windowMs = 120000) {
  const probes = [
    path.join(targetRoot, '_debug.log'),
    path.join(targetRoot, '.khyquant-data'),
    path.join(targetRoot, '.khy'),
  ];
  const now = Date.now();
  for (const probe of probes) {
    try {
      const st = fs.statSync(probe);
      if (now - st.mtimeMs <= windowMs) {
        return true;
      }
    } catch {
      /* probe missing — keep going */
    }
  }
  return false;
}

// ── Legacy `khy sync` compatibility stubs ───────────────────────────────────────
// The old fs.watch-based watcher (start/stop) and the mtime-only syncOnce
// were replaced by the one-shot engine above (`khy portable sync`). The CLI
// handler (cli/handlers/portableSync.js) no longer starts a watcher and its
// `once` sub-command now runs the new engine directly. These stubs only keep
// the old API shape (running flag, no side effects) for legacy consumers.

const LEGACY_REPLACED_BY = 'khy portable sync';

/**
 * Legacy no-op: the watcher mode was replaced by `khy portable sync`.
 * Never starts fs.watch; returns a descriptor explaining the replacement.
 * @returns {{started:boolean, replacedBy:string, reason:string}}
 */
function start() {
  return {
    started: false,
    replacedBy: LEGACY_REPLACED_BY,
    reason: '旧的实时监听模式已被 khy portable sync 一键同步取代，不再启动监听',
  };
}

/**
 * Legacy no-op: there is never a watcher to stop any more.
 * @returns {{stopped:boolean, replacedBy:string, reason:string}}
 */
function stop() {
  return {
    stopped: false,
    replacedBy: LEGACY_REPLACED_BY,
    reason: '旧的实时监听模式已被 khy portable sync 一键同步取代，无监听可停止',
  };
}

/**
 * Legacy status shape kept for old consumers — `running` is always false.
 * @returns {{running:boolean, replacedBy:string, sourceDir:null, targetDir:null,
 *            lastSyncTime:null, totalSynced:number, totalSyncRuns:number,
 *            errors:Array}}
 */
function getStatus() {
  return {
    running: false,
    replacedBy: LEGACY_REPLACED_BY,
    sourceDir: null,
    targetDir: null,
    lastSyncTime: null,
    totalSynced: 0,
    totalSyncRuns: 0,
    errors: [],
  };
}

module.exports = {
  validateTarget,
  checkSourceHealth,
  planSync,
  needsNodeModulesSync,
  executeSync,
  writeManifest,
  readManifest,
  detectTargetActivity,
  // exposed for the thin wrapper / tests
  MTIME_TOLERANCE_MS,
  IDLE_TIMEOUT_MS,
  isProtectedRelPath,
  sha256File,
  // legacy `khy sync` compatibility stubs (watcher replaced, see above)
  start,
  stop,
  getStatus,
  LEGACY_REPLACED_BY,
};
