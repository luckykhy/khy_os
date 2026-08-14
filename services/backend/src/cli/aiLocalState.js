/**
 * aiLocalState.js — Shared mutable state singleton for ai.js-local bindings.
 *
 * Mirrors the aiChatState.js pattern: a require()-cached plain object whose
 * properties are mutated in-place by the ai.js family of modules (ai.js,
 * aiGatewayClient.js, aiSession.js, aiConversationOps.js). Because Node
 * returns the same cached export, reads and writes propagate across all
 * requirers without setter injection.
 *
 * @module cli/aiLocalState
 */
'use strict';

module.exports = {
  service: null,
  traceAudit: null,
  chatLatencyAutoTuner: null,
  localWarmupAttemptedAdapters: new Set(),
  localWarmupInFlight: new Map(),
  liveSessionId: null,
  activeGatewayRequestSeq: 0,
  activeGatewayRequests: new Map(),
  localAiAutoEnvCache: null,
  lastAutoCheckpointSig: '',
};
