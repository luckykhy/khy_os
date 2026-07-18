'use strict';

// Context / auto-compact warning state machine — pure leaf (zero IO, zero
// business require). Aligns the LOGIC BEHIND Claude Code's "% until
// auto-compact" / "Context low" footer line, NOT just its appearance.
//
// CC reference: src/services/compact/autoCompact.ts::calculateTokenWarningState
// + src/components/TokenWarning.tsx. CC's three deterministic decisions:
//   1. WHEN to show — only inside the final warning band (tokenUsage within
//      WARNING_BUFFER of the threshold), never from the first token.
//   2. WHAT 100% means — the denominator is the auto-compact threshold (the
//      point where compaction actually fires), not the raw context window.
//   3. The STATE — dim "% until auto-compact" while auto-compact is on, else
//      colored "Context low (…% remaining) · Run /compact …", error vs
//      warning by isAboveErrorThreshold.
//
// Honest divergence from CC: CC's threshold is `effectiveWindow - buffer`.
// khy's auto-compact actually fires at `budget * AUTOCOMPACT_THRESHOLD`
// (0.8, see services/query/compactPipeline.js — its real SSOT). To keep the
// countdown honest (0% == the moment khy actually compacts) we adopt CC's
// state-machine STRUCTURE but parameterize the threshold by khy's real
// ratio, injected by the shell from compactPipeline.AUTOCOMPACT_THRESHOLD.
//
// Pre-existing bugs this fixes at the two repl.js render sites:
//   - wrong signal: they used cumulative `sessionTokens.total` (grows
//     unbounded across the whole session) instead of current context
//     occupancy `contextWindow.used`.
//   - wrong denominator: divided by the raw limit (200k) not the threshold.
//   - no warning band: shown on any token usage, against CC's "don't nag
//     early" intent.

