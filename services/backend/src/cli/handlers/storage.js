'use strict';

/**
 * Storage Command Handler — system-drive protection.
 *
 * `khy storage` lets the user SEE where khy keeps its data and EXPLICITLY move
 * the data home onto a non-system drive so a full system drive can never crash
 * the host. Placement of net-new generated files happens automatically (see
 * utils/storageRoots.js); moving EXISTING live data (sessions/DB/memory) is the
 * job of `storage migrate` and is always explicit, verified and reversible —
 * honoring the [Eco-Arch-Unresolved] red line in utils/dataHome.js (no silent
 * live-data migration).
 *
 * Commands:
 *   storage [status]                         — show drives + where each home lives
 *   storage migrate [--to <root>]            — copy the data home to a non-system
 *            [--what data|project|all]         drive, flip the pinned pointer,
 *            [--dry-run] [--yes] [--rollback]  keep the source as a backup
 *
 * @module handlers/storage
 */
const fs = require('fs');
const path = require('path');
const chalk = require('chalk').default || require('chalk');
const { printInfo, printError, printSuccess, printWarn } = require('../formatters');
const dh = require('../../utils/dataHome');
const sr = require('../../utils/storageRoots');

/* ── helpers ──────────────────────────────────────────────────────────────── */
// CC 后端口径对齐:字节数 → 人类可读走 CC `formatFileSize` 单一真源(ccFormat SSOT,
// 同 handlers/workspace.js / health.js 已采纳)。门控 KHY_CC_FORMAT(经 ccFormatEnabled)
// 默认开;关 / require 失败 / 非有限输入(NaN/undefined/0)→ 逐字节回退旧本地口径(`0 B` /
// 带空格的 "N.N KB" / 含 TB 档)。
function _fmtBytes(n, env = process.env) {
  try {
    const { ccFormatEnabled, ccFormatFileSize } = require('../ccFormat');
    if (ccFormatEnabled(env)) {
      const out = ccFormatFileSize(n);
      if (out) return out;
    }
  } catch { /* fall through to legacy */ }
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Recursive size + file count, fail-soft, NOT following symlinks. */
function _dirStats(dir, fsImpl = fs) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fsImpl.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isSymbolicLink()) { files++; continue; } // count but never follow/recurse
      if (e.isDirectory()) { stack.push(full); continue; }
      try { bytes += fsImpl.statSync(full).size; files++; } catch { /* skip */ }
    }
  }
  return { bytes, files };
}

/** Device id (posix) or drive letter (win32) identifying the physical volume. */
function _volumeKey(p, deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  const platform = deps.platform || process.platform;
  if (platform === 'win32') {
    const parsed = path.parse(path.resolve(p));
    return (parsed.root || '').toUpperCase();
  }
  try {
    // Walk up to the nearest existing ancestor so a not-yet-created target still
    // resolves to its mount's device id.
    let cur = path.resolve(p);
    while (cur && !fsImpl.existsSync(cur)) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return String(fsImpl.statSync(cur).dev);
  } catch { return null; }
}

/** Map a home kind to its directory name under a target root. */
function _targetDirName(kind) {
  return kind === 'project' ? '.khy-project' : '.khy';
}

/** True if `dir` exists and holds real content (fail-soft, DI-friendly). */
function _isNonEmptyDir(dir, fsImpl = fs) {
  try {
    if (!fsImpl.existsSync(dir)) return false;
    const ignore = new Set(['.location.json', '.location-note-shown']);
    return fsImpl.readdirSync(dir).some((n) => !ignore.has(n));
  } catch { return false; }
}

/* ── pure planner (no writes — safe for --dry-run and tests) ──────────────── */
/**
 * Build a migration plan WITHOUT touching the filesystem beyond reads.
 *
 * @param {object} opts
 * @param {'data'|'project'|'all'} [opts.what]
 * @param {string} [opts.toRoot]   Target drive root (else largest non-system).
 * @param {object} [opts.deps]     DI: { fsImpl, platform, env }.
 * @returns {{ok:boolean, reason?:string, message?:string, targetRoot?:string,
 *            items:Array, warnings:string[]}}
 */
