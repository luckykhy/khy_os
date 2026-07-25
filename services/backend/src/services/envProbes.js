'use strict';

/**
 * envProbes.js — extensible read-only environment health probe registry.
 *
 * This is the "还有我没认识到的情况" layer of the "打造最佳环境" intent: instead of
 * hardcoding every check into the executor, each environment dimension is a small
 * self-contained probe. Adding a new dimension = append one entry to _PROBES; the
 * aggregator (runProbes) automatically surfaces whatever any probe flags, so
 * situations the user never explicitly named still get reported.
 *
 * PLATFORM DIFFERENTIATION ("注意 linux/windows/macos/android/ios 系统的区分"): a
 * probe entry MAY declare `platforms: ['linux', ...]` to restrict itself to
 * specific operating systems. The aggregator resolves the current OS via
 * envPlatform (which reuses the repo's osProfileService/platformIds authority)
 * and skips probes that do not apply — so load average is not misreported on
 * Windows, and a Windows-only PATH check never runs on Linux. The rule lives in
 * ONE place (the registry + aggregator), never smeared across probes.
 *
 * Contract for a probe:
 *   { key, label, run() => Finding | null }
 * where Finding = { severity: 'critical'|'high'|'warning'|'info', detail, hint? }.
 * A probe returns null when its dimension is healthy (nothing to report), and must
 * NEVER throw — the aggregator also wraps each call defensively. Probes are
 * READ-ONLY: they observe system state (disk %, memory, load, temp/config-dir
 * writability, Node runtime floor) and never mutate anything. Any destructive
 * follow-up stays behind the existing human-confirmation gates (e.g.
 * DiskCleanupTool → riskGate), never here.
 *
 * This module is intentionally NOT a pure leaf: probes read live OS state (statfs,
 * freemem, tmpdir write test) — IO by design, mirroring localBrainEnvOptimize's
 * own self-check dependency. It stays fail-soft.
 *
 * Gate: KHY_ENV_OPTIMIZE_PROBES (default on). When off, runProbes returns [] so the
 * env_optimize report omits the health-probe section (byte-identical fallback).
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

function _probesOn() {
  return String(process.env.KHY_ENV_OPTIMIZE_PROBES || 'true').toLowerCase() !== 'false';
}

// ── Individual probes ────────────────────────────────────────────────────────
// Each returns null when healthy, or a Finding describing the problem. Thresholds
// are conservative so a normal machine reports nothing.

/** Disk fullness on the root/system drive — a "situation you may not notice". */
function _probeDiskPressure() {
  let hw;
  try { hw = require('./hardwareProfileService'); } catch { return null; }
  let d;
  try { d = hw.detectDisk(); } catch { return null; }
  if (!d || !d.totalMB) return null;
  const pct = d.usePercent || 0;
  const availGB = (d.availMB || 0) / 1024;
  if (pct >= 95) {
    return { severity: 'critical', detail: `系统盘已用 ${pct}%，剩余仅 ${availGB.toFixed(1)} GB`, hint: '清理垃圾或迁移大文件，磁盘将满会导致写入失败' };
  }
  if (pct >= 85) {
    return { severity: 'warning', detail: `系统盘已用 ${pct}%，剩余 ${availGB.toFixed(1)} GB`, hint: '建议运行「磁盘清理」回收空间' };
  }
  return null;
}

/** Memory pressure — sustained high usage degrades every subsequent action. */
function _probeMemoryPressure() {
  let total, free;
  try { total = os.totalmem(); free = os.freemem(); } catch { return null; }
  if (!total) return null;
  const usedPct = Math.round((1 - free / total) * 100);
  const freeMB = Math.round(free / 1048576);
  if (usedPct >= 95) {
    return { severity: 'high', detail: `内存已用 ${usedPct}%，可用仅 ${freeMB} MB`, hint: '关闭占用内存的进程，或减小本地模型并发' };
  }
  if (usedPct >= 90) {
    return { severity: 'warning', detail: `内存已用 ${usedPct}%，可用 ${freeMB} MB`, hint: '内存偏紧，重负载任务可能变慢' };
  }
  return null;
}

