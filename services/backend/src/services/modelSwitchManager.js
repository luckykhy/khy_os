'use strict';

/**
 * modelSwitchManager.js — escalation EXECUTION for the small-model
 * normalization pipeline (stage 4: small→strong model handover, task #6).
 *
 * modelEscalationPolicy decides WHETHER to escalate; this module does the
 * actual handover work:
 *
 *   1. prepareEscalationContext — condense the loop's progress (plan summary,
 *      completed-step key results, failure chain, escalation reason) into a
 *      single structured Chinese carry-forward text, hard-capped by the
 *      getCarryForwardTokenBudgets().carryforward token budget, to be
 *      injected into the stronger model's first turn.
 *   2. performEscalation — apply an IN-SESSION (non-persistent) model
 *      override through liveModelSwitch, so the aiGateway routes subsequent
 *      generate() calls to the target model. Fail-soft: { ok:false } on any
 *      problem; the caller then continues on the original path.
 *   3. buildEscalationStatusMessage — the user-facing Chinese status line
 *      (action + target + progress).
 *   4. maybeEscalate — the one-call orchestration used by the loop hook:
 *      evaluate → select target → prepare context → perform switch → consume
 *      counters → build the metrics event (task #7 reads `event`).
 *
 * Boundary: this module handles SEMANTIC failure handover only. Network /
 * adapter failures stay with the aiGateway fallback cascade — no gateway
 * code is touched here.
 *
 * All numeric budgets come from constants/smallModelDefaults (zero
 * hardcoding); no model-name literals (SSOT: constants/models.js via
 * modelEscalationPolicy.selectTargetModel).
 *
 * @module services/modelSwitchManager
 */

const { getCarryForwardTokenBudgets } = require('../constants/smallModelDefaults');
// Canonical chars/4 estimate atom (utils leaf; heuristic fallback only).
const _simpleTokenEstimate = require('../utils/simpleTokenEstimate');

// ── Token estimation ─────────────────────────────────────────────────────────

/**
 * Estimate token count for a text. Prefers the project-wide estimator
 * (textHeuristics.estimateTokens → contextWasm-backed, len/4 fallback);
 * degrades to the same chars/4 heuristic when unavailable.
 * @param {string} text
 * @returns {number}
 */
function _estimateTokens(text) {
  const s = typeof text === 'string' ? text : String(text == null ? '' : text);
  try {
    const n = require('./textHeuristics').estimateTokens(s);
    if (Number.isFinite(n) && n >= 0) {
      return n;
    }
  } catch {
    /* fall through to heuristic */
  }
  // Thin delegate; byte-identical to Math.ceil(s.length / 4) (s is always a string here).
  return _simpleTokenEstimate(s);
}

// ── Internal formatting helpers ──────────────────────────────────────────────

