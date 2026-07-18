'use strict';

/**
 * envNum.js — single source of truth for the "read an env value as an optional
 * number" helper: given an env bag and a key, return the parsed finite number,
 * or `undefined` when the key is missing / blank / non-numeric so the caller can
 * apply its own default (typically via {@link clampInt}).
 *
 * Distinct from {@link envInt}: that one reads `process.env` by name and applies
 * a default + bounds itself. This one takes an already-in-hand `env` bag (so it
 * is injectable / testable), applies no bounds, and returns `undefined` rather
 * than a fallback — the "parse only, decide later" primitive. Three byte-identical
 * private `_envNum(env, key)` copies (selfRepairTransaction.js, memoryWriteSafety.js,
 * browser/scrollPlan.js) drifted as copy-paste; all three now delegate here.
 *
 * Contract: pure, deterministic, never throws.
 *   - missing / null / blank-after-trim `env[key]` → `undefined`
 *   - non-finite Number(raw) → `undefined`
 *   - otherwise → Number(raw)
 *
 * @param {Object} env  env bag (e.g. process.env or an injected fake)
 * @param {string} key  variable name to read
 * @returns {number|undefined}
 */
function envNum(env, key) {
  const raw = env && env[key];
  if (raw == null || String(raw).trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

module.exports = envNum;
