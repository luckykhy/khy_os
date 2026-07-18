'use strict';

/**
 * auditFixLoop — completion-time "audit → fix → re-audit" closed loop.
 *
 * Product directive: at the completion of a real engineering task (files
 * modified / an execution plan / Goal mode), automatically run the read-only
 * AUDIT agent to find problems, then dispatch the editing FIX agent to close the
 * CRITICAL/HIGH ones, then RE-AUDIT to confirm — fully automatic, bounded, and
 * with any remaining issues surfaced transparently to the user.
 *
 * This index is pure orchestration over injected primitives (dependency
 * injection): it does not know how to spawn an agent, what the cwd is, or how
 * the loop tracks state. The caller (toolUseLoop) injects `dispatchAgent`. That
 * keeps this module unit-testable with a stub dispatcher and free of the heavy
 * AgentTool / chat machinery.
 *
 *   runAuditFixCycle({ dispatchAgent, taskDescription, files, maxRounds })
 *     dispatchAgent({ role, prompt, round }) => { text, filesModified, success }
 *
 * Fail-soft: a dispatch error never throws into the loop — it ends the cycle with
 * an 'error' outcome so the turn still concludes (the audit loop must never be
 * the reason a delivery fails).
 */

const { parseAuditReport, parseFixReport, hasActionableFindings, actionableFindings, summarizeCounts } =
  require('./auditParser');
const { buildAuditPrompt, buildFixPrompt } = require('./promptBuilder');
const triggerGate = require('./triggerGate');

/**
 * Run the bounded audit→fix→re-audit cycle.
 *
 * @param {object} opts
 * @param {(args:{role:string,prompt:string,round:number})=>Promise<{text:string,filesModified?:string[],success?:boolean}>}
 *        opts.dispatchAgent - injected sub-agent dispatcher
 * @param {string}   opts.taskDescription
 * @param {string[]} opts.files
 * @param {number}   [opts.maxRounds] - defaults to triggerGate.maxRounds()
 * @param {(evt:object)=>void} [opts.onEvent] - optional progress callback (best-effort)
 * @returns {Promise<{
 *   outcome: 'clean'|'fixed'|'exhausted'|'error',
 *   rounds: Array, finalReport: object|null, filesFixed: string[],
 *   totalActionableRemaining: number, error?: string,
 * }>}
 */