// CC MAX_OUTPUT_TOKENS_FOR_SUMMARY — tokens reserved for the compaction
// summary output, subtracted from the raw window to get the usable window.
const RESERVED_OUTPUT_TOKENS = 20000;
// CC WARNING_THRESHOLD_BUFFER_TOKENS / ERROR_THRESHOLD_BUFFER_TOKENS. Kept as
// two constants (as in CC) even though equal, so they can diverge later.
const WARNING_BUFFER_TOKENS = 20000;
const ERROR_BUFFER_TOKENS = 20000;
// Fallback ratio mirroring compactPipeline.AUTOCOMPACT_THRESHOLD. The shell
// injects the real exported constant; this default only guards a bad inject.
const DEFAULT_AUTOCOMPACT_RATIO = 0.8;

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env) {
  const raw = env && env.KHY_CONTEXT_WARNING;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// NaN / non-finite / negative → 0 (defensive; counters are never negative).
// 有限数强转家族单一真源 utils/finiteNumber(见 finiteNumber.js)。
const _num = require('../utils/finiteNumber').toNonNegOr0;

// A ratio must be in (0,1]; bad inject falls back to the default.
function _ratio(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return DEFAULT_AUTOCOMPACT_RATIO;
  return n;
}

// Post-compaction staleness gate — the LOGIC behind CC's compactWarningState.
// CC (src/services/compact/compactWarningState.ts) sets a bare boolean AFTER a
// successful compaction and clears it only at the start of the NEXT compact
// attempt, "since we don't have accurate token counts until the next API
// response." khy strengthens that into a SELF-CLEARING gate keyed on the actual
// stale value: right after compaction the reported context usage still holds
// its pre-compaction (high) value until the next response refreshes it downward
// — so while `tokenUsage >= lastCompactionUsed` the count has not dropped yet
// and any "% until auto-compact" / "Context low" line would be misleading.
// The instant a fresh, lower count lands (the shell also zeroes
// lastCompactionUsed one-shot in setContextUsage), this returns false and the
// normal warning logic resumes. lastCompactionUsed<=0 → no suppression, so old
// callers that never pass it are byte-identical to today.
function isCompactionStale(tokenUsage, lastCompactionUsed) {
  const used = _num(tokenUsage);
  const last = _num(lastCompactionUsed);
  return last > 0 && used >= last;
}

// CC getEffectiveContextWindowSize: raw window minus reserved summary output.
function effectiveContextWindow(contextWindow, reservedOutputTokens) {
  const window = _num(contextWindow);
  const reserve = Math.min(_num(reservedOutputTokens) || RESERVED_OUTPUT_TOKENS, RESERVED_OUTPUT_TOKENS);
  return Math.max(0, window - reserve);
}

// Mirrors CC calculateTokenWarningState, with khy's real auto-compact
// threshold (ratio * window) in place of CC's effectiveWindow - buffer.
function calculateTokenWarningState(opts) {
  const o = opts || {};
  const tokenUsage = _num(o.tokenUsage);
  const contextWindow = _num(o.contextWindow);
  const autoCompactEnabled = o.autoCompactEnabled !== false; // default on (khy compacts)
  const ratio = _ratio(o.autoCompactRatio);

  const effectiveWindow = effectiveContextWindow(contextWindow, o.reservedOutputTokens);
  // khy fires auto-compact at ratio * window (compactPipeline). Use the same
  // signal here so 0% lines up with the real compaction event.
  const autoCompactThreshold = Math.round(ratio * contextWindow);

  const threshold = autoCompactEnabled ? autoCompactThreshold : effectiveWindow;

  let percentLeft = 0;
  if (threshold > 0) {
    percentLeft = Math.max(0, Math.round(((threshold - tokenUsage) / threshold) * 100));
  }

  // 门控 KHY_CONTEXT_WARNING_THRESHOLD_GUARD(默认开):小窗口时 `threshold - buffer` 下溢为负 →
  // 从 token 0 起就误判入告警带(显示「100% until auto-compact」)。守卫改为窗口装不下 buffer 时
  // 只在抵达真实 threshold 才告警。生产大窗口逐字节等价;门关/异常 → 回退 legacy `threshold - buffer`。
  let warningThreshold = threshold - WARNING_BUFFER_TOKENS;
  let errorThreshold = threshold - ERROR_BUFFER_TOKENS;
  try {
    const _g = require('../services/contextWarningThreshold');
    const _wt = _g.guardBandThreshold(threshold, WARNING_BUFFER_TOKENS, process.env);
    const _et = _g.guardBandThreshold(threshold, ERROR_BUFFER_TOKENS, process.env);
    if (_wt !== null) warningThreshold = _wt;
    if (_et !== null) errorThreshold = _et;
  } catch { /* fail-soft → legacy threshold - buffer */ }

  const isAboveWarningThreshold = threshold > 0 && tokenUsage >= warningThreshold;
  const isAboveErrorThreshold = threshold > 0 && tokenUsage >= errorThreshold;
  const isAboveAutoCompactThreshold = autoCompactEnabled && threshold > 0 && tokenUsage >= autoCompactThreshold;

  return {
    percentLeft,
    threshold,
    effectiveWindow,
    autoCompactThreshold,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
  };
}

// Full display decision. Returns { show, text, style } where style is one of
// 'dim' | 'warning' | 'error'. When show=false there is nothing to render
// (we are not yet inside the warning band).
function buildContextWarning(opts) {
  const o = opts || {};
  const autoCompactEnabled = o.autoCompactEnabled !== false;
  const state = calculateTokenWarningState(o);

  // CC compactWarningState alignment: suppress the warning while the reported
  // usage is still stale-high from a just-finished compaction (see
  // isCompactionStale). Placed before the warning-band check because the stale
  // value is precisely one that WOULD be in-band (compaction only fires above
  // it). Self-clears when a fresh lower count arrives.
  if (isCompactionStale(o.tokenUsage, o.lastCompactionUsed)) {
    return { show: false, text: '', style: 'dim', state, suppressed: true };
  }

  if (!state.isAboveWarningThreshold) {
    return { show: false, text: '', style: 'dim', state };
  }

  if (autoCompactEnabled) {
    return { show: true, text: `${state.percentLeft}% until auto-compact`, style: 'dim', state };
  }

  // Auto-compact disabled: escalate to an actionable "Context low" prompt.
  return {
    show: true,
    text: `Context low (${state.percentLeft}% remaining) · Run /compact to compact & continue`,
    style: state.isAboveErrorThreshold ? 'error' : 'warning',
    state,
  };
}

module.exports = {
  isEnabled,
  effectiveContextWindow,
  calculateTokenWarningState,
  isCompactionStale,
  buildContextWarning,
  // Constants exported for tests / cross-reference.
  RESERVED_OUTPUT_TOKENS,
  WARNING_BUFFER_TOKENS,
  ERROR_BUFFER_TOKENS,
  DEFAULT_AUTOCOMPACT_RATIO,
};
