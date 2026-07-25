'use strict';

/**
 * envInt.js — single source of truth for parsing an environment variable as a
 * bounded integer with a fallback default.
 *
 * Replaces the scattered `parseInt(process.env.X || '', 10)` idiom and the
 * divergent per-module `_int()` helpers (inputSanitizer/metaToolEngine/buildProject),
 * which handled bounds/defaults inconsistently. See [MGMT-RPT-020] REQ-2026-010.
 *
 * @param {string} name - Environment variable name.
 * @param {number} def - Default value when unset or unparseable.
 * @param {{min?: number, max?: number}} [bounds] - Optional inclusive clamp.
 * @returns {number}
 */
function envInt(name, def, bounds = {}) {
  const n = parseInt(process.env[name], 10);
  let val = Number.isFinite(n) ? n : def;
  if (typeof bounds.min === 'number' && val < bounds.min) val = bounds.min;
  if (typeof bounds.max === 'number' && val > bounds.max) val = bounds.max;
  return val;
}

module.exports = envInt;
