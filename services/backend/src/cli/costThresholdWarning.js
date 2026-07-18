'use strict';

// Session cost-threshold warning — pure leaf (zero IO, deterministic, fail-soft).
// Aligns the LOGIC BEHIND Claude Code's cost-threshold dialog, NOT just its look.
//
// CC reference: src/components/CostThresholdDialog.tsx — a one-time modal
// "You've spent $5 on the Anthropic API this session." shown when cumulative
// session API spend first crosses a threshold (CC hardcodes $5). CC's documented
// 背后逻辑: users on metered API billing can silently run up spend across a long
// session; CC surfaces a single, one-shot notice the first time the running total
// crosses the threshold so the user can decide to monitor usage (/cost). It fires
// ONCE per session — the caller remembers it already fired.
//
// khy parity: khy already tracks cumulative session spend via
// tokenUsageService.getSessionCost() → { costUSD, costCNY } (sums every recorded
// request through the provider pricing table). That substrate is live and consumed
// by /cost, but no per-turn threshold ALERT ever consumed it. This leaf reproduces
// CC's threshold logic faithfully: one-shot, first-crossing only.
//
// Honest divergence from CC: CC keeps a component-level boolean
// (hasShownCostDialog) and renders a blocking dialog. This leaf is intentionally
// STATELESS — the single `alreadyWarned` boolean lives in the caller (module-level
// scalar in the classic REPL, a ref in the TUI, matching the cacheWarning 刀114
// pattern). And khy surfaces a non-blocking dim one-liner instead of a modal, to
// match khy's existing per-turn notice aesthetic (cache warning / turn-stats) and
// the display-only red line (never block, never touch budget/permissions). Like
// CC, it fires once per session, NOT once per threshold multiple.

const DEFAULT_COST_THRESHOLD_USD = 5;
const OFF_VALUES = ['0', 'false', 'off', 'no'];

function costThresholdWarningEnabled(env) {
  const raw = env && env.KHY_COST_THRESHOLD_WARNING;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// Threshold in USD (> 0). Env override KHY_COST_THRESHOLD_USD; anything
// non-numeric or <= 0 → CC's documented default ($5). Mirrors CC's fixed $5 while
// staying configurable for khy operators on different budgets.
function getCostThreshold(env) {
  const raw = env && env.KHY_COST_THRESHOLD_USD;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_COST_THRESHOLD_USD;
}

function _numOrNull(v) {
  if (v == null) return null; // null/undefined → null (a real 0 stays 0)
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// CC-aligned money precision (mirrors ccFormat.ccFormatCost's documented rule:
// amounts > $0.50 → 2 decimals; smaller amounts → up to 4 decimals so a sub-cent
// threshold stays legible). Kept inline to preserve this leaf's zero-dependency
// purity while matching khy's canonical CC money aesthetic byte-for-byte on the
// reachable range. Non-finite / negative → "0.00" (fail-soft, never NaN).
function _fmtUSD(v) {
  const n = _numOrNull(v);
  if (n == null || n < 0) return '0.00';
  return n > 0.5 ? n.toFixed(2) : n.toFixed(4);
}

// Chinese-CLI warning line (khy scope allows Chinese). Mirrors CC's
// "You've spent $5 on the Anthropic API this session." — reports the actual
// running total and the crossed threshold, and points at /cost (khy's spend
// monitor) instead of CC's docs link. Money uses CC's magnitude-adaptive
// precision (_fmtUSD) so it matches every other khy dollar display.
function buildCostThresholdLine({ sessionCostUSD, threshold }) {
  const spentStr = _fmtUSD(sessionCostUSD);
  const thrStr = _fmtUSD(threshold == null ? DEFAULT_COST_THRESHOLD_USD : threshold);
  return `本会话 API 花费已达 $${spentStr}(超过 $${thrStr} 提醒阈值);用量监控见 /cost`;
}

// Convenience: given the current turn's cumulative session spend and the
// caller-held `alreadyWarned` flag, return { text } exactly once — the first time
// the running total crosses the threshold — so the caller can print it and set its
// flag. Returns null when: gate off, already warned this session, spend not yet at
// threshold, or spend not a finite number. Gate off / any error → null
// (byte-identical no-op fallback). Fully stateless — one-time is enforced by the
// caller's `alreadyWarned` boolean, exactly like CC's hasShownCostDialog.
function costThresholdFor(input, env) {
  try {
    const e = env || (typeof process !== 'undefined' ? process.env : {});
    if (!costThresholdWarningEnabled(e)) return null;
    if (input && input.alreadyWarned) return null; // one-time per session
    const cost = _numOrNull(input && input.sessionCostUSD);
    if (cost === null) return null; // no spend data → nothing to warn about
    const threshold = getCostThreshold(e);
    if (cost < threshold) return null; // not yet crossed
    return { text: buildCostThresholdLine({ sessionCostUSD: cost, threshold }) };
  } catch {
    return null;
  }
}

module.exports = {
  costThresholdWarningEnabled,
  getCostThreshold,
  buildCostThresholdLine,
  costThresholdFor,
  DEFAULT_COST_THRESHOLD_USD,
};
