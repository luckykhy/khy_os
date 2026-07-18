'use strict';

/**
 * aiSessionPort — neutral, zero-dependency IoC seam for the AI session fallback
 * commands `/status` `/config` `/new` `/clear` (DESIGN-ARCH-021, Batch 3).
 *
 * Breaks the reverse layering edge
 *   services/toolCalling.js → cli/ai.js
 * for the SlashCommand fallback path that called `cli/ai.handleAiStatus()`,
 * `handleAiConfig()` and `clearHistory()`. This is session/UI plumbing, NOT the
 * `chat()` model-call core — the three `ai.chat(...)` reverse edges
 * (aiManagementServer / coordinator/workerAgent / tools/AgentTool) are deliberately
 * left in place as a separate, higher-risk effort (see the DESIGN-ARCH-021 addendum).
 *
 * cli/ai self-registers these handlers on load (legit cli → services direction).
 * The SlashCommand handler consumes via `getAiSession()`; when the CLI was never
 * loaded the getter returns null and the handler reports a structured
 * `{ reason: 'no_ai_session' }` instead of crashing. Pure leaf.
 */

let _session = null;

/** cli/ai registers `{ handleAiStatus, handleAiConfig, clearHistory }` here on load. */
function registerAiSession(session) {
  _session = session
    && typeof session.handleAiStatus === 'function'
    && typeof session.handleAiConfig === 'function'
    ? session
    : null;
}

/** Returns the registered session handlers, or null when the CLI was never loaded. */
function getAiSession() {
  return _session;
}

function _resetForTest() {
  _session = null;
}

module.exports = {
  registerAiSession,
  getAiSession,
  _resetForTest,
};
