'use strict';

/**
 * gateway/constants.js — routing constants for AIGateway.
 *
 * Extracted from services/gateway/aiGateway.js to eliminate god-file
 * coupling. All values are env-overridable where applicable.
 *
 * @module gateway/constants
 */

// Default process-failover adapter order when no env override is set.
// Override via KHY_PROCESS_FAILOVER_CANDIDATES (comma-separated keys).
const DEFAULT_PROCESS_FAILOVER_CANDIDATES = ['relay_api', 'api', 'relay', 'ollama'];

// Adapter keys that are always available as manual fallback regardless of
// the auto-route ranking (e.g. clipboard relay when network adapters fail).
const DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS = new Set(['relay', 'clipboard']);

// Adapter keys that use HTTP relay semantics for the dead-endpoint relaxation path.
const HTTP_RELAY_ADAPTER_KEYS = new Set(['relay_api', 'api', 'relay']);

// Falsy alias set used when parsing env vars that accept {0|false|off|no}.
const RELAY_BARE_ALIAS_FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * Parse a comma-separated env var into an adapter key list, falling back
 * to the provided default.
 *
 * @param {string} raw - Raw env var value
 * @param {string[]} fallback - Default list
 * @returns {string[]}
 */
function parseProcessFailoverCandidates(raw, fallback = DEFAULT_PROCESS_FAILOVER_CANDIDATES) {
  const list = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
}

module.exports = {
  DEFAULT_PROCESS_FAILOVER_CANDIDATES,
  DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS,
  HTTP_RELAY_ADAPTER_KEYS,
  RELAY_BARE_ALIAS_FALSY,
  parseProcessFailoverCandidates,
};
