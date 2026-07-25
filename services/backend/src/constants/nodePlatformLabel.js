'use strict';

/**
 * nodePlatformLabel.js — canonical human-readable label for Node's raw
 * `process.platform` / `os.platform()` id.
 *
 * WHY THIS LEAF EXISTS (平台自适应):
 * Several model-facing surfaces (system-prompt platform line, upgrade-runtime
 * prompt template) used the ternary `p === 'darwin' ? 'macOS' : p === 'win32'
 * ? 'Windows' : 'Linux'`. That `else → 'Linux'` LIES on any other Node platform
 * (freebsd / openbsd / netbsd / sunos / aix / android / haiku / cygwin): khy
 * would tell the model "Platform: Linux" on a BSD box and hand it Linux-only
 * guidance. This leaf is the single source of truth that maps the raw id to an
 * honest label and, for a genuinely unknown platform, reports it as-is instead
 * of pretending it is Linux.
 *
 * Pure + fail-soft: no I/O, never throws, no dependencies.
 *
 * Gated by KHY_PLATFORM_LABEL_ADAPTIVE (default-on). When disabled
 * (0/false/off/no) `resolvePlatformLabel` byte-reverts to the historical
 * ternary (unknown → 'Linux') so behavior is exactly restorable.
 *
 * HOW TO EXTEND — to teach khy a new platform label:
 *   1. Add a `raw_node_platform_id: 'Display Name'` entry to _PLATFORM_LABELS.
 *   2. Keys are lowercase Node platform ids (see `process.platform` docs).
 *   3. Anything not listed still degrades honestly (capitalized raw id), never
 *      to a wrong OS. Add a test case in nodePlatformLabel.test.js.
 */

// Raw Node platform id (lowercase) → human-readable label.
const _PLATFORM_LABELS = Object.freeze({
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
  freebsd: 'FreeBSD',
  openbsd: 'OpenBSD',
  netbsd: 'NetBSD',
  sunos: 'SunOS',
  aix: 'AIX',
  android: 'Android',
  haiku: 'Haiku',
  cygwin: 'Cygwin',
});

const _ADAPTIVE_FALSY = new Set(['0', 'false', 'off', 'no']);

function _normalizeKey(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

/**
 * Adaptive label: known ids map to their proper display name; an unknown but
 * non-empty id degrades to its capitalized raw form (honest, never a wrong OS);
 * empty/null → 'Unknown'.
 * @param {string} raw - a Node `process.platform` id
 * @returns {string}
 */
function nodePlatformLabel(raw) {
  const key = _normalizeKey(raw);
  if (!key) return 'Unknown';
  if (_PLATFORM_LABELS[key]) return _PLATFORM_LABELS[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Historical behavior, preserved verbatim for byte-revert: darwin → macOS,
 * win32 → Windows, everything else (including truly unknown) → Linux.
 * @param {string} raw
 * @returns {string}
 */
function legacyPlatformLabel(raw) {
  const key = _normalizeKey(raw);
  if (key === 'darwin') return 'macOS';
  if (key === 'win32') return 'Windows';
  return 'Linux';
}

function _adaptiveEnabled(env) {
  const raw = (env || process.env).KHY_PLATFORM_LABEL_ADAPTIVE;
  if (raw == null || raw === '') return true; // default-on
  return !_ADAPTIVE_FALSY.has(String(raw).trim().toLowerCase());
}

/**
 * Gate-aware resolver. Default-on → adaptive label; gate off → legacy ternary.
 * @param {string} raw - a Node `process.platform` id
 * @param {NodeJS.ProcessEnv} [env] - env source (defaults to process.env)
 * @returns {string}
 */
function resolvePlatformLabel(raw, env) {
  return _adaptiveEnabled(env) ? nodePlatformLabel(raw) : legacyPlatformLabel(raw);
}

module.exports = {
  nodePlatformLabel,
  legacyPlatformLabel,
  resolvePlatformLabel,
  // exported for tests
  _PLATFORM_LABELS,
};
