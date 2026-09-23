#!/usr/bin/env node
/**
 * @pattern Facade, Strategy
 *
 * check-gov-status.js — a single, read-only "governance status" view that
 * aggregates the version-sync tracks, the ruleguard coverage snapshot, and the
 * active-suppression ledger into ONE pass.
 *
 * Borrowed from Changesets' `changeset status` (one command answers "what's
 * pending / how will it bump") and Renovate/Backstage scorecards (a single
 * per-entity object a dashboard can render). This is the CH-2 service-call
 * shape: pure reads, no writes, no network, safe for the 10-minute scheduled
 * task (autopull) or a human "is the repo healthy?" glance.
 *
 * What it aggregates (all computed in-process, no subprocess fan-out):
 *   1. version tracks — run check-version-sync's pure runner against the repo
 *      root and report each track's version (or the failure reason), plus
 *      whether every value is valid semver.
 *   2. rule coverage  — ruleguard's buildCoverage() snapshot: total/enforced
 *      rate, by-priority, dead pointers, unenforced P0 red lines.
 *   3. suppression ledger — the active suppression counts from the ledger.
 *   4. governance wiring — whether the gov-rules entry point is registered in
 *      package.json scripts and the PR-gate workflow (the GOV-TOOL-005
 *      invariants).
 *
 * Output:
 *   human table by default; `--json` for machine-readable (CI / scheduler).
 *
 * Exit code: 0 when every aggregated section is green; 1 when any blocking
 * red line is hit (version mismatch / non-semver / P0 unenforced / dead
 * pointer / missing governance wiring). Soft indicators (coverage rate,
 * suppression counts) are reported but never block on their own — matching
 * ruleguard's "only red lines block" contract.
 *
 * Fixture root: KHY_GOV_RULES_ROOT (shared with check-gov-rules.js) and
 * KHY_VERSION_SYNC_ROOT (shared with check-version-sync.js) let a caller
 * point the status view at a synthetic tree without touching process.cwd().
 *
 * Single source of truth: both the authoritative verdict (versionSync.runMain)
 * AND the per-source semver table come from check-version-sync's exported
 * VERSION_GROUPS / VERSION_SPECS / INIT_FILE. Do not re-inline them here — a
 * hand-copied list silently drifts the moment a fourth track is declared, and
 * this view would then report "all tracks OK" off a stale source list.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const versionSync = require('./check-version-sync.js');
const coverage = require('../ruleguard/lib/coverage.js');
const ledger = require('../ruleguard/lib/ledger.js');

const GOVERNANCE_DOC = 'docs/10_规范/其它规范/[DESIGN-GOV-001] 治理总纲与可执行规则.md';

function readText(repoRoot, relPath) {
  const abs = path.join(repoRoot, relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

/**
 * Run the version-sync group checks against the repo root without exiting the
 * process: catch the thrown error so the status view can report "track X
 * failed: <reason>" instead of aborting the whole aggregate.
 *
 * @returns {{tracks: Array<{group, version, ok, error}>, allSemver: boolean}}
 */
function collectVersionTracks(repoRoot) {
  const tracks = [];
  let allSemver = true;

  // 1) Run the full gate as the authoritative verdict in QUIET mode so the
  //    status view renders its own version-track table without duplicated
  //    "All version sync checks passed." noise from the underlying gate.
  try {
    versionSync.runMain(repoRoot, { quiet: true });
    for (const group of versionSync.VERSION_GROUPS) {
      tracks.push({ group: group.id, ok: true, version: undefined, error: '' });
    }
  } catch (error) {
    for (const group of versionSync.VERSION_GROUPS) {
      tracks.push({ group: group.id, ok: false, version: undefined, error: error.message });
    }
  }

  // 2) Semver validity: re-read each source through the shared isSemver check,
  //    walking the SAME spec list the gate itself uses (VERSION_SPECS +
  //    INIT_FILE), so this table can never describe a different set of sources
  //    than the one that was just verified.
  const readers = versionSync.makeReaders(repoRoot);
  const specs = versionSync.VERSION_SPECS || [];
  for (const spec of specs) {
    let value = '';
    try {
      const match = readers.readText(spec.file).match(spec.regex);
      value = match ? match[1] : '';
    } catch {
      value = '';
    }
    if (!versionSync.isSemver(value)) {
      allSemver = false;
      tracks.push({ group: 'semver', file: spec.file, ok: false, version: value, error: 'not valid semver' });
    }
  }
  return { tracks, allSemver };
}

/**
 * Aggregate the active suppression counts (ruleId -> count) from the ledger,
 * reporting 0 cleanly when the ledger is absent or empty.
 * @returns {Object<string, number>}
 */
function collectSuppressions(repoRoot) {
  try {
    return ledger.activeSuppressions(repoRoot) || {};
  } catch {
    return {};
  }
}

/**
 * Verify the GOV-TOOL-005 invariants: the gov-rules entry point is registered
 * in package.json scripts and the PR-gate workflow runs it. Returns a list of
 * human-readable gap lines (empty = all wired).
 * @returns {string[]}
 */
