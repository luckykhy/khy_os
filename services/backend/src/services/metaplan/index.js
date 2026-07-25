'use strict';

/**
 * metaplan/index.js — MetaPlanCoordinator (目标11 §6 闭环).
 *
 * Wires the meta-plan subsystem into one orchestration surface the scheduler can
 * call, WITHOUT touching the core tool-use loop or business logic (防呆④: 只重构
 * 调度引擎、约束注入与执行器层). The contract enforces the goal's whole loop:
 *
 *   1. renderMetaPlanPrompt(action)  — the prompt the model must answer FIRST,
 *      with the live executor menu (§4) + the constraint ladder (§2). 防呆①:
 *      meta-plan precedes execution.
 *
 *   2. ingestMetaPlan(rawOutput, action) — parse → validate/anti-laziness-escalate
 *      (§2) → constitutional red line (§5, uncoverable) → trust circuit-breaker
 *      floor (§5) → resolve the injection plan (§3). Returns the EFFECTIVE strategy
 *      and an opaque ticket the scheduler carries to execution.
 *
 *   3. validateExecution(ticket, {content, language}) — runs the mounted code
 *      interceptors for Code_Hard / System_Block (§3); Soft fast-passes. A failure
 *      here is a hard reject (不过坚决打回).
 *
 *   4. recordExecutionOutcome(ticket, {ok, error}) — feeds the breaker so a wrong
 *      Soft bet tightens future same-type work (§5 闭环自愈).
 *
 * State (the breaker) is per-coordinator: construct one per session.
 */

const strategyEnum = require('./constraintStrategy');
const registry = require('./executorRegistry');
const schema = require('./metaPlanSchema');
const interceptors = require('./codeInterceptors');
const injection = require('./constraintInjection');
const redLines = require('./constitutionalRedLines');
const { TrustCircuitBreaker } = require('./trustCircuitBreaker');

class MetaPlanCoordinator {
  constructor(opts = {}) {
    this.breaker = opts.breaker || new TrustCircuitBreaker(opts.breakerOptions || {});
  }

  /**
   * §6 step 1 — the meta-plan prompt the model MUST answer before acting. The
   * executor menu is generated from the registry so the model's universe of
   * choices == the registry (防呆: single source of truth).
   * @param {object} action  { description, taskType, language }
   * @returns {string}
   */
  renderMetaPlanPrompt(action = {}) {
    const desc = String(action.description || action.task || '(未描述的微任务)');
    const lang = action.language ? `（目标语言：${action.language}）` : '';
    return [
      '在执行任何写入/修改之前，你必须先输出一份「元规划」JSON（防呆①：先规划后执行）。',
      '',
      `# 待执行微任务${lang}`,
      desc,
      '',
      '# 可选执行器（武器库 — 只能从下表挑选，不可凭空捏造）',
      registry.describeForModel(),
      '',
      '# 约束级别（自行评估风险后选择，宁紧勿松）',
      '  - "Prompt_Soft"：低风险/纯创作（如改注释、文案、字符串常量）。跳过 AST/沙箱，最省 Token 与延迟。',
      '  - "Code_Hard"：高风险/逻辑变更（如重构异步控制流）。强制挂载 AST/语法校验，校验不过打回。',
      '  - "System_Block"：极危/不可逆（如删库、改核心依赖）。系统级挂起，须先备份快照 + 确认。',
      '',
      '# 防偷懒铁律',
      '  若选 "Prompt_Soft"，必须在 risk_dissent 里用一句话论证：此操作为何绝不会引发语法崩溃或逻辑污染。',
      '  论证不充分（过短或缺失）将被系统自动升级为 "Code_Hard"。',
      '',
      '# 只输出如下 JSON，不要附加任何解释：',
      '{',
      '  "toolchain": ["<执行器id>", ...],',
      '  "constraint_strategy": "Prompt_Soft | Code_Hard | System_Block",',
      '  "risk_dissent": "<若选 Prompt_Soft 必填的风险论证>"',
      '}',
    ].join('\n');
  }

  /** The JSON schema object for callers that drive structured output. */
  metaPlanSchema() {
    return schema.buildMetaPlanSchema();
  }