async function runAuditFixCycle(opts = {}) {
  const {
    dispatchAgent,
    taskDescription = '',
    files = [],
    maxRounds = triggerGate.maxRounds(),
    onEvent = null,
  } = opts;

  if (typeof dispatchAgent !== 'function') {
    return { outcome: 'error', rounds: [], finalReport: null, filesFixed: [], totalActionableRemaining: 0, error: 'no dispatchAgent injected' };
  }

  const _emit = (evt) => { if (onEvent) { try { onEvent(evt); } catch { /* best-effort */ } } };

  const rounds = [];
  const filesFixed = new Set();
  let lastReport = null;
  let priorFix = null;

  try {
    for (let round = 1; round <= maxRounds; round++) {
      // ── 1) AUDIT (read-only critic) ──────────────────────────────────
      _emit({ type: 'audit_start', round });
      const auditOut = await dispatchAgent({
        role: 'audit',
        round,
        prompt: buildAuditPrompt({ taskDescription, files, round, priorFix }),
      });
      const report = parseAuditReport(auditOut && auditOut.text);
      lastReport = report;
      _emit({ type: 'audit_done', round, total: report.total, counts: report.counts });

      if (!hasActionableFindings(report)) {
        // Nothing CRITICAL/HIGH left to fix → cycle converged.
        rounds.push({ round, report, fixed: false });
        return {
          outcome: round === 1 ? 'clean' : 'fixed',
          rounds,
          finalReport: report,
          filesFixed: [...filesFixed],
          totalActionableRemaining: 0,
        };
      }

      // At the ceiling we can audit but not fix again — stop with findings open.
      if (round >= maxRounds) {
        rounds.push({ round, report, fixed: false });
        return {
          outcome: 'exhausted',
          rounds,
          finalReport: report,
          filesFixed: [...filesFixed],
          totalActionableRemaining: report.counts.critical + report.counts.high,
        };
      }

      // ── 2) FIX (editing repair, CRITICAL/HIGH only) ──────────────────
      const actionable = actionableFindings(report);
      _emit({ type: 'fix_start', round, actionable: actionable.length });
      const fixOut = await dispatchAgent({
        role: 'fix',
        round,
        prompt: buildFixPrompt({ taskDescription, files, report, actionable }),
      });
      const fixReport = parseFixReport(fixOut && fixOut.text);
      priorFix = fixReport;
      for (const f of (fixOut && fixOut.filesModified) || []) filesFixed.add(f);
      rounds.push({ round, report, fixed: true, fixReport, filesModified: (fixOut && fixOut.filesModified) || [] });
      _emit({ type: 'fix_done', round, fixed: fixReport.fixed, deferred: fixReport.deferred });
      // loop → re-audit on the next iteration
    }

    // Loop fell through (maxRounds reached after a fix without a confirming audit).
    return {
      outcome: 'exhausted',
      rounds,
      finalReport: lastReport,
      filesFixed: [...filesFixed],
      totalActionableRemaining: lastReport ? (lastReport.counts.critical + lastReport.counts.high) : 0,
    };
  } catch (err) {
    return {
      outcome: 'error',
      rounds,
      finalReport: lastReport,
      filesFixed: [...filesFixed],
      totalActionableRemaining: lastReport ? (lastReport.counts.critical + lastReport.counts.high) : 0,
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Build the transparent completion annotation appended to the final delivery.
 * Returns '' when there is nothing worth telling the user (a from-scratch clean
 * audit adds no noise). Chinese prose is intentional — this surface is Khy-OS,
 * where the project convention is Chinese.
 *
 * @param {object} result - output of runAuditFixCycle
 * @returns {string}
 */
function buildAnnotation(result) {
  if (!result) return '';
  const { outcome, finalReport, rounds } = result;

  if (outcome === 'clean') {
    // Audited and found nothing actionable on the first pass: stay silent to
    // avoid adding noise to every successful task.
    return '';
  }

  if (outcome === 'error') {
    return '';
  }

  const fixedTotal = rounds
    .filter(r => r.fixed && r.fixReport)
    .reduce((n, r) => n + (r.fixReport.fixed || 0), 0);

  if (outcome === 'fixed') {
    return `\n\n---\n🔍 **完成时审计** — 审计智能体发现问题，已自动派发修复智能体处理并通过重审`
      + (fixedTotal > 0 ? `（修复 ${fixedTotal} 项严重/高优先级问题）` : '')
      + '。';
  }

  if (outcome === 'exhausted') {
    const counts = finalReport ? finalReport.counts : null;
    const remaining = counts ? (counts.critical + counts.high) : 0;
    const lines = [];
    lines.push(`\n\n---\n🔍 **完成时审计** — 经过自动审计与修复后，仍有 ${remaining} 个严重/高优先级问题需人工关注：`);
    const leftover = finalReport ? actionableFindings(finalReport) : [];
    leftover.slice(0, 8).forEach((f) => {
      const loc = f.location ? ` (${f.location})` : '';
      lines.push(`  - [${f.severity.toUpperCase()}] ${f.title || '(未命名)'}${loc}`);
    });
    if (leftover.length > 8) lines.push(`  …以及另外 ${leftover.length - 8} 项`);
    if (fixedTotal > 0) lines.push(`（本轮已自动修复 ${fixedTotal} 项，以上为剩余项）`);
    return lines.join('\n');
  }

  return '';
}

module.exports = {
  runAuditFixCycle,
  buildAnnotation,
  // re-exports for callers/tests that want the primitives in one place
  shouldAudit: triggerGate.shouldAudit,
  triggerGate,
  summarizeCounts,
};
