'use strict';

/**
 * OPS-MAN-101 — Role-attribution honesty for the collected sub-agent report.
 *
 * WHY (the broken bridge):
 *   `decompose` (taskDecomposer) types every subtask with a `role`
 *   (implement / verify / explore / general) via `_inferRole`. That role is
 *   already consumed by model-selection (subAgentModelSelect) and by the
 *   OPS-MAN-094 tool-scoping leaf (roleToolScope). But the SINGLE user-facing
 *   collected report — `mergeResults` — folds the role away entirely: a
 *   subtask header reads `### 子任务 3: <preview>` and a failure renders
 *   `失败: <err>` with NO signal about WHICH KIND of work failed.
 *
 *   On an offline / unattended rerun this is a genuine honesty gap: a failed
 *   `verify` subtask means the work is UNVALIDATED (serious — must recheck),
 *   whereas a failed `explore` subtask is recoverable (implement + verify may
 *   still have passed). Folding both into an anonymous 「失败」 hides the
 *   severity. This is a DISTINCT folded dimension from the already-surfaced
 *   axes on the same consumer: state (OPS-092 skip≠fail), write-conflict
 *   (OPS-098), and empty-success (OPS-099). Here the folded dimension is the
 *   TYPE of each subtask's work.
 *
 * WHAT (the fix — additive, gated, byte-revertible):
 *   A pure leaf that (a) renders a small role tag for a subtask header, and
 *   (b) summarises the role distribution of FAILED subtasks in the footer,
 *   flagging a failed `verify` as critical. Gate KHY_MERGE_ROLE_ATTRIBUTION
 *   off (∈ {0,false,off,no}) → formatRoleTag returns '' and
 *   formatRoleFailureSummary returns '' → mergeResults renders byte-for-byte
 *   what it renders today.
 *
 * HONESTY BOUNDARIES:
 *   - The footer count must SUM to the caller's failCount: every failed role
 *     maps to SOME bucket (unknown/general → 通用), never dropped.
 *   - The decorative header tag is suppressed ('') for unknown/malformed roles
 *     rather than mislabelled — a tag is cosmetic, a dropped failure is a lie.
 *   - Never throws on malformed input; only annotates, never re-classifies
 *     success/failure (successCount/failCount are owned by mergeResults).
 *
 * HOW-TO-EXTEND: add a new role → add one entry to _ROLE_LABELS below. The
 * summary bucket falls back to 通用 for anything unmapped, so a missing entry
 * degrades to a safe count, never a crash or a dropped failure.
 */

// Independent per-leaf gate (sibling gates KHY_MERGE_* / KHY_DEP_WAVE_* each
// read env directly and are intentionally NOT registered in flagRegistry).
const _FALSY = new Set(['0', 'false', 'off', 'no']);

function _roleAttributionEnabled() {
  const raw = process.env.KHY_MERGE_ROLE_ATTRIBUTION;
  if (raw === undefined || raw === null) return true; // default-on
  return !_FALSY.has(String(raw).trim().toLowerCase());
}

// Known role vocabulary emitted by taskDecomposer._inferRole.
const _ROLE_LABELS = {
  implement: '实现',
  verify: '验证',
  explore: '探索',
  general: '通用',
};

const _DEFAULT_BUCKET = '通用';

/**
 * Human label for a role, or '' when the role is unknown/malformed.
 * Used for the (suppressible) decorative header tag.
 */
function roleLabel(role) {
  if (typeof role !== 'string') return '';
  const key = role.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(_ROLE_LABELS, key)
    ? _ROLE_LABELS[key]
    : '';
}

/**
 * Bucket label for the failure summary — never '' so a failure is never
 * dropped from the count. Unknown/general/malformed → 通用.
 */
function _summaryBucket(role) {
  return roleLabel(role) || _DEFAULT_BUCKET;
}

/**
 * Render a subtask-header role tag, e.g. '（验证）'. Gate off, non-string,
 * or unknown role → '' (byte-revert: header stays `### 子任务 N: preview`).
 */
function formatRoleTag(role) {
  if (!_roleAttributionEnabled()) return '';
  const label = roleLabel(role);
  return label ? `（${label}）` : '';
}

/**
 * Summarise the role distribution of FAILED subtasks.
 * @param {Array<string>} failedRoles roles of subtasks that FAILED (not skipped,
 *   not empty-success). Order irrelevant; counted by bucket.
 * @returns {string} a footer line WITHOUT leading '- ', or '' when gate off /
 *   empty / malformed. When a `verify` subtask is among the failures, appends a
 *   critical hint (results unvalidated).
 */
function formatRoleFailureSummary(failedRoles) {
  if (!_roleAttributionEnabled()) return '';
  if (!Array.isArray(failedRoles) || failedRoles.length === 0) return '';

  const counts = new Map(); // bucket label → count
  let verifyFailed = false;
  for (const role of failedRoles) {
    const bucket = _summaryBucket(role);
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
    if (typeof role === 'string' && role.trim().toLowerCase() === 'verify') {
      verifyFailed = true;
    }
  }
  if (counts.size === 0) return '';

  // Stable order: follow the known-role declaration order, then any extras.
  const knownOrder = Object.values(_ROLE_LABELS);
  const seen = new Set();
  const parts = [];
  for (const label of knownOrder) {
    if (counts.has(label)) {
      parts.push(`${label} ${counts.get(label)} 项`);
      seen.add(label);
    }
  }
  for (const [label, n] of counts) {
    if (!seen.has(label)) parts.push(`${label} ${n} 项`);
  }

  const hint = verifyFailed ? '（验证失败=结果未经校验，请复查）' : '';
  return `⚠️ 失败分布: ${parts.join('、')}${hint}`;
}

module.exports = {
  roleLabel,
  formatRoleTag,
  formatRoleFailureSummary,
  _roleAttributionEnabled,
};
