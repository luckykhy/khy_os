'use strict';

/**
 * constraintInjection.js — the dynamic constraint injection engine (目标11 §3:
 * "按需配发锁具，绝不提前加锁"). Given a normalized meta-plan it resolves exactly
 * which locks to mount, so compute/Token are spent in proportion to risk:
 *
 *   Prompt_Soft  → skip AST/sandbox entirely; inject only a tiny format hint.
 *                  (极速执行，省 Token 与延迟)
 *   Code_Hard    → mount the code interceptor(s) for the chosen executors; run
 *                  them on candidate content and REJECT on any syntax failure.
 *   System_Block → suspend; demand a backup snapshot + explicit confirmation
 *                  before the action may proceed.
 *
 * The engine is split in two so it stays pure where it can:
 *   - `resolveInjection(plan)`  → a declarative description of what to mount
 *                                 (no I/O; what the orchestrator reasons about).
 *   - `runHardValidation(plan, content, ctx)` → actually executes the mounted
 *                                 interceptors against candidate content.
 *
 * It mounts nothing for Soft (the whole point: low-risk ops are never dragged
 * through heavy validation).
 */

const strategy = require('./constraintStrategy');
const registry = require('./executorRegistry');
const interceptors = require('./codeInterceptors');

// A minimal, fixed format hint for the Soft fast-path — kept tiny on purpose so
// the prompt tax is near-zero (the goal's "仅注入极少量的格式提示").
const SOFT_FORMAT_HINT = '仅输出修改后的内容本身，保持原有缩进与编码，不要附加解释。';

/**
 * Resolve the injection plan for a normalized meta-plan WITHOUT running anything.
 * @param {object} normalized  from metaPlanSchema.validateMetaPlan(...).normalized
 * @returns {{
 *   strategy:string,
 *   mountInterceptors:boolean,
 *   requireSnapshot:boolean,
 *   requireConfirmation:boolean,
 *   promptHint:string,
 *   validators:Array<{executor:string, validator:(string|null), astSafetyNet:boolean}>,
 *   note:string
 * }}
 */
function resolveInjection(normalized) {
  const strat = normalized && normalized.constraint_strategy;
  const toolchain = (normalized && normalized.toolchain) || [];
  const validators = toolchain.map((id) => {
    const e = registry.getExecutor(id);
    return {
      executor: id,
      validator: e ? e.validator : null,
      astSafetyNet: !!(e && e.astSafetyNet),
    };
  });

  if (strat === strategy.STRATEGIES.PROMPT_SOFT) {
    return {
      strategy: strat,
      mountInterceptors: false,         // 绝不提前加锁：Soft 跳过一切重校验
      requireSnapshot: false,
      requireConfirmation: false,
      promptHint: SOFT_FORMAT_HINT,
      validators: [],
      note: 'Prompt_Soft：跳过 AST/沙箱，仅注入极简格式提示，极速执行。',
    };
  }

  if (strat === strategy.STRATEGIES.SYSTEM_BLOCK) {
    return {
      strategy: strat,
      mountInterceptors: true,          // Block 同时保留代码校验，双保险
      requireSnapshot: true,            // 必须先备份快照
      requireConfirmation: true,        // 必须系统级确认
      promptHint: '',
      validators,
      note: 'System_Block：系统级挂起，须先备份快照 + 确认才放行；并仍挂载代码校验。',
    };
  }

  // Code_Hard (and the fail-safe default for anything unexpected).
  return {
    strategy: strategy.STRATEGIES.CODE_HARD,
    mountInterceptors: true,
    requireSnapshot: false,
    requireConfirmation: false,
    promptHint: '',
    validators,
    note: 'Code_Hard：挂载执行器代码拦截器（AST/语法校验），校验不过坚决打回。',
  };
}

/**
 * Run the mounted code interceptors against candidate content (Code_Hard /
 * System_Block only). Soft returns an immediate pass (nothing mounted).
 *
 * @param {object} normalized  the normalized meta-plan
 * @param {string} content     candidate file content to be written
 * @param {object} [ctx]       { language }
 * @returns {{
 *   passed:boolean,
 *   strategy:string,
 *   ranValidation:boolean,
 *   results:Array<{executor:string, validator:string, ok:boolean, error?:string}>,
 *   violations:Array<{executor:string, error:string}>,
 *   requireSnapshot:boolean,
 *   requireConfirmation:boolean
 * }}
 */
function runHardValidation(normalized, content, ctx = {}) {
  const injection = resolveInjection(normalized);

  if (!injection.mountInterceptors) {
    return {
      passed: true,
      strategy: injection.strategy,
      ranValidation: false,
      results: [],
      violations: [],
      requireSnapshot: injection.requireSnapshot,
      requireConfirmation: injection.requireConfirmation,
    };
  }

  const results = [];
  const violations = [];
  for (const v of injection.validators) {
    const r = interceptors.runInterceptor(v.validator, content, ctx);
    results.push({ executor: v.executor, validator: r.validator, ok: r.ok, error: r.error });
    if (!r.ok) violations.push({ executor: v.executor, error: r.error || '校验失败。' });
  }

  return {
    passed: violations.length === 0,
    strategy: injection.strategy,
    ranValidation: true,
    results,
    violations,
    requireSnapshot: injection.requireSnapshot,
    requireConfirmation: injection.requireConfirmation,
  };
}

module.exports = {
  SOFT_FORMAT_HINT,
  resolveInjection,
  runHardValidation,
};
