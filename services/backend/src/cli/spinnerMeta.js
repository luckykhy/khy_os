'use strict';

// Spinner status-byline reveal gate — pure leaf (zero IO, zero business
// require). Aligns the LOGIC BEHIND Claude Code's spinner: the
// "Xm Ys · ↓ N tokens" byline is NOT shown from the first frame — it is
// revealed only after 30s (or immediately in verbose mode / when teammates
// run). For the first 30s the spinner shows just the verb + glyph, so a
// fast turn never flashes a timer/token counter.
//
// CC reference: src/components/Spinner/SpinnerAnimationRow.tsx
//   const SHOW_TOKENS_AFTER_MS = 30_000
//   const wantsTimerAndTokens =
//     verbose || hasRunningTeammates || effectiveElapsedMs > SHOW_TOKENS_AFTER_MS
//   ... showTimer = wantsTimerAndTokens && (width)
//   ... showTokens = wantsTimerAndTokens && totalTokens > 0 && (width)
// The "thinking"/effort suffix is gated by width only, NOT the 30s clock, so
// it survives the reveal gate.
//
// khy divergence this fixes: cli/spinner.js seeds `parts = [elapsedStr]` and
// pushes token parts whenever the counters are > 0 — no elapsed gate at all,
// so the byline shows from frame 1.

const SHOW_TOKENS_AFTER_MS = 30000;

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env) {
  const raw = env && env.KHY_SPINNER_META_GATE;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 有限数强转家族单一真源 utils/finiteNumber(见 finiteNumber.js)。
const _num = require('../utils/finiteNumber').toNonNegOr0;

// CC wantsTimerAndTokens. When the gate is disabled we always reveal (legacy
// byte-fallback: timer + tokens shown from the first frame).
function shouldShowTimerAndTokens(opts) {
  const o = opts || {};
  if (o.gateEnabled === false) return true;
  if (o.verbose) return true;
  if (o.hasTeammates) return true;
  return _num(o.elapsedMs) > SHOW_TOKENS_AFTER_MS;
}

// Assemble the ordered status parts for the spinner byline. The timer and
// token texts are gated by shouldShowTimerAndTokens; the effort/thinking
// suffix is always appended (width-gated by the caller, not here). Empty
// strings are dropped so the caller can pass '' for absent token/effort.
//
// Order matches legacy exactly when revealed: [timer, in, out, effort].
function buildStatusParts(opts) {
  const o = opts || {};
  const showMeta = shouldShowTimerAndTokens(o);
  const parts = [];
  if (showMeta) {
    if (o.timerText) parts.push(o.timerText);
    if (o.inputTokensText) parts.push(o.inputTokensText);
    if (o.outputTokensText) parts.push(o.outputTokensText);
  }
  if (o.effortText) parts.push(o.effortText);
  return parts.filter(Boolean);
}

module.exports = {
  isEnabled,
  shouldShowTimerAndTokens,
  buildStatusParts,
  SHOW_TOKENS_AFTER_MS,
};
