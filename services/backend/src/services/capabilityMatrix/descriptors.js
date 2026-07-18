'use strict';

/**
 * descriptors.js — the single source of truth for the agent capability matrix.
 *
 * Each of the agent's capabilities is declared ONCE here as a data descriptor.
 * This is the file a human edits to add, retune, or audit a capability; it
 * carries NO logic. The matrix (./index.js) resolves these at runtime; the
 * composer (./composer.js) orders and filters them into an inspectable route.
 *
 * ── Byte-identity contract (cut 1) ──
 * Descriptors with `wired: true` are consulted at their physical seam in place
 * of the old inline `process.env.KHY_*` check. For these, `flag.kind` + relevant
 * fields MUST reproduce the EXACT boolean the inline expression yields for every
 * env value (verified against toolUseLoop.js / toolCalling.js). `preconditions`
 * is a pure function of `ctx`; for wired entries it must be a SUBSET of the
 * surrounding inline guards (i.e. guaranteed true wherever the flag check is
 * reached) so swapping the flag term for `isEnabledAt()` changes nothing.
 *
 * Descriptors with `wired: false` are catalog-only: they enrich the matrix and
 * the observable route but are NOT consulted at any seam in cut 1 (the capability
 * keeps its own existing gating). Their flag specs are best-effort informational.
 *
 * `requires` uses the gateway capability dimensions (see services/gateway/
 * capabilityRegistry.js CAPABILITIES) so a weak-tier model can legitimately shed
 * capabilities in cut 2. In cut 1 the capability vector defaults to all-max, so
 * `requires` is inert.
 *
 * `invoke` is a REFERENCE (module path + export), never the facade itself —
 * keeps this file data-only and avoids eager require() of all subsystems.
 */

const { SEAMS } = require('./seams');

// Common preconditions, named for reuse and readability.
const PRE = {
  always: () => true,
  emptyToolCalls: (ctx) => ctx.toolCallsLen === 0,
  firstTurnEmptyNoSub: (ctx) =>
    ctx.iteration === 1 && ctx.toolCallsLen === 0 && !ctx.isSubagent,
  notSubagent: (ctx) => !ctx.isSubagent,
};

