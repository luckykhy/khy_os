'use strict';

/**
 * pluginDoctorPort.js — neutral port exposing the plugin-doctor capability.
 * Breaks the batch-2 reverse edge (DESIGN-ARCH-021, Batch 2):
 *
 *   - services/baseSelfCheckService.js → cli/handlers/plugin-dev.js (runPluginDoctorForDir)
 *
 * The legit direction is `cli → services`; the only reverse edge was the
 * self-check service requiring the CLI plugin-dev handler to run a per-directory
 * plugin doctor. cli/handlers/plugin-dev self-registers its doctor on load; the
 * self-check resolves it via getPluginDoctor(). If the handler was never loaded
 * (headless service / test), getPluginDoctor() returns null and the optional
 * doctor sub-check is skipped — the same degrade the prior `try { require(...) }
 * catch {}` provided.
 *
 * Zero dependencies — a true leaf, so it can never participate in a cycle.
 */

let _doctor = null;   // async (pluginDir, options) => report   from cli/handlers/plugin-dev

/** Register the plugin-doctor runner. Called by cli/handlers/plugin-dev on load. */
function registerPluginDoctor(fn) {
  _doctor = typeof fn === 'function' ? fn : null;
}

/**
 * @returns {Function|null} The registered runPluginDoctorForDir, or null if the
 *   CLI plugin-dev handler has not been loaded.
 */
function getPluginDoctor() {
  return _doctor;
}

/** @internal Reset registration for testing. */
function _resetForTest() {
  _doctor = null;
}

module.exports = { registerPluginDoctor, getPluginDoctor, _resetForTest };
