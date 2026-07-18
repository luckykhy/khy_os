'use strict';

/**
 * envPlatform.js — platform-context resolver for "打造最佳环境".
 *
 * The "注意 linux/windows/macos/android/ios 系统的区分" layer. Environment health
 * is not uniform across operating systems: a load average is meaningless on
 * Windows, a Windows registry check is meaningless on Linux, and a mobile/sandbox
 * OS (iOS, HarmonyOS) constrains what can be repaired at all. This leaf gives the
 * probe and repair registries a single, canonical platform identity plus per-OS
 * traits, so each probe/repair can declare which platforms it applies to and the
 * aggregators skip the rest — differentiation collected in ONE place, never
 * smeared across every probe with ad-hoc process.platform checks.
 *
 * SINGLE SOURCE OF TRUTH: the five canonical OSes (Linux/Windows/macOS/Android/
 * HarmonyOS) are resolved via osProfileService → envSymbiosis/platformIds, the
 * repo's existing OS-identity authority. We do NOT fork a second os.platform()
 * table. iOS is refined ON TOP because platformIds' frozen PLATFORM enum does not
 * include it (standard Node does not target iOS; only mobile runtimes / an
 * explicit KHY_OS_PROFILE=ios pin surface it).
 *
 * Pure-ish + fail-soft: resolution never throws; on any failure it degrades to
 * Linux (the repo's own default). No mutation of any platformIds constant.
 */

const os = require('os');

let _PLATFORM = null;
try { _PLATFORM = require('./envSymbiosis/platformIds').PLATFORM; }
catch { _PLATFORM = null; }

// env_optimize platform ids (lowercase, stable) + per-OS traits used by probes
// and repairs to decide applicability. `sandboxed` = OS strongly constrains
// filesystem / process access (mobile app sandbox), so system-level repairs are
// limited. `hasLoadAvg` = POSIX load average is meaningful (false on Windows).
const _PLATFORM_META = Object.freeze({
  linux: Object.freeze({ id: 'linux', label: 'Linux', sandboxed: false, hasLoadAvg: true }),
  windows: Object.freeze({ id: 'windows', label: 'Windows', sandboxed: false, hasLoadAvg: false }),
  macos: Object.freeze({ id: 'macos', label: 'macOS', sandboxed: false, hasLoadAvg: true }),
  android: Object.freeze({ id: 'android', label: 'Android', sandboxed: false, hasLoadAvg: true }),
  harmonyos: Object.freeze({ id: 'harmonyos', label: 'HarmonyOS', sandboxed: true, hasLoadAvg: true }),
  ios: Object.freeze({ id: 'ios', label: 'iOS', sandboxed: true, hasLoadAvg: true }),
});

// Canonical PLATFORM value (from platformIds) → env_optimize id.
function _canonicalToId(osName) {
  if (!_PLATFORM) return 'linux';
  switch (osName) {
    case _PLATFORM.LINUX: return 'linux';
    case _PLATFORM.WINDOWS: return 'windows';
    case _PLATFORM.MACOS: return 'macos';
    case _PLATFORM.ANDROID: return 'android';
    case _PLATFORM.HARMONY: return 'harmonyos';
    default: return 'linux';
  }
}

// iOS is not in platformIds' PLATFORM enum. Detect it only from explicit signals
// so a normal macOS host (also nodePlatform 'darwin') is never misread as iOS.
function _detectIos() {
  try {
    const pin = String(process.env.KHY_OS_PROFILE || '').trim().toLowerCase();
    if (pin === 'ios' || pin === 'iphoneos' || pin === 'ipados' || pin === 'ipad') return true;
  } catch { /* ignore */ }
  try {
    // Some mobile Node runtimes (nodejs-mobile) report 'ios' directly.
    if (os.platform() === 'ios') return true;
  } catch { /* ignore */ }
  return false;
}

/**
 * Resolve the current platform context. Reuses osProfileService for the five
 * canonical OSes (respecting its KHY_OS_PROFILE pin and test probes), refines iOS
 * on top. Never throws; degrades to Linux.
 *
 * @returns {{id:string, label:string, sandboxed:boolean, hasLoadAvg:boolean, source:string}}
 */
function detectPlatform() {
  if (_detectIos()) return { ..._PLATFORM_META.ios, source: 'ios-refine' };
  let osName = _PLATFORM ? _PLATFORM.LINUX : null;
  let source = 'default';
  try {
    const prof = require('./osProfileService').detectOsProfile();
    if (prof && prof.os) { osName = prof.os; source = prof.source || 'auto'; }
  } catch { /* degrade to linux */ }
  const id = _canonicalToId(osName);
  return { ...(_PLATFORM_META[id] || _PLATFORM_META.linux), source };
}

/**
 * Applicability test for a platform-scoped registry entry. An entry may declare
 * `platforms: ['linux','macos', ...]` to restrict itself; absent/empty = applies
 * to ALL platforms (the common case). Centralizes the differentiation rule so no
 * probe/repair re-implements it.
 *
 * @param {{platforms?:string[]}} entry
 * @param {string} platformId
 * @returns {boolean}
 */
function appliesTo(entry, platformId) {
  if (!entry) return false;
  const list = entry.platforms;
  if (!Array.isArray(list) || list.length === 0) return true; // all platforms
  return list.includes(platformId);
}

module.exports = {
  detectPlatform,
  appliesTo,
  // exported for tests
  _PLATFORM_META,
  _canonicalToId,
  _detectIos,
};
