'use strict';

/**
 * trajectoryGuide/config.js — single source of env knobs for DESIGN-ARCH-049.
 *
 * "Trajectory as teacher": layers an optional AI dimension on top of the
 * deterministic replay subsystem (DESIGN-ARCH-048). Every knob is read from the
 * environment with a NAMED default (零硬编码) and every capability defaults to
 * OFF so the 048 engine and the live prompt are byte-identical until opted in.
 *
 *   KHY_TRAJ_AI_REPLAY          off    — enable the AI repair bridge (capability A).
 *   KHY_TRAJ_GUIDE_INJECT       off    — enable weak-model guidance injection (capability B).
 *   KHY_TRAJ_REPAIR_MAX         1      — repair attempts per step (mirrors selfHeal MAX_LOOP=1).
 *   KHY_TRAJ_REPAIR_MODEL       (none) — preferred model for the repair sub-agent.
 *   KHY_TRAJ_REPAIR_TIMEOUT_MS  120000 — activity timeout for one repair attempt.
 *   KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH  strong — minimum model strength allowed to author a map (capability C).
 *   KHY_TRAJ_GUIDE_CHARS        1200   — character budget for an injected guidance block.
 */

const DEFAULTS = Object.freeze({
  repairMax: 1,
  repairTimeoutMs: 120000,
  mapAuthorMinStrength: 'strong',
  guideChars: 1200,
});

/** Parse a boolean-ish env flag; treats on/1/true/yes (case-insensitive) as true. */
function _flag(raw) {
  if (raw == null) return false;
  return /^(on|1|true|yes)$/i.test(String(raw).trim());
}

/** Parse a positive integer env value, falling back to `def`. */
function _posInt(raw, def) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Capability A — is the AI repair bridge enabled for replay? */
function isAiReplayEnabled() {
  return _flag(process.env.KHY_TRAJ_AI_REPLAY);
}

/** Capability B — is weak-model guidance injection enabled? */
function isGuideInjectEnabled() {
  return _flag(process.env.KHY_TRAJ_GUIDE_INJECT);
}

/** Max repair attempts per step (>=1). */
function repairMax() {
  return _posInt(process.env.KHY_TRAJ_REPAIR_MAX, DEFAULTS.repairMax);
}

/** Activity timeout (ms) for a single repair attempt. */
function repairTimeoutMs() {
  return _posInt(process.env.KHY_TRAJ_REPAIR_TIMEOUT_MS, DEFAULTS.repairTimeoutMs);
}

/** Preferred model id for the repair sub-agent, or null to inherit the default. */
function repairModel() {
  const v = process.env.KHY_TRAJ_REPAIR_MODEL;
  return v && String(v).trim() ? String(v).trim() : null;
}

/** Minimum model strength permitted to AUTHOR a map template ('strong'|'weak'). */
function mapAuthorMinStrength() {
  const v = process.env.KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH;
  const s = v && String(v).trim().toLowerCase();
  return s === 'weak' || s === 'strong' ? s : DEFAULTS.mapAuthorMinStrength;
}

/** Character budget for an injected guidance block. */
function guideChars() {
  return _posInt(process.env.KHY_TRAJ_GUIDE_CHARS, DEFAULTS.guideChars);
}

module.exports = {
  DEFAULTS,
  isAiReplayEnabled,
  isGuideInjectEnabled,
  repairMax,
  repairTimeoutMs,
  repairModel,
  mapAuthorMinStrength,
  guideChars,
};
