'use strict';

/**
 * customProviderVision.js — declared vision capability from custom provider config.
 *
 * custom_providers.json entries may declare vision support in two shapes:
 *   - provider-level: `capabilities: { vision: true }` — applies to every model
 *     listed under that provider (models[] + defaultModel);
 *   - model-level:    `visionModels: ['model-a', ...]` — only those model ids.
 *
 * Both fields are optional; absent fields keep existing behavior unchanged.
 * Priority (enforced by the caller, visionCapability.js): below the explicit
 * env/builtin vision sets, above builtin text-only set and name heuristics.
 * KHY_TEXT_ONLY_MODELS still wins over any declaration here.
 *
 * Fail-soft: registry missing / file unreadable / parse error → false, never
 * throws to the caller. No provider name is hardcoded here (zero-hardcode rule).
 */

function _norm(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase();
}

/**
 * Build the set of declared vision-capable model ids (lowercased).
 * Rebuilt per call: customProviderRegistry caches the file in memory, so this
 * stays cheap while always reflecting in-process registry updates.
 * @returns {Set<string>}
 */
function _declaredVisionSet() {
  const set = new Set();
  // Lazy require: keeps this leaf loadable even if the registry module moves.
  const registry = require('../customProviderRegistry');
  const providers = registry.listProviders();
  for (const p of providers) {
    if (!p || typeof p !== 'object') {
      continue;
    }
    const providerWide = !!(p.capabilities && p.capabilities.vision === true);
    if (providerWide) {
      const models = Array.isArray(p.models) ? p.models : [];
      for (const m of models) {
        const id = _norm(m);
        if (id) {
          set.add(id);
        }
      }
      const def = _norm(p.defaultModel);
      if (def) {
        set.add(def);
      }
    }
    const visionModels = Array.isArray(p.visionModels) ? p.visionModels : [];
    for (const m of visionModels) {
      const id = _norm(m);
      if (id) {
        set.add(id);
      }
    }
  }
  return set;
}

/**
 * Whether a model id is declared vision-capable by a custom provider entry.
 * @param {string} model model id (any case; will be normalized)
 * @returns {boolean}
 */
function isDeclaredVisionModel(model) {
  const modelLower = _norm(model);
  if (!modelLower) {
    return false;
  }
  try {
    return _declaredVisionSet().has(modelLower);
  } catch {
    return false; // fail-soft: config unavailable → existing behavior
  }
}

module.exports = { isDeclaredVisionModel, _declaredVisionSet };