  /**
   * §6 step 2 — ingest the model's meta-plan output and resolve the EFFECTIVE
   * execution ticket through the full override stack.
   *
   * @param {string} rawOutput  the model's raw text containing the meta-plan JSON
   * @param {object} action     { taskType, language, tool, params, command, path, content }
   * @returns {{
   *   ok:boolean,
   *   error?:string,
   *   ticket?:object
   * }}
   */
  ingestMetaPlan(rawOutput, action = {}) {
    // Parse (防呆①: no parsable meta-plan ⇒ refuse to proceed).
    const parsed = schema.parseMetaPlan(rawOutput);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    // Validate + anti-laziness escalation (§2).
    const validated = schema.validateMetaPlan(parsed.plan);
    if (!validated.valid) return { ok: false, error: validated.error };

    const norm = validated.normalized;
    const taskType = _taskType(action);
    const overrides = [...norm.escalations];

    // After the model's own (possibly escalated) choice, apply the two override
    // layers. Order is irrelevant — escalate() is a monotone LUB — but we apply
    // the constitutional red line LAST so it is unmistakably uncoverable.
    let effective = norm.constraint_strategy;

    // Trust circuit-breaker floor (§5).
    const broke = this.breaker.effectiveStrategy(effective, taskType);
    if (broke.floored) {
      effective = broke.strategy;
      overrides.push(broke.reason);
    }

    // Constitutional red line (§5) — forces System_Block on matching actions,
    // regardless of everything above. Cannot be relaxed.
    const guarded = redLines.enforce(effective, action);
    if (guarded.redLine) {
      effective = guarded.strategy;
      overrides.push(`宪法红线 [${guarded.redLine.rule}]：${guarded.redLine.reason}`);
    }

    // Build the normalized plan the injection engine consumes.
    const effectivePlan = {
      toolchain: norm.toolchain,
      constraint_strategy: effective,
      declared_strategy: norm.declared_strategy,
      risk_dissent: norm.risk_dissent,
    };
    const inj = injection.resolveInjection(effectivePlan);

    return {
      ok: true,
      ticket: {
        taskType,
        language: action.language || null,
        declaredStrategy: norm.declared_strategy,
        effectiveStrategy: effective,
        toolchain: norm.toolchain,
        riskDissent: norm.risk_dissent,
        overrides,
        injection: inj,
        redLine: guarded.redLine || null,
        // The plan object validate/inject operate on (carried for step 3).
        _plan: effectivePlan,
      },
    };
  }

  /**
   * §6 step 3 — run the mounted interceptors against candidate content before the
   * write is allowed. Soft fast-passes (nothing mounted). System_Block additionally
   * reports the snapshot/confirm requirements the scheduler must satisfy.
   *
   * @param {object} ticket  from ingestMetaPlan
   * @param {object} cand    { content, language }
   * @returns {{
   *   allowed:boolean,
   *   strategy:string,
   *   ranValidation:boolean,
   *   violations:Array<{executor:string, error:string}>,
   *   requireSnapshot:boolean,
   *   requireConfirmation:boolean,
   *   results:Array<object>
   * }}
   */
  validateExecution(ticket, cand = {}) {
    if (!ticket || !ticket._plan) {
      return {
        allowed: false,
        strategy: strategyEnum.STRATEGIES.SYSTEM_BLOCK,
        ranValidation: false,
        violations: [{ executor: '(none)', error: '缺少有效的元规划票据，拒绝执行（防呆①）。' }],
        requireSnapshot: true,
        requireConfirmation: true,
        results: [],
      };
    }
    const ctx = { language: cand.language || ticket.language || '' };
    const v = injection.runHardValidation(ticket._plan, cand.content, ctx);
    return {
      allowed: v.passed,
      strategy: v.strategy,
      ranValidation: v.ranValidation,
      violations: v.violations,
      requireSnapshot: v.requireSnapshot,
      requireConfirmation: v.requireConfirmation,
      results: v.results,
    };
  }

  /**
   * §6 step 4 — record the real execution outcome so the circuit-breaker learns
   * (闭环自愈). Pass the ticket from ingest and whether execution actually
   * succeeded.
   * @param {object} ticket
   * @param {object} outcome  { ok, error }
   * @returns {object} breaker snapshot
   */
  recordExecutionOutcome(ticket = {}, outcome = {}) {
    return this.breaker.recordOutcome({
      ok: !!outcome.ok,
      declaredStrategy: ticket.declaredStrategy,
      effectiveStrategy: ticket.effectiveStrategy,
      taskType: ticket.taskType,
      error: outcome.error,
    });
  }

  /** Whether the session is locked to Code_Hard by repeated mis-judgment. */
  isSessionLocked() {
    return this.breaker.isSessionLocked();
  }
}

function _taskType(action = {}) {
  if (action.taskType) return String(action.taskType).trim().toLowerCase();
  // Derive a coarse type from language so distrust is scoped sensibly.
  const lang = String(action.language || '').trim().toLowerCase();
  return lang ? `edit:${lang}` : 'edit:default';
}

module.exports = {
  MetaPlanCoordinator,
  // Re-export submodules so callers have one import surface (mirrors marshal/).
  constraintStrategy: strategyEnum,
  executorRegistry: registry,
  metaPlanSchema: schema,
  codeInterceptors: interceptors,
  constraintInjection: injection,
  constitutionalRedLines: redLines,
  TrustCircuitBreaker,
};
