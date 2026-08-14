'use strict';

/**
 * modelCapabilityIndex — unified entry point for all model-capability systems.
 *
 * KHY has four independent capability modules, each answering a different question:
 *
 *   Module                  Question answered
 *   ─────────────────────   ──────────────────────────────────────────────────
 *   modelTier               What tier is this model? (T0 frontier … T3 weak)
 *   modelCapability         What media can this model handle? (text/audio/image/video)
 *   modelToolingCapability  Does this model support native function calling?
 *   capabilityRegistry      Which adapter scores highest for a given task type?
 *
 * Instead of scattering require() calls across 20+ files, import from here.
 *
 * Usage:
 *   const { getTier, getMediaCapability, getToolingCapability, getBestAdapters } = require('./modelCapabilityIndex');
 */

const { getCapabilityRegistry, TASK_REQUIREMENTS } = require('./gateway/capabilityRegistry');
const { classifyCapability } = require('./gateway/modelCapability');
const { modelLacksReliableToolCalling } = require('./gateway/modelToolingCapability');
const { resolveTier, harnessProfile } = require('./modelTier');

// ── Tier (modelTier.js) ──────────────────────────────────────────────

/**
 * Resolve a model's tier: T0 (frontier) → T1 (strong) → T2 (default) → T3 (weak).
 * Env overrides (KHY_CAPABILITY_TIER, KHY_MODEL_TIER_MAP) are respected.
 * @param {string} modelId
 * @returns {string} 'T0' | 'T1' | 'T2' | 'T3'
 */
function getTier(modelId) {
  return resolveTier(modelId);
}

/**
 * Get the harness profile for a model (which scaffolding to apply).
 * @param {string} modelId
 * @returns {object} { tier, nudges, syntheticTools, capabilityGate, promptVerbosity, ... }
 */
function getHarnessProfile(modelId) {
  return harnessProfile(modelId);
}

// ── Media capability (modelCapability.js) ────────────────────────────

/**
 * Classify a model's media capability: 'text' | 'audio' | 'image' | 'video'.
 * @param {string} modelId
 * @param {string} [sourceHint]
 * @returns {string}
 */
function getMediaCapability(modelId, sourceHint) {
  return classifyCapability(modelId, sourceHint);
}

// ── Tooling capability (modelToolingCapability.js) ───────────────────

/**
 * Determine if a model supports reliable native function calling.
 * @param {string} modelId
 * @returns {boolean}
 */
function getToolingCapability(modelId) {
  return !modelLacksReliableToolCalling(modelId);
}

// ── Adapter selection (capabilityRegistry.js) ─────────────────────────

/**
 * Find adapters that meet a task type's requirements, ranked by capability score.
 * @param {string} taskType - e.g. 'reasoning', 'code', 'vision', 'conversation'
 * @param {object} [opts]
 * @param {boolean} [opts.onlyAvailable=true]
 * @param {number} [opts.limit=5]
 * @returns {Array<{ key: string, score: number, gaps: string[] }>}
 */
function getBestAdapters(taskType, opts = {}) {
  try {
    const registry = getCapabilityRegistry();
    if (!registry) {
      return [];
    }
    const requirements = TASK_REQUIREMENTS[taskType];
    if (!requirements) {
      return [];
    }
    return registry.bestAdaptersFor(requirements, { onlyAvailable: true, limit: opts.limit || 5 });
  } catch {
    return [];
  }
}

/**
 * Get capability scores for an adapter.
 * @param {string} adapterKey
 * @returns {object|null} 11-dimension scores
 */
function getAdapterCapabilities(adapterKey) {
  try {
    const registry = getCapabilityRegistry();
    if (!registry) {
      return null;
    }
    return registry.getCapabilities(adapterKey);
  } catch {
    return null;
  }
}

module.exports = {
  // Tier
  getTier,
  getHarnessProfile,
  // Media
  getMediaCapability,
  // Tooling
  getToolingCapability,
  // Adapter selection
  getBestAdapters,
  getAdapterCapabilities,
};
