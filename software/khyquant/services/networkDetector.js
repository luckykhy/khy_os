'use strict';

/**
 * Network reachability detector — lightweight fallback.
 *
 * Restores the `./networkDetector` module that klineDataService and
 * realtimeDataService hard-require but which was missing from the tree (causing
 * "Cannot find module './networkDetector'" at load time). klineDataService calls
 * `init()` (awaited with `.catch`) once and realtimeDataService gates a live-fetch
 * branch on `isOnline()`.
 *
 * This implementation defaults to "online" so the live data path is attempted —
 * matching the prior behavior where the live sources were the primary route and
 * offline handling was best-effort. `init()` can be extended to probe an endpoint
 * and flip the cached flag; the public surface (init / isOnline) stays the same.
 */

let _online = true;

/**
 * Initialize the detector. No-op probe in the fallback; resolves immediately.
 * @returns {Promise<boolean>} current online flag
 */
async function init() {
  return _online;
}

/**
 * @returns {boolean} whether the network is considered reachable (default true).
 */
function isOnline() {
  return _online;
}

/** Test/override hook: set the cached online flag. */
function _setOnline(value) {
  _online = Boolean(value);
}

module.exports = { init, isOnline, _setOnline };