function collectWiringGaps(repoRoot) {
  const gaps = [];
  const packageText = readText(repoRoot, 'package.json');
  const packageJson = packageText ? JSON.parse(packageText) : null;
  const scripts = (packageJson && packageJson.scripts) || {};
  if (scripts['check:gov-rules'] !== 'node scripts/ci/check-gov-rules.js') {
    gaps.push('check:gov-rules 未精确指向 scripts/ci/check-gov-rules.js');
  }
  if (!String(scripts['check:structure'] || '').includes('npm run check:gov-rules')) {
    gaps.push('check:structure 未调用 check:gov-rules');
  }
  const workflow = readText(repoRoot, '.github/workflows/pr-gate.yml');
  if (workflow === null || !workflow.includes('node scripts/ci/check-gov-rules.js')) {
    gaps.push('PR gate 未显式执行治理规则检查');
  }
  const govDoc = readText(repoRoot, GOVERNANCE_DOC);
  if (govDoc === null) {
    gaps.push(`治理总纲缺失: ${GOVERNANCE_DOC}`);
  }
  return gaps;
}

function collectCoverage(repoRoot) {
  try {
    const data = coverage.buildCoverage(repoRoot);
    return {
      ok: data.redLines.length === 0 && data.registry.errors.length === 0,
      total: data.total,
      enforced: data.enforced,
      rate: data.rate,
      byPriority: data.byPriority,
      redLines: data.redLines,
      unenforcedCount: data.unenforced.length,
      deadPointerCount: data.deadPointers.length,
      registryErrors: data.registry.errors,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function buildStatus(repoRoot) {
  const version = collectVersionTracks(repoRoot);
  const cov = collectCoverage(repoRoot);
  const suppressions = collectSuppressions(repoRoot);
  const wiringGaps = collectWiringGaps(repoRoot);

  const blocking =
    version.tracks.some((t) => !t.ok) ||
    !version.allSemver ||
    !cov.ok ||
    wiringGaps.length > 0;

  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    ok: !blocking,
    version,
    coverage: cov,
    suppressions,
    wiringGaps,
  };
}

function printHuman(status) {
  const lines = [];
  lines.push('=== 治理状态总览（只读，未做任何写操作） ===');
  lines.push(`生成时间: ${status.generatedAt}`);
  lines.push('');

  lines.push('── 版本轨道 ──');
  for (const track of status.version.tracks) {
    const flag = track.ok ? '  [OK] ' : '[ERR] ';
    const detail = track.error ? ` ${track.error}` : (track.version ? ` ${track.version}` : '');
    lines.push(`${flag} ${track.file ? track.file + ' (' : '('}${track.group})${track.file ? ')' : ''}${detail}`.trim());
  }
  lines.push(`  semver 合法性: ${status.version.allSemver ? '全部合法' : '存在非 semver 值（见上）'}`);
  lines.push('');

  lines.push('── 规则覆盖率（ruleguard） ──');
  if (status.coverage.error) {
    lines.push(`  [ERR] 覆盖率不可用: ${status.coverage.error}`);
  } else {
    lines.push(`  已执行 ${status.coverage.enforced}/${status.coverage.total}（${status.coverage.rate}%）`);
    for (const [p, n] of Object.entries(status.coverage.byPriority || {})) {
      lines.push(`    ${p.padEnd(4)} ${n}`);
    }
    lines.push(`  阻断红线: ${status.coverage.redLines.length === 0 ? '全部通过' : `命中 ${status.coverage.redLines.length} 条`}`);
    if (status.coverage.redLines.length) {
      for (const r of status.coverage.redLines) lines.push(`    [ERROR] ${r.rule || r.code} ${r.message}`);
    }
    lines.push(`  未挂载执行器: ${status.coverage.unenforcedCount} | 死指针: ${status.coverage.deadPointerCount}`);
  }
  lines.push('');

  lines.push('── 抑制台账 ──');
  const sup = Object.entries(status.suppressions);
  if (sup.length === 0) {
    lines.push('  无活跃抑制');
  } else {
    for (const [ruleId, count] of sup) lines.push(`  ${ruleId}: ${count} 次`);
  }
  lines.push('');

  lines.push('── 治理接线（GOV-TOOL-005） ──');
  if (status.wiringGaps.length === 0) {
    lines.push('  全部接线齐全');
  } else {
    for (const gap of status.wiringGaps) lines.push(`  [GAP] ${gap}`);
  }
  lines.push('');

  lines.push(`=== 总判定: ${status.ok ? '绿灯（可进入发布门）' : '存在阻断红线，需处理'} ===`);
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const repoRoot = process.env.KHY_VERSION_SYNC_ROOT
    ? path.resolve(process.env.KHY_VERSION_SYNC_ROOT)
    : process.cwd();

  const status = buildStatus(repoRoot);
  if (asJson) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(printHuman(status));
  }
  process.exitCode = status.ok ? 0 : 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  buildStatus,
  collectVersionTracks,
  collectSuppressions,
  collectWiringGaps,
  collectCoverage,
};
