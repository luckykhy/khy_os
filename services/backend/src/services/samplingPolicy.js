'use strict';

/**
 * samplingPolicy.js — zero-dependency leaf holding the deterministic sampling
 * policy (creative-request heuristic + temperature/top-p locks).
 *
 * Extracted verbatim from khyUpgradeRuntime so that gateway adapters
 * (ollamaAdapter / localLLMAdapter) can borrow these pure functions without
 * importing the 1900-line upgrade runtime — which dragged them into the giant
 * dependency SCC ([DESIGN-ARCH-051] §6.8). Pure, stateless, no I/O.
 *
 * IMPORTANT: this leaf must stay dependency-free. It deliberately contains NO
 * module-loading call syntax anywhere (including in comments), because the
 * arch-debt scanner is comment-naive and would otherwise read a phantom edge
 * that pulls the leaf back into the cycle.
 */

function isCreativeRequest(text) {
  const s = String(text || '').toLowerCase();
  return /(创意|创作|文案|诗|故事|脑暴|creative|brainstorm|slogan|小说|散文|歌词|剧本)/i.test(s);
}

function lockTemperature(userMessage) {
  return isCreativeRequest(userMessage) ? 0.3 : 0.1;
}

function lockTopP() {
  return 0.85;
}

module.exports = { isCreativeRequest, lockTemperature, lockTopP };
