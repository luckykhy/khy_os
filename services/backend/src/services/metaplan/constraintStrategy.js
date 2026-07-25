'use strict';

/**
 * constraintStrategy.js — the three-level constraint strategy enum the model
 * self-selects per micro-action (目标11 §2 `constraint_strategy`).
 *
 * A monotone escalation ladder — Prompt_Soft ⊏ Code_Hard ⊏ System_Block — that
 * mirrors the spend of compute/Token against risk:
 *
 *   Prompt_Soft   低风险/纯创作。跳过 AST/沙箱，仅注入极简格式提示。最省 Token 与延迟。
 *   Code_Hard     高风险/逻辑变更。强制挂载执行器的代码拦截器（AST/Lint），校验不过打回。
 *   System_Block  极危/不可逆。系统级挂起，须先备份快照 + 确认才放行。
 *
 * The ladder is ORDERED so the trust circuit-breaker and the constitutional
 * red-line layer can only ever ESCALATE a model's choice, never relax it
 * (强制接管只能加锁，不能减锁). `escalate(a,b)` returns the stricter of two.
 *
 * Pure + side-effect free.
 */

const STRATEGIES = Object.freeze({
  PROMPT_SOFT: 'Prompt_Soft',
  CODE_HARD: 'Code_Hard',
  SYSTEM_BLOCK: 'System_Block',
});

// Strictness rank — higher = more locks mounted. Used to compare/escalate.
const RANK = Object.freeze({
  [STRATEGIES.PROMPT_SOFT]: 0,
  [STRATEGIES.CODE_HARD]: 1,
  [STRATEGIES.SYSTEM_BLOCK]: 2,
});

const ALL = Object.freeze([
  STRATEGIES.PROMPT_SOFT, STRATEGIES.CODE_HARD, STRATEGIES.SYSTEM_BLOCK,
]);

/** True iff `s` is one of the three legal strategy enum values. */
function isStrategy(s) {
  return Object.prototype.hasOwnProperty.call(RANK, s);
}

/** Strictness rank of a strategy (unknown → treated as the strictest, fail-safe). */
function rankOf(s) {
  return isStrategy(s) ? RANK[s] : RANK[STRATEGIES.SYSTEM_BLOCK];
}

/**
 * The stricter (higher-rank) of two strategies. Escalation is a least-upper-bound
 * on the ladder — combining any two constraints yields the more conservative one,
 * so every override layer (circuit-breaker, red line) can only tighten.
 * @returns {string}
 */
function escalate(a, b) {
  return rankOf(a) >= rankOf(b) ? _norm(a) : _norm(b);
}

/** True iff `actual` is at least as strict as `required`. */
function atLeast(actual, required) {
  return rankOf(actual) >= rankOf(required);
}

function _norm(s) {
  return isStrategy(s) ? s : STRATEGIES.SYSTEM_BLOCK;
}

module.exports = {
  STRATEGIES,
  RANK,
  ALL,
  isStrategy,
  rankOf,
  escalate,
  atLeast,
};
