'use strict';

/**
 * aiChatPort — neutral, zero-dependency IoC seam for the `chat()` model-call core
 * (DESIGN-ARCH-021, Batch 3 addendum: the higher-risk chat edges deferred by
 * aiSessionPort).
 *
 * Breaks the reverse layering edges where ultraplanService and the workflow
 * executor reached up into the cli ai-chat core as a fallback. The dependency is
 * inverted: cli/ai self-registers its `chat` here on load (legit cli → services
 * direction), and these services consume via `getAiChat()`.
 *
 * Contract: when the CLI was never loaded (backend-server / headless / unit test)
 * the getter returns null, and the consumer reports a structured failure instead
 * of pulling the entire CLI module graph into a non-CLI process. This is strictly
 * more correct than the previous lazy import of the cli ai module, which would
 * load the full TUI-coupled CLI just to reach `chat`. Both consumers already
 * prefer the service-layer AI gateway / injected primitives; this is the fallback.
 *
 * Kept separate from aiSessionPort on purpose: that port carries session/UI
 * plumbing (`/status` `/config` `/new`), this one carries the model-call core.
 * Pure leaf — no imports, deterministic, offline.
 *
 * ── Extended: CLI session-control operations (messaging channel de-coupling) ──
 * The ilink messaging channel (services/domain/messaging/channels/ilinkDispatcher)
 * reached up into cli/ai and cli/aiConversationOps at four more call sites for
 * operations that are NOT the model-call core: clearing history, cancelling an
 * in-flight request, scoping the live session to a peer, and triggering the
 * auto-checkpoint hook. Those are the same class of reverse-layering edge this
 * port exists to break, so they ride the same seam instead of a private port.
 *
 * Same contract, same rationale: cli/ai registers them on load; a non-CLI process
 * (backend server / headless daemon / unit test) gets null and the caller keeps its
 * existing fail-soft behaviour. Registration is all-or-nothing per operation so a
 * partially-loaded CLI can never hand back a half-wired surface.
 */

let _chat = null;
let _clearHistory = null;
let _cancelActiveRequest = null;
let _scopeSession = null;
let _maybeAutoCheckpointProgress = null;

/** cli/ai registers its `chat(prompt, opts)` here on load. Non-function → null. */
function registerAiChat(chat) {
  _chat = typeof chat === 'function' ? chat : null;
}

/** Returns the registered chat function, or null when the CLI was never loaded. */
function getAiChat() {
  return _chat;
}

/**
 * cli/ai registers the CLI session-control surface here on load. Each operation is
 * independently nullable; a non-function is coerced to null so callers can rely on
 * `typeof ... === 'function'` as the single availability check.
 *
 * @param {object} ops
 * @param {Function} [ops.clearHistory]              cli/aiConversationOps.clearHistory
 * @param {Function} [ops.cancelActiveRequest]       cli/ai.cancelActiveRequest(reason)
 * @param {Function} [ops.scopeSession]              cli/ai.scopeSession(scope, sessionId)
 * @param {Function} [ops.maybeAutoCheckpointProgress] cli/ai.maybeAutoCheckpointProgress(msg)
 */
function registerAiSessionControl(ops = {}) {
  const pick = (v) => (typeof v === 'function' ? v : null);
  _clearHistory = pick(ops.clearHistory);
  _cancelActiveRequest = pick(ops.cancelActiveRequest);
  _scopeSession = pick(ops.scopeSession);
  _maybeAutoCheckpointProgress = pick(ops.maybeAutoCheckpointProgress);
}

/** Each getter returns the registered function, or null when the CLI never loaded. */
function getClearHistory() {
  return _clearHistory;
}

function getCancelActiveRequest() {
  return _cancelActiveRequest;
}

function getScopeSession() {
  return _scopeSession;
}

function getMaybeAutoCheckpointProgress() {
  return _maybeAutoCheckpointProgress;
}

function _resetForTest() {
  _chat = null;
  _clearHistory = null;
  _cancelActiveRequest = null;
  _scopeSession = null;
  _maybeAutoCheckpointProgress = null;
}

module.exports = {
  registerAiChat,
  getAiChat,
  registerAiSessionControl,
  getClearHistory,
  getCancelActiveRequest,
  getScopeSession,
  getMaybeAutoCheckpointProgress,
  _resetForTest,
};
