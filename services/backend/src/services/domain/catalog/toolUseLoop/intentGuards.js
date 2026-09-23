'use strict';

/**
 * Intent-assurance / error-enumeration / follow-through guard resolution
 * extracted from runToolUseLoop (T-021 C3-P4 — reuses the mutation-free cluster
 * pattern proven by protocolContext.js / loopObservability.js).
 *
 * Owns, verbatim from the former loop body, the one-time (pre-loop) computation
 * of six READ-ONLY loop inputs derived from originalUserMessage + env:
 *   - KHY_INTENT_COVERAGE / KHY_INTENT_PATH_REDOS_GUARD gates
 *   - the intent frame (detailAnchors / tailDetails / summary) via
 *     buildIntentAssuranceDirective (fail-soft → empty frame → no-op recheck)
 *   - KHY_ERROR_ENUMERATION gate + extractErrorSignals(originalUserMessage)
 *   - isFollowThroughGuardEnabled(env)
 *
 * Pure resolution: reads inputs, never mutates loop state — the downstream loop
 * only reads these six values (the intent/error/follow-through nudges at the
 * turn tail). ZERO static requires: buildIntentAssuranceDirective is injected as
 * a lazy provider so ../khyUpgradeRuntime is required exactly when — and only
 * when — the coverage gate is on, byte-identical to the former inline lazy
 * require. extractErrorSignals / isFollowThroughGuardEnabled are already
 * module-level in the caller and are passed through, keeping this leaf off the
 * require-graph SCC. The caller destructures the returned bag back into the
 * original underscore names, so every downstream reference stays unchanged.
 */

function resolveIntentGuards(deps) {
  const {
    originalUserMessage,
    env,
    requireKhyUpgradeRuntime,
    extractErrorSignals,
    isFollowThroughGuardEnabled,
  } = deps;

  const intentCoverageEnabled = !['0', 'false', 'off', 'no'].includes(
    String(env.KHY_INTENT_COVERAGE || '')
      .trim()
      .toLowerCase()
  );
  // 有界路径正则(防灾难性回溯 DoS)默认开;仅 0/false/off/no 关闭走字节回退。
  const intentPathRedosGuard = !['0', 'false', 'off', 'no'].includes(
    String(env.KHY_INTENT_PATH_REDOS_GUARD || '')
      .trim()
      .toLowerCase()
  );
  let intentFrame = { detailAnchors: [], tailDetails: [], summary: '' };
  if (intentCoverageEnabled) {
    try {
      const { buildIntentAssuranceDirective } = requireKhyUpgradeRuntime();
      const _f = buildIntentAssuranceDirective(originalUserMessage, {});
      intentFrame = {
        detailAnchors: Array.isArray(_f && _f.detailAnchors) ? _f.detailAnchors : [],
        tailDetails: Array.isArray(_f && _f.tailDetails) ? _f.tailDetails : [],
        // Task summary (main goal): consumed by the question context fallback
        // (questionQuality.buildQuestionContextNote) so AskUserQuestion cards can
        // carry a deterministic one-line note of which task the question serves. fail-soft.
        summary: String((_f && _f.summary) || ''),
      };
    } catch {
      /* fail-soft：意图抽取失败 → 留空 frame，回核自然 no-op */
    }
  }

  const errorEnumEnabled = !['0', 'false', 'off', 'no'].includes(
    String(env.KHY_ERROR_ENUMERATION || '')
      .trim()
      .toLowerCase()
  );
  let errorSignals = [];
  if (errorEnumEnabled) {
    try {
      errorSignals = extractErrorSignals(originalUserMessage);
    } catch {
      errorSignals = [];
    }
  }

  let followThroughEnabled = false;
  try {
    followThroughEnabled = isFollowThroughGuardEnabled(env);
  } catch {
    followThroughEnabled = false;
  }

  return {
    intentCoverageEnabled,
    intentPathRedosGuard,
    intentFrame,
    errorEnumEnabled,
    errorSignals,
    followThroughEnabled,
  };
}

module.exports = { resolveIntentGuards };
