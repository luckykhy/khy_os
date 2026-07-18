'use strict';

/**
 * seams.js — the fixed injection points ("seams") in the agent's execution road.
 *
 * Today each capability fires at a hardcoded physical location in the loop. This
 * module names those locations so descriptors and the loop sites reference
 * symbols instead of magic strings, and so the composer can order capabilities
 * by the phase rank of their seam.
 *
 * A seam is WHERE a capability can fire; a descriptor's `phase` orders
 * capabilities within and across seams (lower = earlier). The `order` here is
 * the coarse phase floor of each seam — descriptors add a fine offset.
 */

const SEAMS = Object.freeze({
  // Before tool dispatch, on the model's first turn — proactive seams that turn
  // a no-tool-call reply into action (proactive collaboration, structured furnace).
  PRE_DISPATCH: 'PRE_DISPATCH',

  // The "model returned no tool call" window inside the inner loop — quality and
  // delivery gates (verify, coherence, closure, kickoff, unknown-problem).
  EMPTY_TOOLCALLS: 'EMPTY_TOOLCALLS',

  // The per-tool-call governance chain inside toolCalling.executeTool — runs on
  // every single tool call (selfHeal, syscallGateway, metaConstraint, evo, dep).
  POST_TOOL_GOVERNANCE: 'POST_TOOL_GOVERNANCE',

  // The harness delivery-gate remediation loop.
  DELIVERY_GATE: 'DELIVERY_GATE',

  // The harness outer Ralph auto-continuation loop.
  OUTER_RALPH: 'OUTER_RALPH',
});

// Coarse phase floor per seam — the composer adds each descriptor's `phase`
// offset on top to get a stable global ordering that reproduces today's fixed
// physical order.
const SEAM_ORDER = Object.freeze({
  [SEAMS.PRE_DISPATCH]: 0,
  [SEAMS.EMPTY_TOOLCALLS]: 100,
  [SEAMS.POST_TOOL_GOVERNANCE]: 200,
  [SEAMS.DELIVERY_GATE]: 300,
  [SEAMS.OUTER_RALPH]: 400,
});

// Physical owner file for each seam — documentation only, surfaced in the route
// for observability so a reader knows where a capability physically fires.
const SEAM_OWNER = Object.freeze({
  [SEAMS.PRE_DISPATCH]: 'toolUseLoop.js',
  [SEAMS.EMPTY_TOOLCALLS]: 'toolUseLoop.js',
  [SEAMS.POST_TOOL_GOVERNANCE]: 'toolCalling.js',
  [SEAMS.DELIVERY_GATE]: 'agenticHarnessService.js',
  [SEAMS.OUTER_RALPH]: 'agenticHarnessService.js',
});

function isSeam(id) {
  return Object.prototype.hasOwnProperty.call(SEAM_ORDER, id);
}

module.exports = { SEAMS, SEAM_ORDER, SEAM_OWNER, isSeam };
