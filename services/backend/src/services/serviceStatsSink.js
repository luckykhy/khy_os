'use strict';

/**
 * serviceStatsSink.js — zero-dependency provider sink for service-registry stats.
 *
 * Decoupling rationale ([DESIGN-ARCH-051] §6.7): telemetryService used to pull
 * health numbers by lazily loading serviceRegistry and calling its stats()
 * directly. That single best-effort query edge (telemetry → serviceRegistry)
 * pulled telemetry into the giant dependency SCC, because serviceRegistry sits
 * at the head of the orchestration cluster (toolUseLoop / AgentTool / harness).
 *
 * The dependency direction is inverted via this leaf: serviceRegistry registers
 * its own stats getter here at load time, and telemetry reads through the leaf
 * instead of importing the registry. Because the leaf depends on nothing, it is
 * never part of any cycle, so the read no longer ties telemetry to the registry.
 *
 * Semantics are preserved exactly: the read was always best-effort and
 * non-critical. When no provider has registered (registry not yet loaded), the
 * getter yields undefined — telemetry simply leaves the field unset, the same
 * outcome the old try/catch produced when the registry was unavailable.
 *
 * NOTE: this file deliberately contains no module-loading call syntax anywhere,
 * including comments, so the architecture-debt scanner cannot mistake it for a
 * dependency edge (the scanner matches the call token without stripping
 * comments — a phantom edge would re-enter the leaf into the SCC).
 */

/** @type {null | (() => object)} */
let _provider = null;

/**
 * Register the service-stats provider. Passing a non-function clears it.
 * @param {() => object} fn
 */
function setServiceStatsProvider(fn) {
  _provider = typeof fn === 'function' ? fn : null;
}

/**
 * Read current service-registry stats through the registered provider.
 * Returns undefined when no provider is registered or the provider throws,
 * so callers treat absence as "registry not available" (best-effort).
 * @returns {object | undefined}
 */
function getServiceStats() {
  if (!_provider) return undefined;
  try {
    return _provider();
  } catch {
    return undefined;
  }
}

module.exports = { setServiceStatsProvider, getServiceStats };
