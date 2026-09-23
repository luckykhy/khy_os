'use strict';

/**
 * Pre-loop iteration/elapsed budget resolution extracted from runToolUseLoop
 * (T-021 C3-P6 — reuses the mutation-free cluster pattern proven by
 * protocolContext.js / intentGuards.js / monitorState.js).
 *
 * Owns, verbatim from the former loop body, the one-time (pre-loop) computation of
 * the loop-cap triple that every later budget gate reads:
 *   - effectiveMaxIterations  the outer while-loop turn ceiling (dynamic floor +
 *     intentGate outerBoost + transient recovery + harness boost, capped at 200
 *     unless the caller passed an explicit requestedMaxIterations)
 *   - maxElapsedMs            per-run elapsed/idle budget (reused as IDLE_TIMEOUT_MS)
 *   - transientRecoveryMax    bounded transient-retry allowance (separate ledger
 *     from urgent-steer reissues)
 *
 * The intermediate handles (_contextWindowForBudget, resolvedMaxIterations,
 * _loopBoost, hasExplicitMaxIterations, _dynamicMinSafe) are block-local and stay
 * private here; only the three values the caller reads downstream are returned.
 *
 * This leaf has ZERO static requires: the aiGateway / intentGate lazy requires the
 * former inline code did are kept in the caller and injected as thunks, so this
 * module never joins the require-graph SCC the R3 gate guards. The four core-local
 * resolver functions are injected too (they are defined in the core, not required).
 * The caller destructures the returned bag back into the original underscore-free
 * names, so every downstream reference stays unchanged.
 */

function resolveLoopBudgets(deps) {
  const {
    chatOpts,
    requestedMaxIterations,
    originalUserMessage,
    options,
    gatedInput,
    harnessProfile,
    resolveMaxIterations,
    resolveTransientRecoveryMax,
    resolveMinSafeIterations,
    resolveMaxElapsedMs,
    requireGateway,
    requireIntentGate,
  } = deps;

  // 从 chatOpts 提取上下文窗口，用于动态计算迭代预算下限。
  // 如果调用方未传入，尝试从 aiGateway 同步获取（缓存命中）。
  let _contextWindowForBudget = Number(chatOpts?.contextWindowTokens) || 0;
  if (_contextWindowForBudget <= 0 && chatOpts?.preferredModel) {
    try {
      const _gw = requireGateway();
      if (typeof _gw.getModelContextWindow === 'function') {
        _contextWindowForBudget = _gw.getModelContextWindow(chatOpts.preferredModel) || 0;
      }
    } catch {
      /* fail-soft: 保持 0 → 使用回退 */
    }
  }
  const resolvedMaxIterations = resolveMaxIterations(
    requestedMaxIterations,
    _contextWindowForBudget
  );
  const transientRecoveryMax = resolveTransientRecoveryMax(originalUserMessage, options);
  // Apply intentGate outerBoost: coding +18, ultrawork +12, analyze +6
  const { getLoopLimitBoost } = requireIntentGate();
  const _loopBoost = getLoopLimitBoost(gatedInput.activatedModes || []);
  const hasExplicitMaxIterations =
    requestedMaxIterations !== undefined && requestedMaxIterations !== null;
  const _dynamicMinSafe = resolveMinSafeIterations(_contextWindowForBudget);
  const effectiveMaxIterations = Math.max(
    _dynamicMinSafe,
    hasExplicitMaxIterations
      ? resolvedMaxIterations
      : Math.min(
          200,
          resolvedMaxIterations +
            _loopBoost.outerBoost +
            transientRecoveryMax +
            (harnessProfile.maxIterationsBoost || 0)
        )
  );
  const maxElapsedMs = resolveMaxElapsedMs();

  return { effectiveMaxIterations, maxElapsedMs, transientRecoveryMax };
}

module.exports = { resolveLoopBudgets };
