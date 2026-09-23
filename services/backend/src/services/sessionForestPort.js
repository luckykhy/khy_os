'use strict';

/**
 * sessionForestPort — neutral, zero-dependency IoC seam for the session-forest
 * primitives that currently live in the cli layer.
 *
 * The session-forest service (services/domain/session/session/sessionForestService)
 * needs four things from cli/: the forest topology builder (sessionTopology), the
 * slot store (sessionSlots), the cross-branch synthesis planner
 * (crossBranchSynthesis), and the live-session id getter (cli/ai). Reaching up into
 * cli/ for them was a reverse-layering edge (archDebtScan R1).
 *
 * The dependency is inverted the same way aiChatPort does it: cli/ai self-registers
 * this surface on load (legit cli → services direction), and the forest service
 * consumes via the getters below. This is strictly better than the previous
 * lazy `require('cli/...')` at each call site: a non-CLI process (backend server /
 * unit test) gets null and the forest service keeps its existing fail-soft paths,
 * instead of pulling the whole TUI-coupled cli graph just to read a slot.
 *
 * Contract:
 *   - Pure leaf — no imports, deterministic, offline.
 *   - Every entry is independently nullable; a non-function/non-object is coerced
 *     to null so callers can use a single `if (!x) return fallback` check.
 *   - Registration is all-or-nothing per key: a partially-loaded cli can never hand
 *     back a half-wired surface.
 *
 * NOTE: these three modules (topology / slots / cross-branch synthesis) are pure
 * data operations with no CLI coupling of their own — they arguably belong in the
 * service layer. Moving them is a separate, larger change; this port decouples the
 * dependency direction without moving files, so the R1 edge is gone either way.
 */

const _surface = {
  topology: null,   // { topologyEnabled, buildForest, buildHereLine }
  slots: null,      // { slotsEnabled, applyInsightOnce, writeSlot }
  synthesis: null,  // { synthesisEnabled, applySynthesis, planSynthesis }
  session: null,    // { getLiveSessionId }
};

const _pick = (v) => (typeof v === 'function' ? v : null);
const _pickObj = (v) => (v && typeof v === 'object' ? v : null);

/**
 * cli/ai registers the forest surface here on load.
 *
 * @param {object} [ops]
 * @param {object} [ops.topology]   sessionTopology exports
 * @param {object} [ops.slots]      sessionSlots exports
 * @param {object} [ops.synthesis]  crossBranchSynthesis exports
 * @param {object} [ops.session]    { getLiveSessionId }
 */
function registerSessionForest(ops = {}) {
  _surface.topology = _pickObj(ops.topology);
  _surface.slots = _pickObj(ops.slots);
  _surface.synthesis = _pickObj(ops.synthesis);
  _surface.session = _pickObj(ops.session);
}

/** Forest topology builder, or null when the CLI was never loaded. */
function getTopology() {
  return _surface.topology;
}

/** Slot store, or null when the CLI was never loaded. */
function getSlots() {
  return _surface.slots;
}

/** Cross-branch synthesis planner, or null when the CLI was never loaded. */
function getSynthesis() {
  return _surface.synthesis;
}

/** getLiveSessionId(), or null when the CLI was never loaded. */
function getGetLiveSessionId() {
  const s = _surface.session;
  return s ? _pick(s.getLiveSessionId) : null;
}

function _resetForTest() {
  _surface.topology = null;
  _surface.slots = null;
  _surface.synthesis = null;
  _surface.session = null;
}

module.exports = {
  registerSessionForest,
  getTopology,
  getSlots,
  getSynthesis,
  getGetLiveSessionId,
  _resetForTest,
};
