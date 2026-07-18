'use strict';

// Single source of truth for turning a codex pre-response stall fingerprint
// into an ACTIVE routing/bypass decision.
//
// Background: codexAdapter's classifyCodexPreResponseStall() already produces a
// rich fingerprint (e.g. 'turn_started_reconnect_loop') when codex stalls before
// emitting meaningful model output. Historically that fingerprint was only
// recorded for diagnostics/audit. This module upgrades it from "passive
// observation" to "active bypass": the gateway escalates codex's fast-fail
// cooldown by severity so the next request virtual-skips codex and cascades to
// api/relay_api/direct, and the adapter bails out of a genuine reconnect loop
// before burning the full first-response window.
//
// Fingerprint codes MUST stay in sync with classifyCodexPreResponseStall().

// Transport is structurally broken (reconnect loops). Re-running the full wait
// window will almost certainly time out again — bypass aggressively.
const HARD_BAD_FINGERPRINTS = new Set([
  'turn_started_reconnect_loop',
  'thread_started_reconnect_loop',
  'transport_reconnect_before_turn',
]);

// Codex started but produced no meaningful model progress, or only startup
// noise. Could be a slow cold start; deprioritize mildly, not terminally.
const SOFT_BAD_FINGERPRINTS = new Set([
  'turn_started_no_followup',
  'thread_started_no_followup',
  'no_subprocess_output',
  'stderr_only_startup_noise',
  'non_meaningful_json_only',
  'plain_output_without_model_progress',
]);

function classifyStallSeverity(fingerprint) {
  const code = String(fingerprint || '').trim();
  if (HARD_BAD_FINGERPRINTS.has(code)) return 'hard';
  if (SOFT_BAD_FINGERPRINTS.has(code)) return 'soft';
  return 'none';
}

function isHardBadStall(fingerprint) {
  return classifyStallSeverity(fingerprint) === 'hard';
}

// Multiplier applied to codex's base fast-fail cooldown so the existing
// inspectCachedFastFail gate skips codex on subsequent requests for longer when
// the stall is genuinely bad. 'none' returns 1 (no behavior change).
function resolveStallCooldownMultiplier(fingerprint) {
  switch (classifyStallSeverity(fingerprint)) {
    case 'hard':
      return 3;
    case 'soft':
      return 1.5;
    default:
      return 1;
  }
}

// Within-request early bail decision. A GENUINE reconnect loop (multiple
// transport warnings with zero meaningful model output) means the transport is
// dead — stop waiting before the full first-response window elapses. A single
// startup reconnect hiccup must NOT bail (it is normal startup noise), so the
// threshold is strictly greater than 1.
function shouldEarlyBailOnReconnectLoop(snapshot, opts = {}) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const rawThreshold = Number(opts.threshold);
  const threshold = Number.isFinite(rawThreshold) && rawThreshold >= 2 ? rawThreshold : 3;
  const reconnectWarnings = Number(snapshot.reconnectWarnings || 0);
  const meaningfulEvents = Number(snapshot.meaningfulEvents || 0);
  const lastMeaningfulAt = Number(snapshot.lastMeaningfulAt || 0);
  // Model produced real progress → never bail; let it finish.
  if (meaningfulEvents > 0 || lastMeaningfulAt > 0) return false;
  return reconnectWarnings >= threshold;
}

// Spawn preflight: decide BEFORE spawning `codex exec` whether the local
// environment is obviously broken so we can fail fast instead of paying the
// spawn + full first-response window. Pure given gathered facts; the caller
// performs the actual filesystem probe and injects the result here.
function evaluateSpawnPreflight(facts = {}) {
  const homeDir = String(facts.homeDir || '').trim();
  if (facts.homeWritable === false) {
    return {
      ok: false,
      code: 'home_not_writable',
      reason: `codex HOME directory is not writable: ${homeDir || '(unknown)'}`,
    };
  }
  return { ok: true, code: 'ok', reason: '' };
}

module.exports = {
  HARD_BAD_FINGERPRINTS,
  SOFT_BAD_FINGERPRINTS,
  classifyStallSeverity,
  isHardBadStall,
  resolveStallCooldownMultiplier,
  shouldEarlyBailOnReconnectLoop,
  evaluateSpawnPreflight,
};
