'use strict';

/**
 * modelCapabilityPort — neutral, zero-dependency IoC seam for the model-capability
 * pre-check (DESIGN-ARCH-021, Batch 3).
 *
 * Breaks the reverse layering edges
 *   services/capabilityAssessment.js → cli/ai.js
 *   services/toolUseLoop.js          → cli/ai.js
 * which both only called `cli/ai.checkModelCapability(text)` (a read-only,
 * already-guarded capability heuristic — NOT model-call logic).
 *
 * cli/ai self-registers its `checkModelCapability` on load (legit cli → services
 * direction). Services consume via `getModelCapabilityChecker()`; when the CLI was
 * never loaded (daemon / headless / tests) the getter returns null and callers fall
 * back to their existing "no check" path — identical to the prior require-failure
 * branch. This module is a pure leaf: it requires nothing and executes no business
 * code.
 */

let _checker = null;

/** cli/ai registers its checkModelCapability(text) here on load. */
function registerModelCapabilityChecker(fn) {
  _checker = typeof fn === 'function' ? fn : null;
}

/** Returns the registered checker, or null when the CLI layer was never loaded. */
function getModelCapabilityChecker() {
  return _checker;
}

function _resetForTest() {
  _checker = null;
}

module.exports = {
  registerModelCapabilityChecker,
  getModelCapabilityChecker,
  _resetForTest,
};
