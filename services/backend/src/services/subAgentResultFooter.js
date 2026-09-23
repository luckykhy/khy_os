'use strict';

/**
 * subAgentResultFooter.js — pure-leaf helpers for shaping a sub-agent's result
 * before it flows back to the main agent.
 *
 * Borrowed as an IDEA from xingyao-y-code d88bbf4 (v1.3.0, MIT; khy-os has no
 * LICENSE so method is capped at idea/reference — see B-S4.1):
 *   ① a sub-agent's tool errors degrade to a bounded TRAILING warning footer
 *     (max 5 items, per-item capped) instead of a one-vote-veto of the whole
 *     task; the caller still decides success, we only surface the caveat;
 *   ② long results are head-truncated while the trailing warning block is
 *     preserved, and a salvaged partial body (produced before an abort) is
 *     capped so it can be attached to timeout/failure text.
 *
 * Every function is pure, zero-IO, and never throws (fail-soft). The caller
 * gates on KHY_SUBAGENT_RESULT_FOOTER (default on); when off, the caller skips
 * all of these and the result is byte-identical to the legacy path.
 */

// Marker that opens the trailing warning block. Head-truncation anchors on it
// so a cap never eats the warning itself.
const SUBAGENT_WARNING_MARKER = '\n\n⚠️ 子代理执行期有工具报错';

const _DEFAULTS = {
  // at most how many tool-error items are expanded in the footer
  maxWarningItems: 5,
  // per-item detail cap (chars) before ellipsis
  itemMaxChars: 200,
  // default cap for a salvaged partial body
  partialMaxChars: 1500,
};

/**
 * Gate predicate. KHY_SUBAGENT_RESULT_FOOTER default-on; off/0/false/no → off.
 * Pure: reads only the supplied env object (no process env), so a caller passing
 * {} gets the default-on behaviour.
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || {};
  const raw = e.KHY_SUBAGENT_RESULT_FOOTER == null ? '' : e.KHY_SUBAGENT_RESULT_FOOTER;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * Normalise a tool-error source (array of {name,detail}, or a {name: detail}
 * map, or null/undefined) into a clean [{name, detail}] list. detail is always
 * a string ('' when missing). Never throws.
 * @param {Array<{name: string, detail?: string}>|object|null|undefined} toolErrors
 * @returns {Array<{name: string, detail: string}>}
 */
function normalizeItems(toolErrors) {
  if (!toolErrors) {
    return [];
  }
  if (Array.isArray(toolErrors)) {
    return toolErrors
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({
        name: String(e.name != null ? e.name : ''),
        detail: String(e.detail != null ? e.detail : ''),
      }));
  }
  if (typeof toolErrors === 'object') {
    return Object.entries(toolErrors).map(([name, detail]) => ({
      name: String(name),
      detail: String(detail != null ? detail : ''),
    }));
  }
  return [];
}

/**
 * Append a bounded trailing warning footer listing the sub-agent's tool errors
 * (and an optional turn/abort reason) to the result text. When there are no
 * tool errors and no turn reason, the text is returned byte-identical.
 *
 * This is point ①: tool errors are DOWNGRADED to an advisory footer, never a
 * one-vote-veto — the caller still owns the success/failure decision.
 *
 * @param {string} text - the sub-agent result body
 * @param {Array<{name: string, detail?: string}>|object|null} toolErrors
 * @param {string} [turnError] - round-level abort reason (no-progress/turn cap)
 * @returns {string}
 */
function withToolErrorFooter(text, toolErrors, turnError = '') {
  const base = text == null ? '' : String(text);
  const items = normalizeItems(toolErrors);
  const turn = turnError ? String(turnError).trim() : '';
  if (items.length === 0 && !turn) {
    return base; // byte-identical: nothing to surface
  }
  const total = items.length;
  const shown = items.slice(0, _DEFAULTS.maxWarningItems);
  const lines = [
    SUBAGENT_WARNING_MARKER +
      (total > 0 ? `（${total} 个，可能影响结论可靠性，供主 Agent 判断是否复核）：` : '：'),
  ];
  if (turn) {
    lines.push(`  - 回合级中止原因: ${turn}`);
  }
  for (const it of shown) {
    let detail = it.detail;
    if (detail.length > _DEFAULTS.itemMaxChars) {
      detail = detail.slice(0, _DEFAULTS.itemMaxChars) + '…';
    }
    lines.push(`  - ${it.name}: ${detail}`);
  }
  if (total > shown.length) {
    lines.push(`  ... 另有 ${total - shown.length} 个未展开`);
  }
  return base + lines.join('\n');
}

