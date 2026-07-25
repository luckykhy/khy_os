/**
 * Intent-assurance debug snapshot builder for the classic REPL.
 *
 * Extracted verbatim from cli/repl.js as part of the behavior-preserving
 * god-file split. Pure (no closure state, no chalk, no I/O): turns a raw
 * intent-assurance payload into a normalized snapshot descriptor that the REPL
 * renders. The rendering sibling (`_printIntentAssuranceDebugSnapshot`) stays in
 * repl.js because it is I/O- and chalk-bound; this module is the data layer.
 */

/**
 * Collapse whitespace, trim, and clamp a debug string to `maxLen` chars,
 * appending an ellipsis (keeping at least 16 leading chars). Returns '' for
 * empty/whitespace input.
 */
function trimIntentDebugItem(text = '', maxLen = 100) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(16, maxLen - 1))}…`;
}

/**
 * Normalize a list of debug items: trim each to 100 chars, drop empties, and
 * cap to `limit` entries. Returns [] for non-array input.
 */
function normalizeIntentDebugList(items = [], limit = 6) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => trimIntentDebugItem(item, 100))
    .filter(Boolean)
    .slice(0, limit);
}

/**
 * Build a normalized intent-assurance snapshot from a raw payload, or null when
 * the payload is not an object. Clamps every string, normalizes the three list
 * fields, and derives the counts (max of the materialized list length and any
 * explicit count carried on the payload).
 */
function buildIntentAssuranceDebugSnapshot(payload = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const primaryObjective = trimIntentDebugItem(
    payload.primaryObjective || payload.summary || payload.message || '',
    180,
  );
  const constraints = normalizeIntentDebugList(payload.constraints, 5);
  const detailAnchors = normalizeIntentDebugList(payload.detailAnchors, 8);
  const tailDetails = normalizeIntentDebugList(payload.tailDetails, 4);
  const requestClass = trimIntentDebugItem(payload.requestClass || '', 48);
  return {
    source: String(payload.source || 'runtime').trim() || 'runtime',
    shouldInject: payload.shouldInject !== false,
    requestClass,
    primaryObjective,
    summary: trimIntentDebugItem(payload.summary || primaryObjective, 180),
    constraints,
    detailAnchors,
    tailDetails,
    constraintCount: Math.max(constraints.length, Number(payload.constraintCount || 0) || 0),
    detailCount: Math.max(detailAnchors.length, Number(payload.detailCount || 0) || 0),
    tailDetailCount: Math.max(tailDetails.length, Number(payload.tailDetailCount || 0) || 0),
  };
}

module.exports = {
  trimIntentDebugItem,
  normalizeIntentDebugList,
  buildIntentAssuranceDebugSnapshot,
};
