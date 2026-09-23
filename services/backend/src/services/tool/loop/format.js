'use strict';

/**
 * Loop display/format helper family, extracted verbatim from toolUseLoopCore.js
 * (T-021 C3-P8). Pure zero-require leaf: nothing here touches the god-file or any
 * sibling service, so there is NO back-edge and no managed<->managed require cycle.
 * The core re-requires _formatDurationMs (exported, used in the budget/idle-stop
 * notices) and _buildPlannedToolList (used at the plan-render call site); it does NOT
 * need _normalizeToolNameForDisplay (that one is only ever a private helper of
 * _buildPlannedToolList). Public surface of the core unchanged.
 */

// differs from services/timeFormat exports: ceil + min-1s clamp, Number(ms||0)
// coercion, no ms/hour/day tiers (0ms→'1s', 999ms→'1s', 61000ms→'1m 1s',
// 3600000ms→'60m') — also differs from publishUtils._formatDuration (floor vs
// ceil: 1500ms→'2s' here vs '1s' there). Kept local, not delegated.
function _formatDurationMs(ms) {
  const totalSec = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0 && s > 0) {
    return `${m}m ${s}s`;
  }
  if (m > 0) {
    return `${m}m`;
  }
  return `${s}s`;
}

function _normalizeToolNameForDisplay(name = '') {
  const raw = String(name || '').trim();
  if (!raw) {
    return '';
  }
  if (raw === '_legacy_cmd') {
    return 'command';
  }
  return raw
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

function _buildPlannedToolList(toolCalls = [], maxItems = 6) {
  const names = [];
  const seen = new Set();
  for (const call of toolCalls) {
    const normalized = _normalizeToolNameForDisplay(call?.name);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    names.push(normalized);
    if (names.length >= maxItems) {
      break;
    }
  }
  return names;
}

module.exports = { _formatDurationMs, _normalizeToolNameForDisplay, _buildPlannedToolList };
