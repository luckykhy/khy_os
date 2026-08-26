'use strict';

/**
 * retryBudget.js — 纯叶子:「出错后自愈重试轮次」全局硬上界的单一真源。
 *
 * 背景(用户诉求「错误出现 khy 应该尝试 10 轮之内的有限重试」):本仓已有多条重试
 * 路径,但它们的轮次预算全部**只有下界、没有上界**:
 *   - services/retryWithBackoff.js  `Math.max(1, Math.floor(attempts))` —— 调用方
 *     或 env 传 999 就真转 999 轮。
 *   - services/retryWithBackoff.js  persistentRetry() 是 `while (true)`,只有 6h
 *     墙钟兜底,轮次完全不设限。
 *   - services/gateway/adapters/_retryWithBackoff.js  `maxAttempts = 3` 同样无上界。
 *   - utils/retry.js  `maxRetries = 3` 同样无上界。
 *   - cli/replSession.js  KHY_HARNESS_RETRY_ATTEMPTS 只 `Math.max(1, …)`。
 * 「无上界」的代价不是慢,而是**用户失去对失败时长的预期**:一条打不通的通道可以
 * 让一次请求悬在「自动恢复 37/999」上,而 khy 既不成功也不报错。
 *
 * 本叶子把「最多重试几轮」收敛成一个常量,所有重试入口一律经 clampRetryRounds()
 * 过闸。轮次的语义是「同一个操作被重复尝试的次数(含首次)」——注意它**不**包括
 * failover 广度(网关级联里换一条通道再试一次是故障转移,不是同一操作的重试),
 * 那部分预算由 aiGatewayGenerateMethod 的 maxTotalAttempts 单独约束。
 *
 * 为什么是硬常量而不是 env 门控:上界本身就是用户拍板的产品约束,可被 env 抬高的
 * 上界等于没有上界。想少试几轮的调用方直接传更小的 attempts —— clamp 只封顶,不抬升。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛、单一真源、无副作用。
 *
 * @module constants/retryBudget
 */

/** 同一操作最多被尝试的总轮次(含首次尝试)。 */
const MAX_RETRY_ROUNDS = 10;

/**
 * 把请求到的重试轮次收进 [1, MAX_RETRY_ROUNDS]。
 *
 * @param {*} requested - 调用方/env 给出的轮次,任意类型(字符串、NaN、负数都容忍)。
 * @param {number} [fallback=MAX_RETRY_ROUNDS] - requested 不是数字时的回退值,自身也受封顶。
 * @returns {number} [1, MAX_RETRY_ROUNDS] 内的整数。
 */
function clampRetryRounds(requested, fallback = MAX_RETRY_ROUNDS) {
  const fb = Math.min(MAX_RETRY_ROUNDS, Math.max(1, Math.floor(Number(fallback) || 1)));
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n)) {
    return fb; // 非数字(undefined / '' / 'abc' / NaN)才回退,数字一律就地收敛
  }
  return Math.min(MAX_RETRY_ROUNDS, Math.max(1, n));
}

module.exports = {
  MAX_RETRY_ROUNDS,
  clampRetryRounds,
};
