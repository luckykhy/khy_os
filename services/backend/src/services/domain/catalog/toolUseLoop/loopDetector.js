'use strict';

/**
 * domain/catalog/toolUseLoop/loopDetector.js — Phase-2 5-detector construction,
 * carved out of toolUseLoopCore.js runToolUseLoop body (T-021 in-body slice #4).
 *
 * Builds the ToolLoopDetector and registers known tool names for unknown-tool
 * detection. The whole thing is fail-soft: BOTH the detector module and the
 * tool-registry are optional — a require failure leaves loopDetector null (or
 * skips only registration) rather than throwing, exactly as the former inline
 * block did. The core calls this factory at the identical source position, so
 * the two lazy requires fire at the same instant.
 *
 * In-body convention: the only core-internal input (the memoized known-tool-name
 * resolver) is passed as a dep → ZERO require back into toolUseLoopCore. The two
 * lazy requires below point at sibling modules (toolLoopDetector, tools barrel),
 * re-based for this dir; NO cycle back to the core, so M6 cycles stay 0.
 */

function createLoopDetector(deps = {}) {
  const { resolveKnownToolNames } = deps;

  // Phase 2: 5-detector loop detection (replaces simple dedup for advanced checks)
  let loopDetector;
  try {
    const { ToolLoopDetector } = require('../../../tool/toolLoopDetector');
    loopDetector = new ToolLoopDetector();
    // Register known tools for unknown-tool detection
    try {
      const toolRegistry = require('../../../../tools');
      const allTools = toolRegistry.getEnabled ? toolRegistry.getEnabled() : toolRegistry.getAll();
      if (allTools) {
        // Known-tool-name derivation memoized by enabled-name set (Ch2). Off →
        // rebuilds every turn (byte-identical). registerTools copies names into
        // its own Set, so the shared cached array is never mutated.
        loopDetector.registerTools(resolveKnownToolNames(allTools));
      }
    } catch {
      /* registry not available, skip unknown-tool detection */
    }
  } catch {
    loopDetector = null; /* toolLoopDetector not available */
  }

  return { loopDetector };
}

module.exports = { createLoopDetector };
