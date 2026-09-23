'use strict';

/**
 * loop/iterations.js — numeric iteration / elapsed-budget resolvers, carved out of
 * toolUseLoopCore.js (T-021 god-file split, pure-leaf slice).
 *
 *   - _parsePositiveInt          invalid/low → fallback, else clamp to [min,max]
 *   - _clampInt                  invalid → fallback, valid-but-out-of-range → clamp (leaf-private)
 *   - _resolveMinSafeIterations  context-window-adaptive floor (5..15, fallback 8)
 *   - _resolveMaxIterations      requested/env → clamp [minSafe,100] → 20x-mode scale
 *   - _resolveMaxElapsedMs       env KHY_TOOL_LOOP_MAX_MS → fallback → adaptive multiplier
 *
 * The two scalar defaults (MAX_ITERATIONS, MAX_ELAPSED_MS_DEFAULT) live here now: they
 * were consumed ONLY by these resolvers. The core re-requires the four names it still
 * references (_parsePositiveInt has in-body callers; the three resolvers feed the
 * setToolUseLoopHelpersDeps / resolveLoopBudgets DI + tail exports) and re-exports
 * MAX_ITERATIONS / MAX_ELAPSED_MS_DEFAULT so the public surface is byte-identical.
 * Pure leaf: only LAZY requires, re-based for this dir — NO core back-edge (M6 cycles 0).
 */

const MAX_ITERATIONS = 100;
const MAX_ELAPSED_MS_DEFAULT = 600000;

function _parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(max, n);
}

// 最小安全迭代数（动态）：根据模型上下文窗口自适应计算。
// 小上下文(32K)→5轮(空间紧张，必须高效)，大上下文(200K+)→12轮(有余量)。
// 未获取到上下文时回退静态默认 8。
const MIN_SAFE_ITERATIONS_FALLBACK = 8;

function _resolveMinSafeIterations(contextWindowTokens) {
  if (!contextWindowTokens || contextWindowTokens <= 0) {
    return MIN_SAFE_ITERATIONS_FALLBACK;
  }
  // 每轮工具结果约占上下文 5%，最多可用 60% 给工具轮次，留 40% 给系统提示+模型输出。
  // 最小轮次 = floor(60% / 5%) = 12，但小上下文需要更紧凑。
  // 公式：clamp(上下文token / 20000, 5, 15)
  return Math.max(5, Math.min(15, Math.floor(contextWindowTokens / 20000)));
}

/**
 * 将数值 clamp 到 [min, max] 范围（不回退 fallback）。
 * 与 _parsePositiveInt 的区别：无效值 → fallback，有效但越界 → clamp。
 */
function _clampInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, n));
}

function _resolveMaxIterations(requestedMaxIterations, contextWindowTokens) {
  const minSafe = _resolveMinSafeIterations(contextWindowTokens);
  // 显式传入 → clamp 到安全范围（不回退 fallback）
  // 环境变量/未设 → 同语义:无效值回退默认;有效值 clamp 到 [minSafe, 100]。
  // 此前 env 路径用 _parsePositiveInt,其「低于 min 即回退默认」分支把用户想调低上限的
  // 低值(如 3)静默反转成最高上限 100 —— 与显式传入路径的 clamp 语义分叉,语义反转。
  const raw =
    requestedMaxIterations !== undefined && requestedMaxIterations !== null
      ? requestedMaxIterations
      : process.env.KHY_TOOL_LOOP_MAX_ITERATIONS !== undefined && process.env.KHY_TOOL_LOOP_MAX_ITERATIONS !== ''
        ? process.env.KHY_TOOL_LOOP_MAX_ITERATIONS
        : null;
  const base = raw === null ? MAX_ITERATIONS : _clampInt(raw, MAX_ITERATIONS, minSafe, 100);
  // 20 倍模式:开则把工具循环迭代上限顶到硬顶(不低于 base、封顶 100)。关 → 逐字节回退 base。
  try {
    const { scaleIterations } = require('../../twentyXMode');
    return scaleIterations(base);
  } catch {
    return base;
  }
}

function _resolveMaxElapsedMs() {
  const base = _parsePositiveInt(
    process.env.KHY_TOOL_LOOP_MAX_MS,
    MAX_ELAPSED_MS_DEFAULT,
    5000,
    30 * 60 * 1000
  );
  // Apply global timeout multiplier
  try {
    const { applyMultiplier } = require('../../adaptiveOutput');
    return applyMultiplier(base);
  } catch {
    return base;
  }
}

module.exports = {
  MAX_ITERATIONS,
  MAX_ELAPSED_MS_DEFAULT,
  _parsePositiveInt,
  _resolveMinSafeIterations,
  _resolveMaxIterations,
  _resolveMaxElapsedMs,
};
