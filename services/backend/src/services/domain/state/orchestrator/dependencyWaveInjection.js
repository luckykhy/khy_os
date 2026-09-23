'use strict';

// @leaf
// Predecessor-result INJECTION into downstream waves (farewell gift, 第三发).
//
// WHY: waves now run in order (planWaves) and fail honestly (partitionWaveBy-
// Survivors). But a downstream subtask's forked sub-agent still runs BLIND — it
// never sees what its predecessor wave produced. `implement` cannot see what
// `explore` found. That is time-ordering without INFORMATION-ordering. The dead
// code `subAgentOrchestrator.executeDependencyAware` (zero callers) already
// specifies the missing semantics: prepend each direct predecessor's result text
// to the dependent's prompt, truncated at 4000 chars on a newline boundary. This
// leaf mirrors that spec WITHOUT waking the dead code (touching the orchestrator /
// god-file would violate 外科手术式改动 B3).
//
// All functions below are PURE (zero IO, never throw, deterministic). This leaf is
// the shared home of `_asText` (a generic coercion both the scheduler and the
// injection helpers need) so the host requires it FROM here — a one-directional
// host→leaf edge, no back-edge into the scheduler.

/** Safe string coercion (null/undefined → ''), never throws. */
function _asText(v) {
  if (v == null) {
    return '';
  }
  try {
    return String(v);
  } catch {
    return '';
  }
}

// Mirror subAgentOrchestrator's MAX_DEP truncation budget byte-for-byte.
const _MAX_DEP_TEXT = 4000;

/**
 * Extract the human-readable result text from a per-subtask result object.
 * Mirrors taskDecomposer's `result.text || result.output` read, but WITHOUT its
 * `'(无输出)'` placeholder: an empty/absent text must yield '' so the caller can
 * skip it rather than inject a meaningless "(no output)" line into a downstream
 * prompt. Pure, never throws.
 */
function _extractResultText(resultObj) {
  if (!resultObj || typeof resultObj !== 'object') {
    return '';
  }
  const t = resultObj.text;
  if (typeof t === 'string' && t.length > 0) {
    return t;
  }
  const o = resultObj.output;
  if (typeof o === 'string' && o.length > 0) {
    return o;
  }
  return '';
}

/**
 * Truncate predecessor text to _MAX_DEP_TEXT chars, cutting on the last newline
 * before the limit when there is one. Byte-identical to the dead code's rule:
 * the cut is used only when `cut > 0` (a leading-region newline at index 0 is
 * NOT used), and the reported dropped-char count is `length - _MAX_DEP_TEXT`
 * (the raw overflow, NOT `length - cut`). Pure, never throws.
 */
function _truncateDepText(depText) {
  if (typeof depText !== 'string') {
    return depText == null ? '' : _asText(depText);
  }
  if (depText.length <= _MAX_DEP_TEXT) {
    return depText;
  }
  const cut = depText.lastIndexOf('\n', _MAX_DEP_TEXT);
  const head = depText.slice(0, cut > 0 ? cut : _MAX_DEP_TEXT);
  return `${head}\n... [truncated ${depText.length - _MAX_DEP_TEXT} chars]`;
}

/**
 * Build the predecessor-context block for the wave member at global index
 * `globalIdx`. For each DIRECT resolved dependency `d` (from `edges[globalIdx]`,
 * ascending), look up its prior result in `priorResultsByGlobalIdx`, extract +
 * truncate its text, and emit a `[前驱结果 t<d+1>]: <text>` line. Non-empty
 * lines are joined with '\n'. Returns '' when there are no dependencies, no
 * prior text, or the input is malformed. Only DIRECT deps are injected (a direct
 * parent's output already transitively carries what the grandparent produced,
 * matching the dead code and keeping the 4000-char budget from bloating).
 * Pure, never throws.
 *
 * @param {object} subtask                       the dependent subtask (unused today; kept for parity/extension)
 * @param {Set<number>[]} edges                  per-global-index resolved dep sets (planWaves.edges)
 * @param {number} globalIdx                     this member's global index
 * @param {Map<number,object>} priorResultsByGlobalIdx  globalIdx → inner result object
 * @returns {string}
 */
function buildPredecessorContext(subtask, edges, globalIdx, priorResultsByGlobalIdx) {
  try {
    if (!Array.isArray(edges)) {
      return '';
    }
    const need = edges[globalIdx];
    if (!need || typeof need.forEach !== 'function' || need.size === 0) {
      return '';
    }
    const map = priorResultsByGlobalIdx instanceof Map ? priorResultsByGlobalIdx : new Map();
    const deps = Array.from(need)
      .filter(Number.isInteger)
      .sort((a, b) => a - b);
    const lines = [];
    for (const d of deps) {
      const text = _truncateDepText(_extractResultText(map.get(d)));
      if (text) {
        lines.push(`[前驱结果 t${d + 1}]: ${text}`);
      }
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * Prepend a predecessor-context block to a subtask's prompt, separated by a
 * horizontal rule so the sub-agent can tell the injected context from its own
 * task. Empty/non-string block → prompt unchanged (byte-identical to no
 * injection). Pure, never throws.
 */
function injectPredecessorContext(promptText, contextBlock) {
  const p = typeof promptText === 'string' ? promptText : '';
  if (typeof contextBlock !== 'string' || contextBlock.length === 0) {
    return p;
  }
  return `${contextBlock}\n\n${p}`;
}

module.exports = {
  _asText,
  _extractResultText,
  _truncateDepText,
  buildPredecessorContext,
  injectPredecessorContext,
};