/** CPU load relative to core count — a machine thrashing under load. */
function _probeLoadAverage() {
  let load, cores;
  try {
    const la = os.loadavg();
    load = Array.isArray(la) ? la[0] : 0;
    cores = os.cpus().length || 1;
  } catch { return null; }
  // loadavg is 0 on Windows (unsupported) — skip rather than misreport.
  if (!load || load <= 0) return null;
  const ratio = load / cores;
  if (ratio >= 4) {
    return { severity: 'high', detail: `1 分钟负载 ${load.toFixed(2)}（${cores} 核，约 ${ratio.toFixed(1)}×）`, hint: '系统严重过载，任务会明显变慢' };
  }
  if (ratio >= 2) {
    return { severity: 'warning', detail: `1 分钟负载 ${load.toFixed(2)}（${cores} 核，约 ${ratio.toFixed(1)}×）`, hint: '负载偏高，可能有失控进程' };
  }
  return null;
}

/** Temp directory writability — a broken/read-only tmp breaks many operations. */
function _probeTempWritable() {
  let dir;
  try { dir = os.tmpdir(); } catch { return null; }
  if (!dir) return null;
  const probe = path.join(dir, `.khy-envprobe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return null; // writable → healthy
  } catch (err) {
    return { severity: 'critical', detail: `临时目录不可写: ${dir}`, hint: `修复权限或磁盘(${err && err.code || 'IO error'})，否则大量操作会失败` };
  }
}

/**
 * khy config/state home (~/.khy) writability — a "missing/damaged environment"
 * dimension distinct from tmp. If this directory exists but cannot be written,
 * config, session state, cached models and whitelists silently fail to persist.
 * When the directory does not yet exist we stay silent (first run is normal and
 * this probe never creates it — read-only by contract).
 */
function _probeConfigHomeWritable() {
  let home;
  try { home = path.join(os.homedir(), '.khy'); } catch { return null; }
  if (!home) return null;
  let exists = false;
  try { exists = fs.existsSync(home) && fs.statSync(home).isDirectory(); } catch { return null; }
  if (!exists) return null; // not initialized yet — not a defect
  const probe = path.join(home, `.envprobe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return null; // writable → healthy
  } catch (err) {
    return { severity: 'critical', detail: `配置目录不可写: ${home}`, hint: `修复权限(${err && err.code || 'IO error'})，否则配置/会话/模型缓存无法持久化` };
  }
}

/**
 * Node.js runtime floor — running below the version declared in the backend's own
 * package.json "engines.node" means language/API features silently break. The
 * floor is read from package.json rather than hardcoded, so bumping engines
 * automatically re-tunes this probe (no scattered version literal to drift).
 */
function _probeNodeRuntime() {
  let floor = 0;
  try {
    const pkg = require('../../package.json');
    const spec = pkg && pkg.engines && pkg.engines.node;
    const m = typeof spec === 'string' ? spec.match(/(\d+)/) : null;
    if (m) floor = parseInt(m[1], 10);
  } catch { return null; }
  if (!floor) return null; // no declared floor → nothing to compare against
  let major = 0;
  try {
    const cur = String(process.versions && process.versions.node || '');
    const m = cur.match(/^(\d+)/);
    if (m) major = parseInt(m[1], 10);
  } catch { return null; }
  if (!major) return null;
  if (major < floor) {
    return { severity: 'high', detail: `Node.js ${process.versions.node} 低于要求的 ≥${floor}`, hint: `升级 Node.js 到 ${floor} 或更高，否则部分功能会静默失效` };
  }
  return null;
}

/**
 * PATH executable-directory writability (Windows-relevant "environment damage").
 * On Windows a common breakage is an entry in PATH that no longer exists, so
 * spawning a bundled tool silently fails. This read-only probe reports PATH
 * entries that are declared but missing on disk. Cross-platform safe, but scoped
 * to Windows in the registry because that is where phantom PATH entries most
 * often cause the "works on my machine" class of failure.
 */
