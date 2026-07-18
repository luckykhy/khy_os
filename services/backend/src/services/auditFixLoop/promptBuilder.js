'use strict';

/**
 * promptBuilder.js — pure builders for the audit and fix sub-agent prompts.
 *
 * Each spawned agent runs in its OWN isolated context, so the prompt must be a
 * complete, self-contained brief: what the original task was, which files are in
 * the blast radius, and (for the fixer) exactly which findings to close. No I/O,
 * no deps — pure string assembly, trivially testable.
 */

const MAX_TASK_CHARS = 2000;
const MAX_FILES_LISTED = 40;

function _clip(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function _fileList(files) {
  const arr = Array.isArray(files) ? files.filter(Boolean) : [];
  if (arr.length === 0) return '(no specific files recorded — inspect the working tree, e.g. `git diff`)';
  const shown = arr.slice(0, MAX_FILES_LISTED).map(f => `  - ${f}`);
  if (arr.length > MAX_FILES_LISTED) shown.push(`  …and ${arr.length - MAX_FILES_LISTED} more`);
  return shown.join('\n');
}

/**
 * Build the brief handed to the audit (read-only critic) sub-agent.
 *
 * @param {object} opts
 * @param {string} opts.taskDescription - the original user task / contract
 * @param {string[]} opts.files - files modified this turn (the blast radius)
 * @param {number} [opts.round] - current audit round (1-based), for the re-audit pass
 * @param {object} [opts.priorFix] - parsed fix report from the previous round, if any
 * @returns {string}
 */
function buildAuditPrompt(opts = {}) {
  const { taskDescription, files, round = 1, priorFix = null } = opts;
  const lines = [];

  if (round > 1 && priorFix) {
    lines.push(
      `This is RE-AUDIT round ${round}. A fix agent just attempted to close the previous findings `
      + `(reported ${priorFix.fixed} fixed, ${priorFix.deferred} deferred, ${priorFix.notDefect} not-a-defect). `
      + `Re-inspect the files from scratch — do not assume the fixes are correct or complete. `
      + `Verify the previously-reported CRITICAL/HIGH defects are genuinely gone, and check the fixer did not introduce new ones.`,
    );
    lines.push('');
  }

  lines.push('Audit the following completed work for defects, ranked by severity.');
  lines.push('');
  lines.push('=== ORIGINAL TASK (the contract to check against) ===');
  lines.push(_clip(taskDescription, MAX_TASK_CHARS) || '(no task description provided)');
  lines.push('');
  lines.push('=== FILES MODIFIED THIS TURN (the blast radius) ===');
  lines.push(_fileList(files));
  lines.push('');
  lines.push(
    'Read the ACTUAL code at these paths and trace it against the task. Report problems only, '
    + 'ranked highest-severity first, each with file:line evidence. End with the required '
    + '`AUDIT: <n> findings (...)` summary line. If genuinely clean after a real trace, end with `AUDIT: 0 findings`.',
  );
  return lines.join('\n');
}

/**
 * Build the brief handed to the fix (editing) sub-agent.
 *
 * @param {object} opts
 * @param {string} opts.taskDescription - the original user task / contract
 * @param {string[]} opts.files - files in the blast radius
 * @param {object} opts.report - parsed audit report (from auditParser.parseAuditReport)
 * @param {Array} opts.actionable - the CRITICAL/HIGH findings to close (auditParser.actionableFindings)
 * @returns {string}
 */
function buildFixPrompt(opts = {}) {
  const { taskDescription, files, actionable = [] } = opts;
  const lines = [];

  lines.push('An audit found defects in the work below. Fix EXACTLY the CRITICAL/HIGH findings listed — root cause, minimal diff, verified — then stop.');
  lines.push('');
  lines.push('=== ORIGINAL TASK (the contract) ===');
  lines.push(_clip(taskDescription, MAX_TASK_CHARS) || '(no task description provided)');
  lines.push('');
  lines.push('=== FILES IN SCOPE ===');
  lines.push(_fileList(files));
  lines.push('');
  lines.push(`=== ACTIONABLE FINDINGS TO CLOSE (${actionable.length}) ===`);
  if (actionable.length === 0) {
    lines.push('(none — nothing to do)');
  } else {
    actionable.forEach((f, i) => {
      const _tag = f.code || (f.severity ? f.severity.toUpperCase() : '?');
      lines.push(`${i + 1}. [${_tag}] ${f.title || '(untitled)'}`);
      if (f.location) lines.push(`   Location: ${f.location}`);
      if (f.problem) lines.push(`   Problem: ${_clip(f.problem, 400)}`);
      if (f.suggested) lines.push(`   Suggested direction: ${_clip(f.suggested, 400)}`);
    });
  }
  lines.push('');
  lines.push(
    'Fix every CRITICAL/HIGH finding above and nothing else (no scope creep, no unrelated refactors). '
    + 'Verify each fix. If one is a false positive or needs a design decision, mark it NOT-A-DEFECT / DEFERRED with evidence — do not fake a fix. '
    + 'End with the required `FIX: <f> fixed, <d> deferred, <n> not-a-defect (of <total> actionable findings)` summary line.',
  );
  return lines.join('\n');
}

module.exports = { buildAuditPrompt, buildFixPrompt };
