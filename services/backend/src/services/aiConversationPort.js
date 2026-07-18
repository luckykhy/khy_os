'use strict';

/**
 * aiConversationPort — neutral, zero-dependency IoC seam for the AI
 * conversation-state surface that queryEngine drives (DESIGN-ARCH-021, Batch 3
 * addendum: the session-orchestration edges deferred by aiSessionPort/aiChatPort).
 *
 * queryEngine is a service-layer orchestrator that previously reached UP into the
 * cli ai module for four conversation-state operations:
 *   - getEffort()            read the current effort preset for a chat call
 *   - saveConversation()     persist the live history to disk
 *   - loadLastConversation() restore the most recent saved history
 *   - clearHistory()         drop the live module-level history
 * The latter three mutate / read cli/ai's live conversation state, so this is a
 * genuine session-orchestration inversion, not a stateless model call (that one
 * lives in aiChatPort).
 *
 * The dependency is inverted: the cli layer self-registers these handlers on load
 * (legit cli → services direction), and queryEngine consumes via
 * `getAiConversation()`. When the CLI was never loaded (backend-server / headless
 * / unit test) the getter returns null, and each consumer degrades to a safe
 * no-op / null instead of pulling the entire CLI module graph into a non-CLI
 * process — strictly more correct than a lazy upward require.
 *
 * Kept separate from aiSessionPort (which carries `/status` `/config` `/new` UI
 * plumbing) and aiChatPort (the stateless model-call core) on purpose: this port
 * carries the persistent conversation-state surface. Pure leaf — no imports,
 * deterministic, offline.
 */

let _conv = null;

const _FNS = ['getEffort', 'saveConversation', 'loadLastConversation', 'clearHistory'];

/**
 * The cli layer registers `{ getEffort, saveConversation, loadLastConversation,
 * clearHistory }` here on load. Each member is normalized to a function or null;
 * a wholly invalid argument registers null.
 */
function registerAiConversation(conv) {
  if (!conv || typeof conv !== 'object') {
    _conv = null;
    return;
  }
  const normalized = {};
  for (const fn of _FNS) {
    normalized[fn] = typeof conv[fn] === 'function' ? conv[fn] : null;
  }
  _conv = normalized;
}

/**
 * Returns the registered conversation handlers, or null when the CLI was never
 * loaded. Consumers must null-check and degrade.
 */
function getAiConversation() {
  return _conv;
}

function _resetForTest() {
  _conv = null;
}

module.exports = {
  registerAiConversation,
  getAiConversation,
  _resetForTest,
};
