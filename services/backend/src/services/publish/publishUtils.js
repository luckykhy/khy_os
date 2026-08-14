'use strict';

/**
 * publishUtils.js — generic, dependency-free helpers for the publish pipeline.
 *
 * Second seam carved out of the cli/handlers/publish.js god-file (B1 split):
 * small pure utilities (int coercion, duration formatting, flag truthiness,
 * first-non-empty pick) plus the process exit-code marker. None depend on any
 * other publish helper, so they belong in the services layer. publish.js
 * imports them back under their original names, leaving every call site intact.
 */

function _toInt(value, fallback, min = 1) {
  const n = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return n;
}

// differs from services/timeFormat exports: floor + min-1s clamp, no ms/hour/day
// tiers (0ms→'1s', 999ms→'1s', 59999ms→'59s' vs Compact's undefined/'999ms'/'1m')
// — kept local, not delegated (byte conservation over consolidation).
function _formatDuration(ms) {
  const sec = Math.max(1, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m > 0 && s > 0) {
    return `${m}m ${s}s`;
  }
  if (m > 0) {
    return `${m}m`;
  }
  return `${s}s`;
}

// 收敛到 utils/markProcessFailure 单一真源(逐字节委托,调用点不变)
const _markFailure = require('../../utils/markProcessFailure');

// Delegates to utils/parseBoolean base tier — byte-equivalent to the previous
// inline `value === true || ['1','true','yes','on'].includes(String(value||'').trim().toLowerCase())`
// across the full input domain: booleans pass through, base tokens match
// case-insensitively after trim, and every other input (null/undefined/''/
// numbers other than 1/unknown strings/'y') resolves to the same false.
const _parseBoolean = require('../../utils/parseBoolean');

function _isTruthyFlag(value) {
  return _parseBoolean(value, false, { extended: false });
}

function _pickFirstNonEmpty(values = []) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

module.exports = {
  _toInt,
  _formatDuration,
  _markFailure,
  _isTruthyFlag,
  _pickFirstNonEmpty,
};
