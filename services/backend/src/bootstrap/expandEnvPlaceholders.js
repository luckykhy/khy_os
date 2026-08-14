'use strict';

/**
 * Expand `{env:VAR}` placeholders inside env values.
 *
 * The `.env` files here use `{env:OTHER_VAR}` to reference another variable
 * instead of duplicating a secret, e.g.
 *
 *   STEPFUN_API_KEY=<real key>
 *   RELAY_API_KEY={env:STEPFUN_API_KEY}
 *
 * dotenv does not understand that syntax, and nothing else in this repo expanded
 * it either — so the literal string `{env:STEPFUN_API_KEY}` reached
 * relayApiAdapter.getConfig() and went out as `Authorization: Bearer
 * {env:STEPFUN_API_KEY}`, producing HTTP 401 invalid_api_key on *every* relay
 * request regardless of which model was selected.
 *
 * Resolution is iterative (a reference may point at another reference) and
 * bounded by MAX_PASSES, so a reference cycle degrades to "leave as-is" rather
 * than looping forever.
 *
 * Unresolvable references are deliberately left verbatim instead of being
 * blanked: an obviously-wrong `Bearer {env:MISSING}` is far easier to diagnose
 * than a silently empty credential that reads as "no key configured".
 */

const PLACEHOLDER_RE = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const MAX_PASSES = 5;

function _hasPlaceholder(value) {
  return typeof value === 'string' && value.includes('{env:');
}

/**
 * @param {Record<string, string>} env mutated in place (defaults to process.env)
 * @returns {string[]} names of the variables whose value changed
 */
function expandEnvPlaceholders(env = process.env) {
  const changed = new Set();
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let progressed = false;
    for (const name of Object.keys(env)) {
      const value = env[name];
      if (!_hasPlaceholder(value)) {
        continue;
      }
      const next = value.replace(PLACEHOLDER_RE, (match, ref) => {
        // Self-reference or a still-unresolved target → keep the placeholder so
        // the next pass (or a human) can deal with it.
        if (ref === name) {
          return match;
        }
        const resolved = env[ref];
        if (typeof resolved !== 'string' || !resolved) {
          return match;
        }
        if (_hasPlaceholder(resolved)) {
          return match;
        }
        return resolved;
      });
      if (next === value) {
        continue;
      }
      env[name] = next;
      changed.add(name);
      progressed = true;
    }
    if (!progressed) {
      break;
    }
  }
  return [...changed];
}

module.exports = { expandEnvPlaceholders };
