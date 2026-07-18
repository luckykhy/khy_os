'use strict';

/**
 * routePresets.js — named, reusable capability routes.
 *
 * A preset is a named selection + ordering of capability ids: a recognizable
 * "implementation route" the user can pick or that auto-selects from request
 * signals (intentGate modes). Presets do NOT introduce new execution paths or
 * new capabilities — they are purely a declarative subset + ordering overlay on
 * the descriptors in ./descriptors.js. The composer maps `signals.modes` to a
 * preset via `whenModes`, then uses the preset's `capabilities` order as a
 * fine-grained ordering hint on top of the seam/phase ordering.
 *
 * Cut 1: presets shape and label the OBSERVED route (which capabilities are
 * relevant for this kind of request) without changing whether a capability
 * fires — gating stays the descriptor's flag + preconditions. Presets become
 * authoritative for ordering/selection in cut 2 (route-driven execution).
 */

const PRESETS = Object.freeze([
  {
    id: 'research',
    label: '研究路线 (search → cross-source dedup → synthesize)',
    // Information-gathering: lean on search + reasoning, no delivery gates.
    capabilities: ['unifiedSearch', 'structuredFurnace', 'verifyNonEdit'],
    whenModes: ['analyze', 'learn'],
    requires: {},
  },
  {
    id: 'delivery',
    label: '交付路线 (implement → verify → coherence → closure)',
    // Code/build delivery: the full quality + delivery chain.
    capabilities: [
      'structuredFurnace',
      'selfHeal',
      'depHealing',
      'verifyGate',
      'projectCoherence',
      'deliverableClosure',
    ],
    whenModes: ['coding', 'ultrawork', 'goal'],
    requires: { tool_use: 3 },
  },
  {
    id: 'audit',
    label: '审计路线 (read-only review → adversarial verify)',
    // Read-only inspection: audit + verification, no mutation healing.
    capabilities: ['auditFix', 'verifyGate', 'verifyNonEdit'],
    whenModes: [],
    requires: {},
  },
]);

/**
 * Pick the first preset whose `whenModes` intersects the active modes.
 * Returns null when no preset matches (auto-inference falls back to the full
 * descriptor set with no preset overlay).
 *
 * @param {string[]} modes - active modes from intentGate.detectModes
 * @returns {object|null}
 */
function selectPreset(modes) {
  const active = Array.isArray(modes) ? modes : [];
  if (active.length === 0) return null;
  for (const preset of PRESETS) {
    if (preset.whenModes.some((m) => active.includes(m))) return preset;
  }
  return null;
}

function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

module.exports = { PRESETS, selectPreset, getPreset };