function buildMigrationPlan(opts = {}) {
  const what = opts.what || 'all';
  const deps = opts.deps || {};
  const fsImpl = deps.fsImpl || fs;
  const warnings = [];

  const homes = [];
  if (what === 'data' || what === 'all') {
    homes.push({ kind: 'data', source: opts.dataHome || dh.getDataHome() });
  }
  if (what === 'project' || what === 'all') {
    homes.push({ kind: 'project', source: opts.projectDataHome || dh.getProjectDataHome() });
  }

  // Resolve target root.
  let targetRoot = opts.toRoot;
  if (!targetRoot) {
    const best = sr.pickBestNonSystemDrive(deps);
    if (!best) {
      return { ok: false, reason: 'NO_TARGET', items: [], warnings,
        message: '未发现可用的非系统盘（≥1GB 且可写）。可插入移动盘或用 --to <路径> 指定目标。' };
    }
    targetRoot = best.root;
  }

  if (!sr.isWritable(targetRoot, deps)) {
    return { ok: false, reason: 'TARGET_NOT_WRITABLE', items: [], warnings,
      message: `目标盘不可写：${targetRoot}` };
  }
  const targetFree = sr.freeBytesFor(targetRoot, deps);
  const targetVol = _volumeKey(targetRoot, deps);

  const items = [];
  let totalNeeded = 0;
  for (const h of homes) {
    const target = path.join(targetRoot, _targetDirName(h.kind));
    const srcVol = _volumeKey(h.source, deps);
    const { bytes, files } = _dirStats(h.source, fsImpl);
    const item = { kind: h.kind, source: h.source, target, bytes, files, ok: true, reason: null };

    if (srcVol && targetVol && srcVol === targetVol) {
      item.ok = false; item.reason = 'SAME_DRIVE';
      warnings.push(`${h.kind}: 源与目标在同一物理盘，跳过（${h.source}）`);
    } else if (_isNonEmptyDir(target, fsImpl)) {
      item.ok = false; item.reason = 'TARGET_EXISTS';
      warnings.push(`${h.kind}: 目标已存在且非空，跳过避免覆盖（${target}）`);
    } else {
      totalNeeded += bytes;
    }
    items.push(item);
  }

  const migratable = items.filter((i) => i.ok);
  if (migratable.length === 0) {
    return { ok: false, reason: 'NOTHING_TO_MIGRATE', items, warnings, targetRoot,
      message: '没有可迁移的数据家（全部被跳过，详见上方原因）。' };
  }
  if (targetFree < totalNeeded * 1.1) {
    return { ok: false, reason: 'INSUFFICIENT_SPACE', items, warnings, targetRoot,
      message: `目标盘空间不足：需要约 ${_fmtBytes(Math.ceil(totalNeeded * 1.1))}，可用 ${_fmtBytes(targetFree)}。` };
  }

  return { ok: true, targetRoot, items, warnings, totalBytes: totalNeeded, targetFree };
}

/* ── status (read-only) ───────────────────────────────────────────────────── */
function handleStorageStatus(options = {}) {
  const report = dh.getStorageReport();
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printInfo('khy 存储位置');
  console.log(chalk.dim('  系统盘（写满会拖垮整机）'));
  console.log(`    ${report.systemRoot}  可用 ${_fmtBytes(report.systemFree)} / 共 ${_fmtBytes(report.systemTotal)}`);

  console.log(chalk.dim('  非系统盘（优先落于此处）'));
  if (report.nonSystemDrives.length === 0) {
    console.log('    （未发现可用非系统盘）');
  } else {
    for (const d of report.nonSystemDrives) {
      console.log(`    ${d.root}  可用 ${_fmtBytes(d.freeBytes)} / 共 ${_fmtBytes(d.totalBytes)}  ${d.writable ? '可写' : chalk.red('只读')}`);
    }
  }

  console.log(chalk.dim('  数据家当前解析'));
  const ptr = report.pointer || {};
  const homeLine = (label, dir, source) => {
    let tag = source ? chalk.dim(` [${source}]`) : '';
    let risk = '';
    if (dir && !fs.existsSync(dir)) risk = chalk.red('  ⚠ 目标缺失（数据搁浅风险）');
    console.log(`    ${label}: ${dir}${tag}${risk}`);
  };
  homeLine('数据家   dataHome', report.homes.dataHome, ptr.source);
  homeLine('项目家   projectDataHome', report.homes.projectDataHome, ptr.projectSource);
  homeLine('底座家   baseHome', report.homes.baseHome, null);

  console.log(chalk.dim('  钉位指针'));
  console.log(`    ${report.pointerFile}`);
  if (ptr.pinnedReason || ptr.projectPinnedReason) {
    console.log(chalk.dim(`    原因: data=${ptr.pinnedReason || '-'} project=${ptr.projectPinnedReason || '-'}`));
  }

  console.log('');
  printInfo('迁移到非系统盘：khy storage migrate [--to <路径>] [--dry-run]');
  console.log(chalk.dim('  迁移为显式、校验、可回滚操作；源数据保留为备份，绝不自动删除。'));
}