function _probePathIntegrity() {
  let raw;
  try { raw = String(process.env.PATH || ''); } catch { return null; }
  if (!raw) return null;
  const sep = process.platform === 'win32' ? ';' : ':';
  const entries = raw.split(sep).map((e) => e.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  let missing = 0;
  const sample = [];
  for (const e of entries) {
    let ok = false;
    try { ok = fs.existsSync(e); } catch { ok = false; }
    if (!ok) {
      missing++;
      if (sample.length < 3) sample.push(e);
    }
  }
  // A couple of phantom entries is normal noise; only flag a meaningfully broken
  // PATH so a healthy machine stays quiet.
  if (missing >= 3) {
    return {
      severity: 'warning',
      detail: `PATH 中有 ${missing} 个目录不存在（如 ${sample.join('、')}）`,
      hint: '清理失效的 PATH 项，否则调用其中的工具会静默失败',
    };
  }
  return null;
}

// ── Probe registry ───────────────────────────────────────────────────────────
// Append here to teach env_optimize a new dimension. Order = report order. Each
// entry MAY declare `platforms: [...]` to restrict itself to specific operating
// systems (via envPlatform.appliesTo); absent = applies to ALL platforms. This is
// the "注意 linux/windows/macos/android/ios 系统的区分" rule, collected here.
//
// HOW-TO-EXTEND (add a probe — copy this, no other file needs changing):
//   1. Write a `_probeXxx()` above: READ-ONLY (never write/delete/spawn), return
//      null when healthy, or { severity, detail, hint } when there is a problem.
//      severity ∈ 'critical' | 'high' | 'warning' | 'info'.
//   2. Add one line here:  { key: 'xxx', label: '中文标签', run: _probeXxx },
//      (add `platforms: ['windows', ...]` only if it should NOT run everywhere.)
//   3. Add `_probeXxx,` to module.exports (tests reference it).
//   4. Verify:  npm run test:maintainer:env-optimize
//   Full recipe: docs/07_OPS_运维/[OPS-MAN-064] 打造最佳环境-如何扩展.md
const _PROBES = [
  { key: 'disk-pressure', label: '磁盘空间', run: _probeDiskPressure },
  { key: 'memory-pressure', label: '内存压力', run: _probeMemoryPressure },
  // load average is meaningless on Windows (always 0) — scope to POSIX-y OSes.
  { key: 'cpu-load', label: 'CPU 负载', run: _probeLoadAverage, platforms: ['linux', 'macos', 'android', 'harmonyos'] },
  { key: 'temp-writable', label: '临时目录', run: _probeTempWritable },
  { key: 'config-home-writable', label: '配置目录', run: _probeConfigHomeWritable },
  { key: 'node-runtime', label: 'Node 运行时', run: _probeNodeRuntime },
  // phantom PATH entries most often bite on Windows; scope it there.
  { key: 'path-integrity', label: 'PATH 完整性', run: _probePathIntegrity, platforms: ['windows'] },
];

/**
 * Resolve the current platform context (fail-soft). Falls back to a permissive
 * profile so that if envPlatform is unavailable, every probe runs (today's
 * behavior) rather than being silently skipped.
 */
const _platformCtx = require('../utils/platformCtx');

/**
 * Run every registered probe read-only and collect the ones that flagged a
 * problem. Probes whose `platforms` list excludes the current OS are skipped —
 * per-OS differentiation is applied HERE via envPlatform, not inside each probe.
 * Each probe call is wrapped so one throwing probe can never abort the sweep.
 * Returns [] when the sub-gate is off.
 *
 * @returns {Array<{key:string, label:string, severity:string, detail:string, hint?:string}>}
 */
function runProbes() {
  if (!_probesOn()) return [];
  const ctx = _platformCtx();
  const findings = [];
  for (const p of _PROBES) {
    if (!ctx.appliesTo(p, ctx.id)) continue; // platform-scoped out
    let f = null;
    try { f = p.run(); } catch { f = null; }
    if (f && f.detail) {
      findings.push({ key: p.key, label: p.label, severity: f.severity || 'warning', detail: f.detail, hint: f.hint || '' });
    }
  }
  return findings;
}

module.exports = {
  runProbes,
  // exported for tests / extension
  _PROBES,
  _probeDiskPressure,
  _probeMemoryPressure,
  _probeLoadAverage,
  _probeTempWritable,
  _probeConfigHomeWritable,
  _probeNodeRuntime,
  _probePathIntegrity,
};
