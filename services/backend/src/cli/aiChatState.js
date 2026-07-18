'use strict';

/**
 * Shared chat session state (god-file split, Option C).
 *
 * The 12 module-level mutable bindings that ai.js (host) and aiChatCore.js both read AND reassign
 * are collected here as a single required-once singleton object. Because require() returns the cached
 * object, property reads/writes propagate across both modules — this is what lets the chat mega-construct
 * move into aiChatCore.js while the surrounding stateless helpers stay in ai.js. Initial values mirror the
 * original `let` declarations verbatim. NOT byte-identical (each `_messages` becomes `_chatState.messages`).
 */
module.exports = {
  gateway: null,
  messages: [],
  studyMode: false,
  gatewayPreflightDone: false,
  gatewayPreflightInFlight: null,
  pendingTaskGuard: null,
  lastSubstantivePrompt: '',
  lastSubstantiveAt: 0,
  primedSessionId: null,
  lastPrimeTopicTokens: null,
  currentEffort: 'medium',
  thinkingEnabled: true,
};
