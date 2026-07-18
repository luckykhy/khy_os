'use strict';

/**
 * replayEngine.js — deterministic trajectory replay (DESIGN-ARCH-048 PHASE 4).
 *
 * Re-executes a recorded trajectory WITHOUT any AI to reproduce its file
 * artifacts, under the user's "relatively static environment" assumption. Steps
 * run through the single executeTool funnel (file lock / path normalization /
 * registry validation all stay in force), gated by replay tier:
 *
 *   FILE        → auto-replayed.
 *   SHELL       → replayed only when pre-approved (KHY_REPLAY_SHELL_ALLOW / opts)
 *                 or confirmed via opts.confirm(step); otherwise skipped.
 *   NETWORK_AI  → never replayed; surfaced as "non-deterministic, not reproduced".
 *
 * Six 防呆 red lines enforced here:
 *   ① hot path untouched — this is an offline tool, not on the recording path.
 *   ② AI never enters the loop — NETWORK_AI is always skipped; no model is imported.
 *   ③ divergence halts — any per-step artifact hash mismatch HALTs immediately
 *      with seq + path + expected/actual; never a silent "best-effort fix".
 *   ④ no privilege escalation — EXEC_APPROVED is stamped per qualifying step only;
 *      unapproved SHELL is skipped before the gate; file lock retained.
 *   ⑤ env mismatch is explicit — default refuse + list all diffs; only --force proceeds.
 *   ⑥ never destroy un-recorded data — delete/overwrite verifies the precondition
 *      hash (== beforeHash) first; an unexpected prior state HALTs; per-step
 *      activity timeout backstops a hung tool.
 */

const fs = require('fs');

const tierRegistry = require('./tierRegistry');
const artifactHash = require('./artifactHash');
const envFingerprint = require('./envFingerprint');
const replayBundle = require('./replayBundle');

const DEFAULT_STEP_TIMEOUT_MS = 120000;

function _stepTimeoutMs(opts) {
  if (opts && Number.isFinite(opts.activityTimeoutMs) && opts.activityTimeoutMs > 0) {
    return opts.activityTimeoutMs;
  }
  const n = parseInt(process.env.KHY_REPLAY_STEP_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STEP_TIMEOUT_MS;
}

/** Parse the env-configured pre-approved SHELL command patterns. */
function _shellAllowList(opts) {
  const fromOpts = Array.isArray(opts && opts.preApprovedShell) ? opts.preApprovedShell : [];
  const raw = process.env.KHY_REPLAY_SHELL_ALLOW;
  const fromEnv = (raw == null || raw === '' ? '' : raw)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...fromOpts, ...fromEnv];
}

/** Decide whether a SHELL step is pre-approved by a command pattern. */
function _shellPreApproved(step, allowList) {
  if (!allowList.length) return false;
  const command = step && step.params && typeof step.params.command === 'string'
    ? step.params.command
    : '';
  if (!command) return false;
  try {
    const { matchCommandPattern } = require('../execApproval');
    return allowList.some((p) => matchCommandPattern(command, p));
  } catch {
    return false;
  }
}

/** Stamp the unforgeable EXEC_APPROVED symbol onto a params clone. */
function _approveParams(params) {
  const clone = params && typeof params === 'object' ? { ...params } : {};
  try {
    const { EXEC_APPROVED } = require('../execApproval');
    if (EXEC_APPROVED) clone[EXEC_APPROVED] = true;
  } catch { /* without the symbol the funnel may prompt; replay opts handle that */ }
  return clone;
}

/**
 * Build the control responder the engine hands to executeTool for a step the
 * tier gate has ALREADY approved for replay (防呆④). The syscall gateway runs
 * before requestPermission and evaluates independently of EXEC_APPROVED, so the
 * engine answers its control channel as a non-interactive but policy-driven host:
 * approve and supply the L2 typed-confirmation word. This fires only for steps
 * the engine decided to replay (FILE always; SHELL only when pre-approved/
 * confirmed) — NETWORK_AI is skipped before ever reaching the funnel — so it is
 * bounded to the user's locked replay policy and never a global loosening.
 */
function _replayControlResponder() {
  const L2_WORD = process.env.KHY_REPLAY_L2_CONFIRM || 'YES';
  return async () => ({ behavior: 'allow', typed: L2_WORD });
}