/**
 * Head-truncate an over-long result while PRESERVING a trailing warning block
 * that begins at SUBAGENT_WARNING_MARKER. The cap eats the body only; the
 * warning block survives so a capped result still tells the caller the
 * conclusion may be unreliable. When the tail block is too large to preserve
 * within budget, it degrades to a plain head-truncation.
 *
 * `trailer`'s `{omitted}` placeholder is replaced with the actual number of
 * omitted characters. The result is ≤ maxLen.
 *
 * This is point ②: one shared truncation rule (foreground result and status
 * view) so the two never drift.
 *
 * @param {string} text
 * @param {number} maxLen
 * @param {string} [trailer] - appended between head and preserved tail
 * @returns {string}
 */
function truncateHeadPreserveTail(text, maxLen, trailer = '… [省略 {omitted}]') {
  const s = text == null ? '' : String(text);
  const cap = Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : s.length;
  if (s.length <= cap) {
    return s;
  }
  const t = String(trailer == null ? '' : trailer);
  // Reserve room for the trailer, then for a preserved tail block.
  const bodyBudget = cap - t.length;
  let tail = '';
  const markerAt = s.lastIndexOf(SUBAGENT_WARNING_MARKER);
  if (markerAt !== -1 && bodyBudget >= 0) {
    const candidate = s.slice(markerAt);
    // Preserve the tail only if it is not the majority of the budget.
    if (candidate.length <= bodyBudget / 2) {
      tail = candidate;
    }
  }
  const keep = Math.max(0, cap - t.length - tail.length);
  const head = s.slice(0, keep);
  const omitted = s.length - head.length - tail.length;
  return head + t.replace('{omitted}', String(omitted)) + tail;
}

/**
 * Cap a salvaged partial body (text already produced before an abort) so it can
 * be attached to a timeout/failure message without blowing the parent context.
 * Empty/absent → ''. Over the limit → truncated with an ellipsis.
 *
 * This is point ②'s "on-site salvage": the partial body is kept so the caller
 * can judge whether work already landed, instead of losing it wholesale.
 *
 * @param {string} partialText
 * @param {number} [limit]
 * @returns {string}
 */
function salvagePartial(partialText, limit = _DEFAULTS.partialMaxChars) {
  const s = partialText == null ? '' : String(partialText);
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : _DEFAULTS.partialMaxChars;
  if (s.length <= cap) {
    return s;
  }
  return s.slice(0, cap) + '...';
}

/**
 * Extract tool-error entries from an AgentTool toolLog array into the shape
 * withToolErrorFooter expects. Only status==='error' entries are kept; detail
 * falls back to '' when the entry carries no explicit error text.
 * @param {Array<{tool: string, status: string, error?: string}>|null|undefined} toolLog
 * @returns {Array<{name: string, detail: string}>}
 */
function toolErrorsFromLog(toolLog) {
  if (!Array.isArray(toolLog)) {
    return [];
  }
  return toolLog
    .filter((e) => e && e.status === 'error')
    .map((e) => ({ name: String(e.tool != null ? e.tool : ''), detail: String(e.error != null ? e.error : '') }));
}

module.exports = {
  SUBAGENT_WARNING_MARKER,
  SUBAGENT_WARNING_MAX_ITEMS: _DEFAULTS.maxWarningItems,
  SUBAGENT_WARNING_ITEM_MAX_CHARS: _DEFAULTS.itemMaxChars,
  SUBAGENT_PARTIAL_MAX_CHARS: _DEFAULTS.partialMaxChars,
  isEnabled,
  withToolErrorFooter,
  truncateHeadPreserveTail,
  salvagePartial,
  toolErrorsFromLog,
};
