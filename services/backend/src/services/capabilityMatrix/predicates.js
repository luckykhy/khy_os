'use strict';

/**
 * predicates.js — pure flag-resolution leaf for the capability matrix.
 *
 * The ~27 capability seams scattered across toolUseLoop.js / toolCalling.js do
 * NOT all parse their KHY_* flag the same way. To make `isEnabledAt()` a drop-in
 * replacement for each inline check WITHOUT changing default-path behavior by a
 * single byte, every descriptor declares a `flag` spec carrying a `kind`, and
 * this module reproduces the EXACT boolean the original inline expression yields
 * for every possible env value.
 *
 * Verified dialects (kind → original inline expression it reproduces):
 *   'envFlagDefault' → _envFlagEnabled(env[name], default)
 *                      proactiveCollab / verifyGate / verifyNonEdit /
 *                      projectCoherence / deliverableClosure / selfKickoff
 *   'offDisables'    → env[name] !== 'off'   (raw, no trim, no lowercase)
 *                      selfHeal / syscallGateway / metaConstraint /
 *                      evoEngine / depHealing
 *   'zeroDisables'   → String(env[name] || '').trim() !== '0'
 *                      structuredFurnace
 *   'onEnables'      → ['1','on'].includes(env[name]) — default-OFF, explicit on
 *                      cognitiveSnapshot / contextScope (catalog-only in cut 1)
 *   'module'         → descriptor.isEnabledFn()
 *                      unknownProblemHandler.isEnabled()
 *   'always'         → true (unconditional seams)
 *
 * Pure: no I/O, no globals. `env` is injected (defaults to process.env) so the
 * resolver is fully unit-testable and the byte-identity proof lives at the unit
 * level (see tests/capabilityMatrix/predicates.test.js).
 */

/**
 * Canonical flag parser shared with toolUseLoop.js `_envFlagEnabled`.
 * Kept byte-identical to that function (verbatim copy) so the matrix and the
 * loop never drift. The loop re-exports this one to retire its local copy.
 *
 * @param {*} rawValue
 * @param {boolean} [defaultValue=true]
 * @returns {boolean}
 */
const envFlagEnabled = require('../../utils/envFlagEnabled');

/**
 * Resolve a descriptor flag spec to the same boolean the inline seam check
 * would produce.
 *
 * @param {object} flagSpec - { env:string, kind:string, default?:boolean }
 * @param {object} [deps]
 * @param {object} [deps.env=process.env]
 * @param {function} [deps.isEnabledFn] - for kind:'module'; called with no args
 * @returns {boolean}
 */
function resolveFlag(flagSpec, deps = {}) {
  const env = deps.env || process.env;
  if (!flagSpec || typeof flagSpec !== 'object') return true; // no flag → unconditional
  const kind = flagSpec.kind || 'always';
  const name = flagSpec.env;
  const raw = name ? env[name] : undefined;

  switch (kind) {
    case 'always':
      return true;

    case 'envFlagDefault':
      return envFlagEnabled(raw, flagSpec.default !== undefined ? flagSpec.default : true);

    case 'offDisables':
      // Original: `process.env.X === 'off'` disables → enabled is `!== 'off'`.
      // No trim / no lowercase — must match the raw strict comparison exactly.
      return raw !== 'off';

    case 'zeroDisables':
      // Original: `String(process.env.X || '').trim() !== '0'`.
      return String(raw || '').trim() !== '0';

    case 'onEnables':
      // Default-OFF capabilities enabled only by an explicit '1'/'on'
      // (cognitiveSnapshot, contextScope). Catalog-only in cut 1.
      return ['1', 'on'].includes(String(raw || '').trim().toLowerCase());

    case 'module': {
      // Module-internal gate (e.g. unknownProblemHandler.isEnabled()).
      const fn = deps.isEnabledFn;
      if (typeof fn !== 'function') return false;
      try {
        return !!fn();
      } catch {
        return false; // fail-closed: a throwing module gate counts as disabled
      }
    }

    default:
      return true;
  }
}

module.exports = { envFlagEnabled, resolveFlag };
