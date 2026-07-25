'use strict';

/**
 * envRepair.js — extensible SAFE self-repair registry for "打造最佳环境".
 *
 * This is the "缺失损坏 ... 修复" layer: where envProbes.js only *detects* an
 * environment gap (e.g. a missing khy config home) and prints a hint, this module
 * actually *fixes* the safely-fixable ones. It is the mutating counterpart to the
 * read-only probe sweep, and it is deliberately conservative:
 *
 *   SAFETY CONTRACT (non-negotiable):
 *     1. CREATE-MISSING-ONLY. A repair may create missing scaffolding (mkdir -p a
 *        config dir). It must NEVER delete, overwrite, or truncate anything the
 *        user owns. Destructive cleanup (junk removal) stays behind
 *        DiskCleanupTool.isDestructive → riskGate human confirmation, never here.
 *     2. IDEMPOTENT. Running twice is a no-op the second time — an already-healthy
 *        dimension returns null (nothing changed), so re-running "打造最佳环境"
 *        never churns the filesystem.
 *     3. FAIL-SOFT. A repair that cannot complete returns {ok:false} with a reason
 *        and never throws; the aggregator also wraps each call defensively.
 *     4. NON-DESTRUCTIVE ON CORRUPTION. If a path exists but is the wrong type
 *        (e.g. ~/.khy is a file, not a directory), the repair does NOT remove it —
 *        that would risk user data. It reports ok:false and defers to the human.
 *
 *   Repair contract:
 *     { key, label, run() => RepairResult | null }
 *   where RepairResult = { ok:boolean, changed:boolean, detail:string }.
 *   null  = dimension already healthy, nothing to do (the common, quiet case).
 *   changed:true  = this run created/fixed something.
 *   ok:false      = attempted but could not complete safely (deferred to human).
 *
 * This module is intentionally NOT a pure leaf: repairs touch the filesystem
 * (mkdir) — IO by design, mirroring envProbes' live-state reads. It stays
 * fail-soft.
 *
 * Gate: KHY_ENV_OPTIMIZE_REPAIR (default on). When off, runRepairs returns [] so
 * env_optimize performs detection-only (byte-identical to the pre-repair report).
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

function _repairOn() {
  return String(process.env.KHY_ENV_OPTIMIZE_REPAIR || 'true').toLowerCase() !== 'false';
}

// ── Individual repairs ───────────────────────────────────────────────────────
// Each returns null when healthy, a RepairResult when it acted or safely could
// not. CREATE-MISSING-ONLY — see the SAFETY CONTRACT above.

/**
 * Ensure the khy config/state home (~/.khy) exists as a writable directory. This
 * is the mutating counterpart to envProbes' config-home-writable check: a missing
 * home means config, session state and model caches cannot persist. We create it
 * with mkdir -p (idempotent). If it exists but is a FILE (corrupt state) we do NOT
 * delete it — that is destructive and stays with the human.
 */
function _repairConfigHome() {
  let home;
  try { home = path.join(os.homedir(), '.khy'); } catch { return null; }
  if (!home) return null;

  let stat = null;
  try { stat = fs.statSync(home); } catch { stat = null; }

  if (stat && stat.isDirectory()) return null; // already healthy → idempotent no-op

  if (stat && !stat.isDirectory()) {
    // Exists but wrong type — removing it could destroy user data. Defer.
    return { ok: false, changed: false, detail: `配置目录路径被文件占用，需人工处理: ${home}` };
  }

  // Missing → create it (create-missing-only, the safe case).
  try {
    fs.mkdirSync(home, { recursive: true });
    return { ok: true, changed: true, detail: `已创建缺失的配置目录: ${home}` };
  } catch (err) {
    return { ok: false, changed: false, detail: `无法创建配置目录 ${home}（${(err && err.code) || 'IO error'}）` };
  }
}

// ── Repair registry ──────────────────────────────────────────────────────────
// Append here to teach env_optimize a new SAFE repair. Order = execution/report
// order. Keep every entry within the SAFETY CONTRACT (create-missing-only). Each
// entry MAY declare `platforms: [...]` to restrict itself to specific operating
// systems (via envPlatform.appliesTo) — the "注意 …系统的区分" rule. Sandboxed
// mobile OSes (iOS/HarmonyOS) constrain filesystem repair, so system-scaffolding
// repairs are scoped to the desktop/server OSes where ~/.khy is the real model.
//
// HOW-TO-EXTEND (add a repair — copy this, no other file needs changing):
//   1. Write a `_repairXxx()` above. SAFETY CONTRACT (non-negotiable):
//      create-missing-only — NEVER delete/overwrite/truncate the user's data;
//      return null when already healthy (idempotent); never throw; and if a path
//      exists with the wrong type, return { ok:false } and defer to the human.
//   2. Add one line here:
//        { key: 'xxx', label: '中文标签', run: _repairXxx, platforms: ['linux', 'windows', 'macos', 'android'] }
//      (drop `platforms` to run everywhere; keep sandboxed ios/harmonyos out of
//      filesystem-scaffolding repairs.)
//   3. Add `_repairXxx,` to module.exports (tests reference it).
//   4. Verify:  npm run test:maintainer:env-optimize
//   Destructive cleanup does NOT belong here — it stays behind the riskGate
//   human gate (the `磁盘清理` command). Full recipe:
//   docs/07_OPS_运维/[OPS-MAN-064] 打造最佳环境-如何扩展.md
const _REPAIRS = [
  { key: 'config-home', label: '配置目录', run: _repairConfigHome, platforms: ['linux', 'windows', 'macos', 'android'] },
];

/**
 * Resolve the current platform context (fail-soft). Falls back to a permissive
 * profile so an unavailable envPlatform runs every repair (today's behavior)
 * rather than silently skipping.
 */
const _platformCtx = require('../utils/platformCtx');

/**
 * Run every registered repair and collect the ones that actually acted (created
 * something) or safely could not (deferred to human). Repairs whose `platforms`
 * list excludes the current OS are skipped — per-OS differentiation is applied
 * HERE via envPlatform, not inside each repair. Healthy dimensions (null) are
 * omitted so a fully-healthy machine yields []. Each repair call is wrapped so
 * one throwing repair can never abort the sweep. Returns [] when the sub-gate is
 * off (detection-only mode).
 *
 * @returns {Array<{key:string, label:string, ok:boolean, changed:boolean, detail:string}>}
 */
function runRepairs() {
  if (!_repairOn()) return [];
  const ctx = _platformCtx();
  const results = [];
  for (const r of _REPAIRS) {
    if (!ctx.appliesTo(r, ctx.id)) continue; // platform-scoped out
    let res = null;
    try { res = r.run(); } catch { res = null; }
    if (res && res.detail) {
      results.push({
        key: r.key,
        label: r.label,
        ok: res.ok !== false,
        changed: res.changed === true,
        detail: res.detail,
      });
    }
  }
  return results;
}

module.exports = {
  runRepairs,
  // exported for tests / extension
  _REPAIRS,
  _repairConfigHome,
};
