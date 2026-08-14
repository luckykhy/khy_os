'use strict';

/**
 * llmGenerateSink.js — zero-dependency provider sink for best-effort LLM text
 * generation.
 *
 * Inverts the sessionTraceSummary -> gateway/aiGateway edge ([DESIGN-ARCH-051]
 * §6.9): aiGateway publishes its generate() here at load; best-effort callers
 * (e.g. opt-in session-trace LLM compression) pull the provider through this
 * leaf instead of importing the 6000-line gateway, which dragged them into the
 * giant dependency SCC. A missing provider yields null — the exact same outcome
 * the caller already produced when LLM compression was disabled or the gateway
 * was unavailable, so the best-effort contract is preserved.
 *
 * IMPORTANT: this leaf must stay dependency-free. It deliberately contains NO
 * module-loading call syntax anywhere (including in comments), because the
 * arch-debt scanner is comment-naive and would otherwise read a phantom edge
 * that pulls the leaf back into the cycle.
 */

let _provider = null;

function setLlmGenerateProvider(fn) {
  _provider = typeof fn === 'function' ? fn : null;
}

function getLlmGenerateProvider() {
  return _provider;
}

module.exports = { setLlmGenerateProvider, getLlmGenerateProvider };
