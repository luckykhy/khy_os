'use strict';

// rewindNotice.js — pure leaf (zero IO · deterministic · fail-soft · env-gated).
//
// Builds the post-rewind status line shown after a double-ESC "conversation+code"
// rewind (App.js performRewind). CC's rewind flow (MessageSelector) surfaces a
// file-history DIFF-STAT so the user can see exactly what a code restore touched
// ("N files, +X/−Y") before/while restoring. khy already STORES that stat —
// checkpointService.diffCheckpoint() returns { stats:{additions,deletions} } — but
// the rewind notice never surfaced it, leaving only a vague "已回溯对话与代码". This
// leaf formats the stat into the notice so a code rewind is no longer silent about
// which lines it rolled back.
//
// Gate: KHY_REWIND_DIFFSTAT (default ON; disabled by {0,false,off,no}). When off, or
// when no meaningful stat is available (tar-full / no-diff checkpoints report {0,0}),
// the leaf returns the exact legacy notice strings App.js showed before it existed,
// so the display is byte-identical to today's behavior.
//
// Chinese has no plural inflection, so the additive/deletion counts are inlined
// numerically (git-style "+X/-Y") — the same numeric form CC uses — with no
// singular/plural branch to collapse.

const _OFF = ['0', 'false', 'off', 'no'];

// The exact strings App.js rendered before this leaf existed — the byte-identical
// fallbacks for gate-off / no-stat / bad-input paths.
const NOTICE_CODE = '已回溯对话与代码，可编辑后重发';
const NOTICE_NO_CODE = '已回溯对话（代码检查点不可用），可编辑后重发';

/**
 * Gate for surfacing the checkpoint diff-stat in the rewind notice.
 * Default ON (unset → enabled). fail-soft: any shape coerces to a string.
 * @param {object} [env]
 * @returns {boolean}
 */
function rewindDiffStatEnabled(env) {
  const raw = env && env.KHY_REWIND_DIFFSTAT;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

// Non-finite / negative → 0; otherwise floor. Counts are never negative.
function _nonNegInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Build the post-rewind status line.
 * @param {{codeRestored?:boolean, stats?:{additions?:number,deletions?:number}}} [arg]
 * @param {object} [env]
 * @returns {string} always a non-empty notice; never throws.
 */
function buildRewindNotice(arg, env) {
  const a = arg || {};
  // No code was restored (no checkpoint / restore failed) → conversation-only notice.
  if (!a.codeRestored) return NOTICE_NO_CODE;
  // Code was restored. Surface the diff-stat only when enabled AND meaningful.
  if (!rewindDiffStatEnabled(env)) return NOTICE_CODE;
  const s = a.stats || {};
  const add = _nonNegInt(s.additions);
  const del = _nonNegInt(s.deletions);
  // tar-full / no-diff checkpoints report {0,0}: there is no honest line-level stat
  // to show, so fall back to the plain notice rather than a misleading "+0/-0".
  if (add === 0 && del === 0) return NOTICE_CODE;
  return `已回溯对话与代码（+${add}/-${del} 行），可编辑后重发`;
}

module.exports = { rewindDiffStatEnabled, buildRewindNotice, NOTICE_CODE, NOTICE_NO_CODE };