/* ── migrate (explicit, verified, reversible) ─────────────────────────────── */
async function handleStorageMigrate(args = [], options = {}) {
  // Rollback: restore the previous pinned pointer.
  if (options.rollback) {
    return _handleRollback(options);
  }

  const what = String(options.what || 'all').toLowerCase();
  if (!['data', 'project', 'all'].includes(what)) {
    printError('--what 只能是 data | project | all');
    return;
  }
  const dryRun = Boolean(options['dry-run'] || options.dryRun);
  const toRoot = typeof options.to === 'string' ? options.to : undefined;

  const plan = buildMigrationPlan({ what, toRoot });

  // Always print what we found.
  printInfo(`迁移计划（目标盘：${plan.targetRoot || (toRoot || '自动选择')}）`);
  for (const it of plan.items) {
    const status = it.ok ? chalk.green('将迁移') : chalk.yellow(`跳过(${it.reason})`);
    console.log(`  ${it.kind}: ${it.source}`);
    console.log(`    → ${it.target}  ${_fmtBytes(it.bytes)} / ${it.files} 文件  ${status}`);
  }
  for (const w of plan.warnings) console.log(chalk.dim(`  · ${w}`));

  if (!plan.ok) {
    printWarn(plan.message || '无法迁移');
    return;
  }

  if (dryRun) {
    printInfo('（--dry-run）仅预览，未做任何更改。指针改写预览：');
    for (const it of plan.items.filter((i) => i.ok)) {
      console.log(chalk.dim(`    ${it.kind}Home: ${it.source}  →  ${it.target}`));
    }
    return;
  }

  // Confirm (unless --yes / non-interactive guard).
  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      printError('非交互环境请加 --yes 确认迁移');
      return;
    }
    let ok = false;
    try {
      const { promptCompat } = require('../uiPrompt');
      const ans = await promptCompat([{
        type: 'confirm', name: 'ok', default: false,
        message: `确认复制上述数据家到 ${plan.targetRoot} 并切换指针？（源保留为备份）`,
      }]);
      ok = !!ans.ok;
    } catch { ok = false; }
    if (!ok) { printInfo('已取消，未做任何更改。'); return; }
  }

  // Execute: copy → verify → flip pointer (source kept as backup).
  const result = executeMigration(plan);
  if (!result.ok) {
    printError(`迁移失败：${result.message}`);
    printInfo('源数据未改动，指针未切换。');
    return;
  }
  printSuccess(`迁移完成：${result.migrated.map((m) => m.kind).join(', ')} → ${plan.targetRoot}`);
  for (const m of result.migrated) {
    console.log(`  ${m.kind}: ${m.target}  (${_fmtBytes(m.bytes)} / ${m.files} 文件，已校验)`);
  }
  printInfo('源数据保留为备份。回滚：khy storage migrate --rollback');
  printWarn('建议重启 khy 以让新位置全面生效。');
}

/**
 * Perform the copy + verify + pointer flip. Source is never modified; on any
 * verification mismatch the pointer is NOT changed.
 * @param {object} plan  Output of buildMigrationPlan (must be ok).
 * @param {object} [deps] DI: { fsImpl }.
 */