/** Clip a one-line excerpt from arbitrary tool output (string or object). */
function _excerpt(value, maxChars) {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (value && typeof value === 'object') {
    text = String(value.output || value.content || value.text || value.message || '');
    if (!text) {
      try {
        text = JSON.stringify(value);
      } catch {
        text = '';
      }
    }
  } else if (value != null) {
    text = String(value);
  }
  text = text.replace(/\s+/g, ' ').trim();
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 200;
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/** Normalize a tool error (string or structured) to a one-line excerpt. */
function _errorExcerpt(err, maxChars) {
  if (err && typeof err === 'object') {
    const text = [err.code, err.message, err.hint].filter(Boolean).join(' ');
    return _excerpt(text || err, maxChars);
  }
  return _excerpt(err, maxChars);
}

/** Chinese label for an execution-plan step status. */
function _stepStatusLabel(status) {
  switch (String(status || '').toLowerCase()) {
    case 'completed':
    case 'done':
    case 'success':
      return '已完成';
    case 'failed':
    case 'error':
      return '失败';
    case 'in_progress':
    case 'running':
    case 'active':
      return '进行中';
    case 'skipped':
      return '已跳过';
    default:
      return '待执行';
  }
}

// Per-item excerpt caps (chars). These are FORMATTING caps, not the token
// budget — the assembled text is additionally capped by the carryforward
// token budget below. Kept as local constants because they bound single-line
// display width, not pipeline behavior.
const _RESULT_EXCERPT_CHARS = 200;
const _ERROR_EXCERPT_CHARS = 160;
const _STEP_DESC_CHARS = 120;
const _MAX_RESULT_ITEMS = 8;
const _MAX_FAILURE_ITEMS = 5;

// ── Carry-forward context ────────────────────────────────────────────────────

/**
 * Build the carry-forward handover text for the escalated (stronger) model.
 *
 * Sections (priority order — later sections are dropped first when the token
 * budget is tight):
 *   1. header: escalation reason + model handover statement
 *   2. plan summary: executionPlan steps with per-step status
 *   3. failure chain: recent failed tool calls (tool + error excerpt)
 *   4. completed-step key results: recent successful tool calls (excerpts)
 *   5. handover instruction (what the new model must do next)
 *
 * The assembled text is hard-capped by getCarryForwardTokenBudgets(env)
 * .carryforward: optional result items are added greedily while under
 * budget, then a final character-level cut guarantees the cap even for a
 * pathologically long single section.
 *
 * @param {object} loopState - { executionPlan, currentPlanStep, toolCallLog,
 *        currentModelId, targetModelId, iteration }
 * @param {string} reason - Chinese escalation reason from evaluate()
 * @param {object} [opts]
 * @param {object} [opts.env] - Defaults to process.env
 * @returns {{carryForwardText: string, tokenEstimate: number, truncated: boolean}}
 */
function prepareEscalationContext(loopState, reason, opts = {}) {
  try {
    const env = (opts && opts.env) || process.env;
    const budget = getCarryForwardTokenBudgets(env).carryforward;
    const ls = loopState && typeof loopState === 'object' ? loopState : {};

    const lines = [];
    lines.push('【模型升级交接】');
    lines.push(`升级原因：${String(reason || '').trim() || '小模型多次失败'}`);
    if (ls.currentModelId || ls.targetModelId) {
      lines.push(
        `模型交接：${ls.currentModelId || '（未知）'} → ${ls.targetModelId || '（待定）'}`
      );
    }

    // 2. Plan summary with per-step status.
    const steps =
      ls.executionPlan && Array.isArray(ls.executionPlan.steps) ? ls.executionPlan.steps : [];
    if (steps.length > 0) {
      lines.push('');
      lines.push(
        `计划进度（共 ${steps.length} 步，当前第 ${Math.min((Number(ls.currentPlanStep) || 0) + 1, steps.length)} 步）：`
      );
      steps.forEach((step, i) => {
        const desc = _excerpt(
          (step && (step.description || step.title || step.text || step.step)) || '',
          _STEP_DESC_CHARS
        );
        lines.push(`  ${i + 1}. [${_stepStatusLabel(step && step.status)}] ${desc}`);
      });
    }

    // 3. Failure chain (most recent failures, oldest → newest).
    const log = Array.isArray(ls.toolCallLog) ? ls.toolCallLog : [];
    const failures = log
      .filter((t) => t && t.result && t.result.success === false && !t.result.denied)
      .slice(-_MAX_FAILURE_ITEMS);
    if (failures.length > 0) {
      lines.push('');
      lines.push('失败原因链（最近）：');
      for (const f of failures) {
        lines.push(
          `  - ${f.tool || '未知工具'}：${_errorExcerpt(f.result.error, _ERROR_EXCERPT_CHARS) || '未知错误'}`
        );
      }
    }

    // 5. Handover instruction — appended before optional results so the
    //    mandatory skeleton is complete even at a tiny budget.
    const instruction = [
      '',
      '请以上述状态为基础接管任务：优先完成失败/未完成的步骤，不要重复已完成的工作；',
      '如失败原因链显示某条路径不可行，请换一种做法而非原样重试。',
    ];

    // Assemble mandatory skeleton first.
    let text = lines.concat(instruction).join('\n');
    let truncated = false;

    // 4. Completed-step key results — added greedily while under budget.
    const successes = log
      .filter((t) => t && t.result && t.result.success === true)
      .slice(-_MAX_RESULT_ITEMS);
    if (successes.length > 0 && _estimateTokens(text) < budget) {
      const resultLines = ['', '已完成步骤关键结果（最近）：'];
      for (const s of successes) {
        const line = `  - ${s.tool || '未知工具'}：${_excerpt(s.result, _RESULT_EXCERPT_CHARS) || '成功'}`;
        // Greedy admission: stop adding once the budget would be exceeded.
        const probe = lines.concat(resultLines, [line], instruction).join('\n');
        if (_estimateTokens(probe) > budget) {
          truncated = true;
          break;
        }
        resultLines.push(line);
      }
      if (resultLines.length > 2) {
        text = lines.concat(resultLines, instruction).join('\n');
      }
    }

    // Final hard cap: guarantee the budget even when the mandatory skeleton
    // alone overflows (e.g. a huge plan). chars ≈ tokens × 4 heuristic bound.
    if (_estimateTokens(text) > budget) {
      truncated = true;
      const hardChars = Math.max(80, budget * 4);
      text = `${text.slice(0, hardChars)}\n……（交接内容已按 token 预算截断）`;
    }

    return { carryForwardText: text, tokenEstimate: _estimateTokens(text), truncated };
  } catch {
    // Fail-soft: a minimal handover note is still better than nothing.
    const fallback = `【模型升级交接】升级原因：${String(reason || '').trim() || '小模型多次失败'}。请接管并继续完成当前任务。`;
    return {
      carryForwardText: fallback,
      tokenEstimate: _estimateTokens(fallback),
      truncated: false,
    };
  }
}

// ── Escalation execution ─────────────────────────────────────────────────────

/**
 * Apply the in-session model override through liveModelSwitch (the same
 * mechanism /model uses, see aiGateway.syncModelSwitch). Non-persistent by
 * design: the escalation lives and dies with this session. `force:true`
 * because the loop calls this BETWEEN generations (never mid-stream).
 *
 * @param {object} params
 * @param {string} [params.sessionId] - for the switch reason audit trail
 * @param {string} [params.currentModelId]
 * @param {string} params.targetModelId
 * @param {string} [params.reason] - Chinese escalation reason
 * @returns {{ok: boolean, appliedModel: (string|null), error?: string}}
 */
function performEscalation({ sessionId, currentModelId, targetModelId, reason } = {}) {
  try {
    const target = String(targetModelId || '').trim();
    if (!target) {
      return { ok: false, appliedModel: null, error: 'no target model' };
    }
    const { getInstance } = require('./liveModelSwitch');
    const switcher = getInstance();
    const res = switcher.switchModel(target, {
      reason:
        `auto_escalation:${String(reason || '').slice(0, 120)}` +
        (sessionId ? ` session=${sessionId}` : '') +
        (currentModelId ? ` from=${currentModelId}` : ''),
      persist: false, // session-scoped only — never touch the saved preference
      force: true, // called between generations, safe to apply immediately
    });
    if (res && res.success) {
      return { ok: true, appliedModel: target };
    }
    return { ok: false, appliedModel: null, error: (res && res.error) || 'switch rejected' };
  } catch (e) {
    return { ok: false, appliedModel: null, error: (e && e.message) || 'switch failed' };
  }
}

/**
 * User-facing Chinese status line: action + target + progress.
 * e.g. 「小模型 qwen2.5:7b 工具 Bash 连续失败 3 次（阈值 3 次），自动升级到
 *       claude-sonnet-4-6 接管步骤 3/5」
 * @param {object} params - { currentModelId, targetModelId, reason, stepIndex, stepTotal }
 * @returns {string}
 */
function buildEscalationStatusMessage({
  currentModelId,
  targetModelId,
  reason,
  stepIndex,
  stepTotal,
} = {}) {
  const cur = String(currentModelId || '').trim();
  const target = String(targetModelId || '').trim() || '更强模型';
  const why = String(reason || '').trim() || '多次失败';
  const progress =
    Number.isFinite(Number(stepTotal)) && Number(stepTotal) > 0
      ? ` 接管步骤 ${Math.min(Math.max(Number(stepIndex) || 1, 1), Number(stepTotal))}/${Number(stepTotal)}`
      : '';
  return `小模型${cur ? ` ${cur}` : ''} ${why}，自动升级到 ${target}${progress}`;
}

// ── One-call orchestration for the loop hook ─────────────────────────────────

/**
 * Evaluate-and-escalate in one call (the loop hook's single entry point).
 *
 * Flow: policy.evaluate → policy.selectTargetModel → prepareEscalationContext
 * → performEscalation → state.noteEscalation → build status message + metrics
 * event. Every step is fail-soft; any miss returns a non-escalated result
 * (with `skippedReason` when the DECISION fired but execution could not
 * follow through) so the loop continues on its original path.
 *
 * @param {object} params
 * @param {object} params.state - from modelEscalationPolicy.createEscalationState()
 * @param {object} params.pipelineState - the loop's `_pipelineState`
 * @param {object} params.loopState - { executionPlan, currentPlanStep,
 *        toolCallLog, currentModelId, iteration, sessionId? }
 * @param {object} [params.env] - Defaults to process.env
 * @returns {null|{escalated:boolean, skippedReason?:string, targetModelId?:string,
 *   carryForwardText?:string, statusMessage?:string, event?:object}}
 *   null when the policy did not fire. `event` is the metrics record for
 *   task #7 (also emitted by the loop as the 'model-escalation' breadcrumb).
 */
function maybeEscalate({ state, pipelineState, loopState, env } = {}) {
  try {
    const effEnv = env || process.env;
    const policy = require('./modelEscalationPolicy');
    const decision = policy.evaluate(state, pipelineState, { env: effEnv });
    if (!decision || !decision.escalate) {
      return null;
    }

    const ls = loopState && typeof loopState === 'object' ? loopState : {};
    const currentModelId = String(ls.currentModelId || '').trim();

    const targetModelId = policy.selectTargetModel(currentModelId, { env: effEnv });
    if (!targetModelId) {
      return { escalated: false, skippedReason: 'no_target_model', decision };
    }

    const ctx = prepareEscalationContext({ ...ls, targetModelId }, decision.reason, {
      env: effEnv,
    });

    const switched = performEscalation({
      sessionId: ls.sessionId,
      currentModelId,
      targetModelId,
      reason: decision.reason,
    });
    if (!switched.ok) {
      return {
        escalated: false,
        skippedReason: `switch_failed:${switched.error || 'unknown'}`,
        decision,
      };
    }

    // Consume the triggering counters + bump the session escalation budget.
    if (state && typeof state.noteEscalation === 'function') {
      state.noteEscalation(pipelineState && pipelineState.selfCheckFailures);
    }

    const steps =
      ls.executionPlan && Array.isArray(ls.executionPlan.steps) ? ls.executionPlan.steps : [];
    const stepTotal = steps.length;
    const stepIndex = Math.min((Number(ls.currentPlanStep) || 0) + 1, stepTotal || 1);

    // Metrics event (task #7 consumes this — emitted by the loop as the
    // 'model-escalation' breadcrumb; single construction site by design).
    const event = {
      type: 'model_escalation',
      fromModel: currentModelId,
      toModel: targetModelId,
      targetTier: decision.targetTier,
      signal: decision.signal,
      reason: decision.reason,
      counts: decision.counts || null,
      escalationsUsed: state ? state.escalationsUsed : null,
      iteration: Number(ls.iteration) || 0,
      planStep: stepTotal > 0 ? stepIndex : null,
      planTotal: stepTotal > 0 ? stepTotal : null,
      carryForwardTokens: ctx.tokenEstimate,
      carryForwardTruncated: !!ctx.truncated,
      at: Date.now(),
    };

    // ── Stage 5 metrics + diagnostics seam (task #7) ──
    // The escalation HIT is decided right here (single construction site of
    // `event`), so this is the minimal hook point — toolUseLoopCore keeps its
    // 'model-escalation' breadcrumb untouched. Independent try/catch + lazy
    // require: strictly fail-soft, never affects the escalation hand-over.
    try {
      require('./toolExecutionMetrics').recordEscalation(event);
      require('./diagnosticEvents').diagnostics.emitSmallModelEscalation(event);
    } catch {
      /* metrics/diagnostics are non-critical */
    }

    return {
      escalated: true,
      targetModelId,
      carryForwardText: ctx.carryForwardText,
      statusMessage: buildEscalationStatusMessage({
        currentModelId,
        targetModelId,
        reason: decision.reason,
        stepIndex,
        stepTotal,
      }),
      event,
    };
  } catch {
    return null; // fail-soft: escalation must never break the loop
  }
}

module.exports = {
  prepareEscalationContext,
  performEscalation,
  buildEscalationStatusMessage,
  maybeEscalate,
};
