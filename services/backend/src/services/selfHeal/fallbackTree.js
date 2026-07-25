'use strict';

/**
 * selfHeal/fallbackTree.js — FallbackTreeWithHeal：自愈优先 + 降级兜底的总编排。
 *
 * 把两半合成一个完整的「先救后报」闭环：
 *
 *   [自愈微循环]  MicroLoopExecutor —— 每个 Plan 失败先尝试诊断→修复→重试（恰一次）。
 *        │ 修复成功 → 原 Plan 重试通过 → 继续。
 *        │ 修复失败 / L2 / 处方死循环 → 放弃修复。
 *        ▼
 *   [降级熔断树]  resilience.BudgetAwareExecutor —— 向下一个 Plan 降级（深度硬上限 3）。
 *        │ 某 Plan 成功 → 继续。
 *        ▼
 *   [强制兜底]    穷尽 ≤3 层仍失败 → 输出 Goal3 规定的兜底报告（绝不只丢一句"失败"）。
 *
 * 实现立场（对齐零侵入先例）：**复用** resilience 既有的降级树/预算/死循环/残料兜底，
 * 只把自愈微循环作为 ctx.repair 钩子注入——这样
 *   · 「降级树深度硬上限 3 层」由 resilience MAX_FALLBACK_DEPTH 保证（防呆）；
 *   · 「每 Plan 至多重试 1 次」由 resilience MAX_RETRY_PER_PLAN 保证（防呆）；
 *   · 「微循环上限 1 次」由 MicroLoopExecutor 每 Plan 仅被 repair 调一次保证（防呆）。
 *
 * 兜底报告形状（Goal3 规定，严格对齐）：
 *   {
 *     status: "failed",
 *     intent,
 *     diagnosis,                 // 首个精准诊断（病因 + 处方 + 风险）
 *     attempted_fixes: [ { action, result, auto } ],
 *     salvage_data,              // 抢救到的残料（来自降级树各 Plan 的 extractSalvage）
 *     next_action_suggestion,
 *   }
 */

const { MicroLoopExecutor } = require('./microLoopExecutor');
const { PrescriptionDeadLoopDetector } = require('./deadLoopDetector');

let _resilience = null;
function _getResilience() {
  if (_resilience) return _resilience;
  _resilience = require('../resilience');
  return _resilience;
}

class FallbackTreeWithHeal {
  /**
   * @param {object} opts
   * @param {Function} opts.runner          (tool, params, planMeta)=>结构化结果（必填；通常 makeToolRunner(executeTool)）
   * @param {Function} [opts.confirm]       L1 修复获批回调（缺省拒绝=安全方向）
   * @param {object}   [opts.budget]        预算适配器（透传 resilience）
   * @param {number}   [opts.floorPct]      预算地板（透传 resilience）
   * @param {Function} [opts.onDegrade]     降级上下文注入回调（透传 resilience）
   * @param {string[]} [opts.availableTools]
   * @param {MicroLoopExecutor} [opts.microLoop]  可注入自定义微循环（测试用）
   */
  constructor(opts = {}) {
    this.opts = opts || {};
    this.deadLoop = new PrescriptionDeadLoopDetector();
    this.microLoop = opts.microLoop || new MicroLoopExecutor({
      deadLoop: this.deadLoop,
      confirm: opts.confirm,
    });
  }

  /**
   * 执行一个意图（或一棵自定义降级树），自愈优先、降级兜底、强制交代。
   * @param {string|object} intentOrTree
   * @param {object} context  意图上下文（url/query/params/control 等）
   * @returns {Promise<object>}
   *   成功: { status:'ok', intent, plan, result, attempted_fixes, degraded:boolean }
   *   失败: Goal3 兜底报告 { status:'failed', intent, diagnosis, attempted_fixes, salvage_data, next_action_suggestion }
   */
  async run(intentOrTree, context = {}) {
    const { ResilienceCoordinator } = _getResilience();

    // 把自愈微循环作为 repair 钩子注入降级执行器；control 透传给 L1 获批。
    const repair = (hookArgs) => this.microLoop.repair({
      ...hookArgs,
      context: { ...(hookArgs.context || {}), control: context.control },
    });

    const coord = new ResilienceCoordinator({
      runner: this.opts.runner,
      budget: this.opts.budget,
      floorPct: this.opts.floorPct,
      onDegrade: this.opts.onDegrade,
      availableTools: this.opts.availableTools,
    });

    let outcome;
    try {
      outcome = await coord.run(intentOrTree, { ...context, repair });
    } catch (err) {
      // 协调器理应不抛；万一抛了也要交差一份兜底（绝不裸抛给上层）。
      return this._fallbackReport({
        intent: typeof intentOrTree === 'string' ? intentOrTree : (intentOrTree && intentOrTree.intent),
        salvage: null,
        executorError: (err && err.message) || String(err),
      });
    }

    if (outcome && outcome.ok) {
      return {
        status: 'ok',
        intent: outcome.intent,
        plan: outcome.plan,
        result: outcome.result,
        attempted_fixes: this.microLoop.attempted_fixes.slice(),
        degraded: !!(Array.isArray(outcome.attempted) && outcome.attempted.length > 1),
      };
    }

    // 穷尽降级树仍失败 → 强制兜底报告（Goal3 形状）。
    return this._fallbackReport({
      intent: outcome && outcome.intent,
      salvage: outcome && outcome.salvage,
      circuit: outcome && outcome.circuit,
    });
  }

  /**
   * 把 resilience 的 salvage（failed_with_salvage / attempted_paths）转换为 Goal3 兜底形状，
   * 并注入自愈微循环收集的 diagnosis 与 attempted_fixes。
   */
  _fallbackReport({ intent, salvage, circuit, executorError }) {
    const diag = this.microLoop.lastDiagnosis;
    const diagnosis = diag
      ? {
          error_code: diag.error_code,
          cause: diag.cause,
          reason: diag.reason,
          risk: diag.risk,
          prescription: diag.action || null,
          detail: diag.detail,
        }
      : {
          error_code: 'E04',
          cause: executorError ? '降级执行器异常' : '未归类的执行失败',
          reason: 'execution-error',
          risk: null,
          prescription: null,
          detail: executorError || (salvage && salvage.next_action_suggestion) || '工具执行失败且无可本地修复的处方。',
        };

    return {
      status: 'failed',
      intent: String((salvage && salvage.intent) || intent || '(未命名意图)'),
      diagnosis,
      attempted_fixes: this.microLoop.attempted_fixes.slice(),
      salvage_data: (salvage && salvage.salvage_data !== undefined) ? salvage.salvage_data : '',
      next_action_suggestion: (salvage && salvage.next_action_suggestion)
        || (diag && diag.action)
        || '已穷尽自愈与降级路径，请人工核查上述诊断与尝试记录后重试。',
    };
  }
}

module.exports = { FallbackTreeWithHeal };
