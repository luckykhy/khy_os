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
 */

let _chat = null;

/** cli/ai registers its `chat(prompt, opts)` here on load. Non-function → null. */
function registerAiChat(chat) {
  _chat = typeof chat === 'function' ? chat : null;
}

/** Returns the registered chat function, or null when the CLI was never loaded. */
function getAiChat() {
  return _chat;
}

function _resetForTest() {
  _chat = null;
}

module.exports = {
  registerAiChat,
  getAiChat,
  _resetForTest,
};