/** Run executeTool under a hard activity-timeout. */
async function _executeWithTimeout(step, params, timeoutMs) {
  const { executeTool } = require('../toolCalling');
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`step timeout after ${timeoutMs}ms`)), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([
      executeTool(step.name, params, {
        sessionId: step._sessionId || null,
        source: 'replay',
        replay: true,
        onControlRequest: _replayControlResponder(),
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pre-execution guard (防呆⑥): inspect on-disk state vs. the recorded artifact.
 * @returns {{decision:'proceed'|'satisfied'|'halt', reason?:string, detail?:object}}
 */
function _preconditionCheck(step) {
  const arts = Array.isArray(step.artifacts) ? step.artifacts : [];
  for (const a of arts) {
    if (!a || !a.path) continue;
    const before = step.writeDiff && step.writeDiff.beforeHash != null ? step.writeDiff.beforeHash : null;
    const current = artifactHash.hashFile(a.path); // null if file absent

    // Already at the recorded terminal state → nothing to do.
    if (a.op === 'delete') {
      if (current === null) return { decision: 'satisfied', reason: '目标已不存在' };
    } else if (a.sha256 && current === a.sha256) {
      return { decision: 'satisfied', reason: '产物已是目标状态' };
    }

    // Overwrite/delete with an unexpected prior state → refuse (never clobber
    // un-recorded data). A create over a *missing* file (before=null,current=null)
    // is fine; a create over an existing different file is a divergence.
    const isMutation = a.op === 'modify' || a.op === 'delete';
    if (isMutation && before !== null && current !== null && current !== before) {
      return {
        decision: 'halt',
        reason: '前置状态分歧：目标当前内容与录制时不一致',
        detail: { path: a.path, expected: before, actual: current },
      };
    }
    if (a.op === 'create' && current !== null && before === null && a.sha256 && current !== a.sha256) {
      return {
        decision: 'halt',
        reason: '前置状态分歧：将创建的目标已存在且内容不同',
        detail: { path: a.path, expected: null, actual: current },
      };
    }
  }
  return { decision: 'proceed' };
}

/**
 * Post-execution verify (防呆③): recompute each artifact hash and compare.
 * @returns {{ok:true}|{ok:false, detail:object}}
 */
function _verifyArtifacts(step) {
  const arts = Array.isArray(step.artifacts) ? step.artifacts : [];
  for (const a of arts) {
    if (!a || !a.path) continue;
    if (a.op === 'delete') {
      if (fs.existsSync(a.path)) {
        return { ok: false, detail: { path: a.path, expected: '(deleted)', actual: '(exists)' } };
      }
      continue;
    }
    if (!a.sha256) continue;
    const actual = artifactHash.hashFile(a.path);
    if (actual !== a.sha256) {
      return { ok: false, detail: { path: a.path, expected: a.sha256, actual } };
    }
  }
  return { ok: true };
}

/**
 * Optional AI repair bridge (DESIGN-ARCH-049, capability A). When the
 * deterministic core cannot proceed on a step, the caller MAY inject an
 * `opts.repair(step, ctx)` hook that drives an AI sub-agent to reproduce the
 * recorded artifact. The engine itself stays model-free (防呆①): no model is
 * imported here; the model lives only inside the injected closure.
 *
 * Invariant (防呆②): success is decided SOLELY by re-running _verifyArtifacts
 * against the recorded sha256 — the bridge never rewrites a recorded file or the
 * recorded hash to force a match. One attempt per call site; the hook enforces
 * its own per-seq cap (mirrors selfHeal MAX_LOOP=1).
 *
 * @returns {Promise<null|{decision:'repaired'}|{decision:'halt',reason?:string,detail?:object}>}
 *   null when no hook is wired (caller keeps its original deterministic path);
 *   'repaired' when the post-repair hash matches; 'halt' otherwise.
 */
async function _maybeRepair(step, opts, kind) {
  if (typeof opts.repair !== 'function') return null; // zero-regression gate: no hook ⇒ 048 engine
  let r;
  try {
    r = await opts.repair(step, { kind });
  } catch (e) {
    return { decision: 'halt', reason: `repair error: ${e && e.message ? e.message : String(e)}` };
  }
  if (!r || r.attempted === false) return null; // bridge declined ⇒ fall through to original path
  const v = _verifyArtifacts(step); // sha256 is still the sole oracle
  if (v.ok) return { decision: 'repaired' };
  return { decision: 'halt', reason: r.reason || '产物哈希分歧（修复后仍不一致）', detail: v.detail };
}

/** Record a step the AI bridge successfully reproduced (counts as replayed). */
function _applyRepaired(rec, step, report) {
  rec.action = 'repaired';
  rec.reason = 'AI 桥接复现（哈希校验通过）';
  rec.verify = { ok: true };
  report.summary.replayed += 1;
  report.summary.repaired += 1;
  if (Array.isArray(step.artifacts) && step.artifacts.some((a) => a && a.op !== 'delete')) {
    report.summary.restored += 1;
  }
}

/** Record a hard halt raised by the AI bridge (status 'diverged', halts replay). */
function _applyRepairHalt(rec, step, report, fix) {
  rec.action = 'halted';
  rec.reason = fix.reason || 'AI 桥接修复失败';
  if (fix.detail) rec.verify = { ok: false, ...fix.detail };
  report.summary.halted += 1;
  report.status = 'diverged';
  report.divergedAt = step.seq;
}

/** Resolve the input into { manifest, bundleDir }. */
function _resolveBundle(bundle) {
  if (typeof bundle === 'string') {
    const r = replayBundle.readBundle(bundle);
    if (!r.ok) return { error: r.error };
    return { manifest: r.manifest, bundleDir: bundle };
  }
  if (bundle && bundle.manifest) return { manifest: bundle.manifest, bundleDir: bundle.bundleDir || null };
  if (bundle && Array.isArray(bundle.steps)) return { manifest: bundle, bundleDir: bundle._bundleDir || null };
  return { error: 'unrecognized bundle input' };
}

/**
 * Replay a bundle.
 * @param {string|object} bundle  a bundle directory path, a readBundle() result, or a manifest
 * @param {object} [opts]
 * @param {boolean} [opts.force]            proceed despite an environment mismatch
 * @param {string[]} [opts.preApprovedShell] pre-approved SHELL command patterns
 * @param {(step)=>Promise<boolean>|boolean} [opts.confirm] gate for un-pre-approved SHELL
 * @param {number} [opts.resumeFromSeq]     skip steps with seq < this value
 * @param {(ev)=>void} [opts.onStep]        per-step progress callback (状态透明)
 * @param {number} [opts.activityTimeoutMs] per-step timeout override
 * @param {(step, ctx)=>Promise<object>} [opts.repair] optional AI repair bridge
 *   (DESIGN-ARCH-049). Invoked when the deterministic core cannot proceed on a
 *   step; must return `{attempted, ok?, reason?, ...}`. The engine re-verifies the
 *   recorded sha256 itself — the hook never decides success. Absent ⇒ pure 048.
 * @returns {Promise<ReplayReport>}
 */
async function replay(bundle, opts = {}) {
  const resolved = _resolveBundle(bundle);
  if (resolved.error) {
    return { status: 'error', error: resolved.error, envDiffs: [], steps: [], divergedAt: null,
      summary: { replayed: 0, skipped: 0, halted: 0, restored: 0, repaired: 0 } };
  }
  const { manifest } = resolved;
  const steps = (Array.isArray(manifest.steps) ? manifest.steps : []).slice().sort((a, b) => a.seq - b.seq);
  const sessionId = manifest.sessionId || null;

  const report = {
    status: 'completed',
    envDiffs: [],
    steps: [],
    divergedAt: null,
    summary: { replayed: 0, skipped: 0, halted: 0, restored: 0, repaired: 0 },
  };

  const emit = (ev) => { try { if (typeof opts.onStep === 'function') opts.onStep(ev); } catch { /* ignore */ } };

  // ── 防呆⑤ Environment gate ──────────────────────────────────────────
  const cmp = envFingerprint.compare(manifest.env, envFingerprint.capture());
  report.envDiffs = cmp.diffs;
  if (!cmp.match && !opts.force) {
    report.status = 'env-mismatch';
    return report;
  }

  const timeoutMs = _stepTimeoutMs(opts);
  const allowList = _shellAllowList(opts);
  const resumeFromSeq = Number.isFinite(opts.resumeFromSeq) ? opts.resumeFromSeq : -Infinity;

  for (const step of steps) {
    if (step.seq < resumeFromSeq) continue;
    const tier = step.tier || tierRegistry.effectiveTier(step.name);
    const rec = { seq: step.seq, name: step.name, tier, action: null, verify: null, reason: null };

    // ② NETWORK_AI is never reproduced deterministically.
    if (tier === 'NETWORK_AI') {
      const fix = await _maybeRepair(step, opts, 'network_ai');
      if (fix && fix.decision === 'repaired') {
        _applyRepaired(rec, step, report);
        report.steps.push(rec); emit(rec); continue;
      }
      if (fix && fix.decision === 'halt') {
        _applyRepairHalt(rec, step, report, fix);
        report.steps.push(rec); emit(rec); return report;
      }
      rec.action = 'skipped';
      rec.reason = '不可确定性复现（网络/AI）';
      report.summary.skipped += 1;
      report.steps.push(rec); emit(rec); continue;
    }

    // ④ SHELL requires pre-approval or explicit confirmation.
    if (tier === 'SHELL') {
      let allowed = _shellPreApproved(step, allowList);
      if (!allowed && typeof opts.confirm === 'function') {
        try { allowed = !!(await opts.confirm(step)); } catch { allowed = false; }
      }
      if (!allowed) {
        const fix = await _maybeRepair(step, opts, 'shell');
        if (fix && fix.decision === 'repaired') {
          _applyRepaired(rec, step, report);
          report.steps.push(rec); emit(rec); continue;
        }
        if (fix && fix.decision === 'halt') {
          _applyRepairHalt(rec, step, report, fix);
          report.steps.push(rec); emit(rec); return report;
        }
        rec.action = 'skipped';
        rec.reason = 'SHELL 未预批准/未确认';
        report.summary.skipped += 1;
        report.steps.push(rec); emit(rec); continue;
      }
    }

    // ⑥ Precondition guard.
    const pre = _preconditionCheck(step);
    if (pre.decision === 'satisfied') {
      rec.action = 'skipped';
      rec.reason = pre.reason;
      report.summary.skipped += 1;
      report.steps.push(rec); emit(rec); continue;
    }
    if (pre.decision === 'halt') {
      const fix = await _maybeRepair(step, opts, 'precondition');
      if (fix && fix.decision === 'repaired') {
        _applyRepaired(rec, step, report);
        report.steps.push(rec); emit(rec); continue;
      }
      rec.action = 'halted';
      rec.reason = (fix && fix.reason) || pre.reason;
      rec.verify = { ok: false, ...((fix && fix.detail) || pre.detail) };
      report.summary.halted += 1;
      report.steps.push(rec); emit(rec);
      report.status = 'diverged';
      report.divergedAt = step.seq;
      return report;
    }

    // Execute through the single funnel.
    step._sessionId = sessionId;
    const params = _approveParams(step.params);
    try {
      await _executeWithTimeout(step, params, timeoutMs);
    } catch (e) {
      const fix = await _maybeRepair(step, opts, 'exec');
      if (fix && fix.decision === 'repaired') {
        _applyRepaired(rec, step, report);
        report.steps.push(rec); emit(rec); continue;
      }
      rec.action = 'halted';
      rec.reason = (fix && fix.reason) || `执行失败：${e && e.message ? e.message : String(e)}`;
      if (fix && fix.detail) rec.verify = { ok: false, ...fix.detail };
      report.summary.halted += 1;
      report.steps.push(rec); emit(rec);
      report.status = 'diverged';
      report.divergedAt = step.seq;
      return report;
    }

    // ③ Post-verify; divergence halts.
    const v = _verifyArtifacts(step);
    rec.verify = v.ok ? { ok: true } : { ok: false, ...v.detail };
    if (!v.ok) {
      const fix = await _maybeRepair(step, opts, 'post-verify');
      if (fix && fix.decision === 'repaired') {
        _applyRepaired(rec, step, report);
        report.steps.push(rec); emit(rec); continue;
      }
      rec.action = 'halted';
      rec.reason = (fix && fix.reason) || '产物哈希分歧';
      if (fix && fix.detail) rec.verify = { ok: false, ...fix.detail };
      report.summary.halted += 1;
      report.steps.push(rec); emit(rec);
      report.status = 'diverged';
      report.divergedAt = step.seq;
      return report;
    }

    rec.action = 'replayed';
    report.summary.replayed += 1;
    if (Array.isArray(step.artifacts) && step.artifacts.some((a) => a && a.op !== 'delete')) {
      report.summary.restored += 1;
    }
    report.steps.push(rec); emit(rec);
  }

  return report;
}

module.exports = {
  DEFAULT_STEP_TIMEOUT_MS,
  replay,
  _shellAllowList,
  _shellPreApproved,
  _preconditionCheck,
  _verifyArtifacts,
  _maybeRepair,
};