function executeMigration(plan, deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  const migrated = [];
  const pointerPatch = {};
  const previous = {};

  for (const it of plan.items.filter((i) => i.ok)) {
    try {
      fsImpl.cpSync(it.source, it.target, { recursive: true, errorOnExist: false, force: true, dereference: false });
    } catch (e) {
      return { ok: false, message: `复制失败 (${it.kind}): ${e.message}`, migrated };
    }
    // Verify by re-counting the copied tree.
    const after = _dirStats(it.target, fsImpl);
    if (after.files < it.files || after.bytes < it.bytes) {
      return { ok: false,
        message: `校验失败 (${it.kind}): 目标 ${after.files} 文件/${after.bytes}B < 源 ${it.files}/${it.bytes}B`,
        migrated };
    }
    if (it.kind === 'data') { pointerPatch.dataHome = it.target; pointerPatch.source = 'migrated'; pointerPatch.pinnedReason = 'migrate'; previous.dataHome = it.source; }
    if (it.kind === 'project') { pointerPatch.projectDataHome = it.target; pointerPatch.projectSource = 'migrated'; pointerPatch.projectPinnedReason = 'migrate'; previous.projectDataHome = it.source; }
    migrated.push({ kind: it.kind, target: it.target, bytes: after.bytes, files: after.files });
  }

  if (migrated.length === 0) return { ok: false, message: '没有完成任何迁移', migrated };

  // Atomic pointer flip, stashing prior values for rollback.
  const existing = dh._readPointer() || {};
  pointerPatch.previous = { ...(existing.previous || {}), ...previous };
  dh._writePointer(pointerPatch);
  // Reset resolver caches so a follow-up resolution in this process sees the new home.
  try { dh._resetStorageCaches(); } catch { /* ignore */ }

  return { ok: true, migrated };
}

function _handleRollback(options = {}) {
  const ptr = dh._readPointer();
  if (!ptr || !ptr.previous || (!ptr.previous.dataHome && !ptr.previous.projectDataHome)) {
    printWarn('没有可回滚的上一次迁移记录。');
    return;
  }
  const prev = ptr.previous;
  const patch = {};
  if (prev.dataHome) { patch.dataHome = prev.dataHome; patch.source = 'rollback'; patch.pinnedReason = 'rollback'; }
  if (prev.projectDataHome) { patch.projectDataHome = prev.projectDataHome; patch.projectSource = 'rollback'; patch.projectPinnedReason = 'rollback'; }
  patch.previous = {}; // clear after rollback
  dh._writePointer(patch);
  try { dh._resetStorageCaches(); } catch { /* ignore */ }
  printSuccess('已回滚指针到迁移前位置：');
  if (prev.dataHome) console.log(`  dataHome: ${prev.dataHome}`);
  if (prev.projectDataHome) console.log(`  projectDataHome: ${prev.projectDataHome}`);
  printInfo('迁移时复制到非系统盘的副本仍保留，可手动删除。重启 khy 生效。');
}

function _printHelp() {
  printInfo('khy storage — 存储位置与系统盘保护');
  console.log('  storage status                      查看磁盘与数据家位置');
  console.log('  storage migrate [--to <路径>]        迁移数据家到非系统盘');
  console.log('    --what data|project|all           选择迁移范围（默认 all）');
  console.log('    --dry-run                         仅预览，不做更改');
  console.log('    --yes                             跳过交互确认');
  console.log('    --rollback                        回滚到上一次迁移前位置');
  console.log(chalk.dim('  净增大体量文件已自动优先非系统盘；迁移既有数据为显式、校验、可回滚操作。'));
}

async function handleStorageCommand(subCommand, args = [], options = {}) {
  switch (subCommand) {
    case 'migrate':
      return handleStorageMigrate(args, options);
    case 'help':
      return _printHelp();
    case 'status':
    default:
      return handleStorageStatus(options);
  }
}

module.exports = {
  handleStorageCommand,
  handleStorageStatus,
  handleStorageMigrate,
  buildMigrationPlan,
  executeMigration,
  // exported for tests
  _dirStats,
  _volumeKey,
  _isNonEmptyDir,
  _fmtBytes,
};