const DESCRIPTORS = Object.freeze([
  // ───────────────────────── PRE_DISPATCH ─────────────────────────
  {
    id: 'proactiveCollab',
    label: 'Proactive collaboration (decompose + delegate)',
    seam: SEAMS.PRE_DISPATCH,
    phase: 10,
    owner: 'toolUseLoop.js',
    wired: true,
    flag: { env: 'KHY_PROACTIVE_COLLAB', kind: 'envFlagDefault', default: true },
    preconditions: PRE.firstTurnEmptyNoSub,
    requires: { tool_use: 3 },
    cost: 3, risk: 1, isReversible: true,
    subagentSuppressed: true,
    invoke: { module: './proactiveCollaboration', export: 'proposeCollaboration' },
    designDoc: 'DESIGN-ARCH-031',
  },
  {
    id: 'structuredFurnace',
    label: 'Structured intent furnace (seal chaotic input)',
    seam: SEAMS.PRE_DISPATCH,
    phase: 20,
    owner: 'toolUseLoop.js',
    wired: true,
    flag: { env: 'KHY_STRUCTURED_FURNACE', kind: 'zeroDisables' },
    preconditions: PRE.always,
    requires: {},
    cost: 1, risk: 0, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './structuredFurnace', export: 'intercept' },
    designDoc: 'DESIGN-ARCH-055',
  },

  // ──────────────────────── EMPTY_TOOLCALLS ────────────────────────
  {
    id: 'unknownProblem',
    label: 'Unknown-problem state machine',
    seam: SEAMS.EMPTY_TOOLCALLS,
    phase: 10,
    owner: 'toolUseLoop.js',
    wired: true,
    flag: { env: 'KHY_UNKNOWN_PROBLEM_HANDLER', kind: 'module' },
    isEnabledFn: () => {
      try { return require('../unknownProblemHandler').isEnabled(); } catch { return false; }
    },
    preconditions: PRE.always,
    requires: {},
    cost: 1, risk: 0, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './unknownProblemHandler', export: 'isEnabled' },
    designDoc: 'DESIGN-ARCH-050',
  },
  {
    id: 'verifyGate',
    label: 'Post-edit verification gate',
    seam: SEAMS.EMPTY_TOOLCALLS,
    phase: 30,
    owner: 'toolUseLoop.js',
    wired: true,
    flag: { env: 'KHY_VERIFY_GATE', kind: 'envFlagDefault', default: true },
    preconditions: PRE.emptyToolCalls,
    requires: { tool_use: 3 },
    cost: 2, risk: 1, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './verificationAgent', export: 'adversarialVerifyEnsemble' },
    designDoc: 'DESIGN-ARCH-003',
  },
  {
    id: 'verifyNonEdit',
    label: 'Non-edit evidence self-check',
    seam: SEAMS.EMPTY_TOOLCALLS,
    phase: 35,
    owner: 'toolUseLoop.js',
    wired: true,
    flag: { env: 'KHY_VERIFY_NONEDIT', kind: 'envFlagDefault', default: true },
    preconditions: PRE.emptyToolCalls,
    requires: {},
    cost: 2, risk: 0, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './verificationAgent', export: 'evidenceSufficiencyEnsemble' },
    designDoc: 'DESIGN-ARCH-003',
  },
  {
    id: 'projectCoherence',
    label: 'Project coherence gate (import graph)',
    seam: SEAMS.EMPTY_TOOLCALLS,
    phase: 40,
    owner: 'toolUseLoop.js',
    wired: true,
    flag: { env: 'KHY_PROJECT_COHERENCE', kind: 'envFlagDefault', default: true },
    preconditions: PRE.emptyToolCalls,
    requires: {},
    cost: 2, risk: 0, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './projectCoherence', export: 'evaluateCoherenceGate' },
    designDoc: 'DESIGN-ARCH-003',
  },
  {
    id: 'deliverableClosure',
    label: 'Deliverable closure gate',
    seam: SEAMS.EMPTY_TOOLCALLS,
    phase: 50,
    owner: 'toolUseLoop.js',
    wired: true,
    flag: { env: 'KHY_DELIVERABLE_CLOSURE', kind: 'envFlagDefault', default: true },
    preconditions: PRE.always,
    requires: {},
    cost: 1, risk: 0, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './projectCoherence', export: 'evaluateClosure' },
    designDoc: 'DESIGN-ARCH-003',
  },
  {
    id: 'selfKickoff',
    label: 'Self-kickoff (break placeholder stall)',
    seam: SEAMS.EMPTY_TOOLCALLS,
    phase: 60,
    owner: 'toolUseLoop.js',
    wired: true,
    flag: { env: 'KHY_SELF_KICKOFF', kind: 'envFlagDefault', default: true },
    // BYTE-IDENTITY: the inline selfKickoff guard does NOT include a !_isSubagent
    // term (unlike proactiveCollab/auditFix), so the wired precondition MUST be
    // PRE.always — it merely injects a continuation message, never spawns a
    // subagent, so it is not a recursion risk and runs in subagents today. Adding
    // a notSubagent gate here would be a behavior change; defer that to cut 2.
    preconditions: PRE.always,
    requires: {},
    cost: 1, risk: 1, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './toolUseLoop', export: null }, // inline seam, no external facade
    designDoc: 'DESIGN-ARCH-003',
  },

  // ─────────────────────── POST_TOOL_GOVERNANCE ───────────────────────
  {
    id: 'selfHeal',
    label: 'Self-heal failing tool (micro-loop)',
    seam: SEAMS.POST_TOOL_GOVERNANCE,
    phase: 10,
    owner: 'toolCalling.js',
    wired: true,
    flag: { env: 'KHY_SELF_HEAL', kind: 'offDisables' },
    preconditions: PRE.always,
    requires: {},
    cost: 2, risk: 1, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './selfHeal', export: 'FallbackTreeWithHeal' },
    designDoc: 'DESIGN-ARCH-003',
  },
  {
    id: 'syscallGateway',
    label: 'Syscall approval gateway',
    seam: SEAMS.POST_TOOL_GOVERNANCE,
    phase: 20,
    owner: 'toolCalling.js',
    wired: true,
    flag: { env: 'KHY_SYSCALL_GATEWAY', kind: 'offDisables' },
    preconditions: PRE.always,
    requires: {},
    cost: 1, risk: 0, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './syscallGateway', export: 'evaluate' },
    designDoc: 'DESIGN-ARCH-003',
  },
  {
    id: 'metaConstraint',
    label: 'Meta-constraint capability solver',
    seam: SEAMS.POST_TOOL_GOVERNANCE,
    phase: 30,
    owner: 'toolCalling.js',
    wired: true,
    flag: { env: 'KHY_METACONSTRAINT', kind: 'offDisables' },
    preconditions: PRE.always,
    requires: {},
    cost: 1, risk: 0, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './metaConstraint/toolFunnelGuard', export: 'enforce' },
    designDoc: 'DESIGN-ARCH-003',
  },
  {
    id: 'evoEngine',
    label: 'Evolution friction observer',
    seam: SEAMS.POST_TOOL_GOVERNANCE,
    phase: 40,
    owner: 'toolCalling.js',
    wired: true,
    flag: { env: 'KHY_EVO_ENGINE', kind: 'offDisables' },
    preconditions: PRE.always,
    requires: {},
    cost: 0, risk: 0, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './evoEngine/frictionBridge', export: 'observeFailure' },
    designDoc: 'DESIGN-ARCH-055',
  },
  {
    id: 'depHealing',
    label: 'Dependency self-healing',
    seam: SEAMS.POST_TOOL_GOVERNANCE,
    phase: 50,
    owner: 'toolCalling.js',
    wired: true,
    flag: { env: 'KHY_DEP_HEALING', kind: 'offDisables' },
    preconditions: PRE.always,
    requires: {},
    cost: 2, risk: 2, isReversible: false,
    subagentSuppressed: false,
    invoke: { module: './dependency/healingLoop', export: null },
    designDoc: 'DESIGN-ARCH-048',
  },

  // ───────────────── catalog-only (not consulted at seams in cut 1) ─────────────────
  {
    id: 'ralphLoop',
    label: 'Ralph auto-continuation loop',
    seam: SEAMS.OUTER_RALPH,
    phase: 10,
    owner: 'agenticHarnessService.js',
    wired: false,
    flag: { env: 'KHY_RALPH_LOOP', kind: 'envFlagDefault', default: true },
    preconditions: PRE.always,
    requires: {},
    cost: 5, risk: 1, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './agenticHarnessService', export: null },
    designDoc: 'DESIGN-ARCH-003',
  },
  {
    id: 'deliveryGate',
    label: 'Delivery gate remediation',
    seam: SEAMS.DELIVERY_GATE,
    phase: 10,
    owner: 'agenticHarnessService.js',
    wired: false,
    flag: { env: 'KHY_DELIVERY_GATE', kind: 'envFlagDefault', default: true },
    preconditions: PRE.always,
    requires: {},
    cost: 4, risk: 1, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './deliveryGate', export: null },
    designDoc: 'DESIGN-ARCH-003',
  },
  {
    id: 'auditFix',
    label: 'Audit + fix sub-agent loop',
    seam: SEAMS.EMPTY_TOOLCALLS,
    phase: 70,
    owner: 'toolUseLoop.js',
    wired: false, // gated by auditFixLoop.triggerGate.shouldAudit, not a flat flag
    flag: { env: 'KHY_AUDIT_FIX', kind: 'envFlagDefault', default: true },
    preconditions: PRE.notSubagent,
    requires: { tool_use: 3 },
    cost: 4, risk: 1, isReversible: true,
    subagentSuppressed: true,
    invoke: { module: './auditFixLoop', export: null },
    designDoc: 'DESIGN-ARCH-AUDIT',
  },
  {
    id: 'cognitiveSnapshot',
    label: 'Cognitive snapshot (context offload)',
    seam: SEAMS.PRE_DISPATCH,
    phase: 5,
    owner: 'toolUseLoop.js',
    wired: false,
    flag: { env: 'KHY_COGNITIVE_SNAPSHOT', kind: 'onEnables' },
    preconditions: PRE.always,
    requires: { long_context: 3 },
    cost: 2, risk: 0, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './cognitiveSnapshot', export: 'CognitiveContextEngine' },
    designDoc: 'DESIGN-ARCH-058',
  },
  {
    id: 'contextScope',
    label: 'Context scope planner',
    seam: SEAMS.PRE_DISPATCH,
    phase: 3,
    owner: 'agenticHarnessService.js',
    wired: false,
    flag: { env: 'KHY_CONTEXT_SCOPE', kind: 'onEnables' },
    preconditions: PRE.always,
    requires: {},
    cost: 2, risk: 0, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './contextScope', export: 'planScope' },
    designDoc: 'DESIGN-ARCH-003',
  },
  {
    id: 'unifiedSearch',
    label: 'Unified cross-source search',
    seam: SEAMS.PRE_DISPATCH,
    phase: 15,
    owner: 'localBrainService.js',
    wired: false,
    flag: { env: 'KHY_UNIFIED_SEARCH', kind: 'envFlagDefault', default: true },
    preconditions: PRE.always,
    requires: {},
    cost: 3, risk: 0, isReversible: true,
    subagentSuppressed: false,
    invoke: { module: './search/unifiedSearch', export: null },
    designDoc: 'DESIGN-ARCH-CROSS-SRC',
  },
]);

module.exports = { DESCRIPTORS, PRE };
