'use strict';

/**
 * resilience/index.js — 「有限窗口降级与强制兜底」协议门面（ResilienceCoordinator）。
 *
 * 把四大件（降级树 / 预算感知执行器 / 死循环检测 / 强制兜底）收成一个稳定 API，
 * 供上层（toolUseLoop、子代理、网关）以非侵入方式接入：
 *
 *   const { ResilienceCoordinator, makeToolRunner } = require('.../resilience');
 *   const coord = new ResilienceCoordinator({
 *     runner: makeToolRunner(executeTool),   // 复用全局唯一工具漏斗
 *     budget: makeTokenBudget({ total, spent }),
 *     onDegrade: (text) => injectSystemTurn(text),
 *   });
 *   const outcome = await coord.run('fetch-web-content', { url, query });
 *   // outcome.ok ? outcome.result : outcome.salvage（结构化兜底 JSON）
 *
 * 设计立场（对齐 Goal11 元规划「零侵入」先例）：本子系统**自带**有限窗口 + 兜底闭环，
 * 不去外科手术式改写 4000 行的 toolUseLoop；接入点只是把 executeTool 包成 runner。
 */

const fallbackTree = require('./fallbackTree');
const errorSignature = require('./errorSignature');
const { DeadLoopDetector } = require('./deadLoopDetector');
const { SalvageProtector } = require('./salvage');
const budgetExecutor = require('./budgetExecutor');
const intentTrees = require('./intentTrees');

const { FallbackTreeBuilder, FallbackTreeError, MAX_FALLBACK_DEPTH, MAX_RETRY_PER_PLAN } = fallbackTree;
const { BudgetAwareExecutor, makeStepBudget, makeTokenBudget, DEFAULT_FLOOR_PCT } = budgetExecutor;
const { getIntentTree } = intentTrees;

/**
 * 把项目里全局唯一的 executeTool(toolName, params, traceContext) 适配成执行器要的
 * runner(tool, params, planMeta) 形状。非侵入：不改 executeTool 一行，只是包一层。
 * @param {Function} executeTool
 * @param {object} [baseTrace]  透传的基础 traceContext
 */
function makeToolRunner(executeTool, baseTrace = {}) {
  if (typeof executeTool !== 'function') throw new Error('makeToolRunner 需要 executeTool 函数');
  return async function runner(tool, params, planMeta) {
    const trace = { ...baseTrace, resiliencePlan: planMeta && planMeta.plan, resilienceRetry: planMeta && planMeta.retry };
    return executeTool(tool, params, trace);
  };
}

class ResilienceCoordinator {
  /**
   * @param {object} opts
   * @param {Function} opts.runner          (tool, params, planMeta) => 结构化结果（必填）
   * @param {object}   [opts.budget]        预算适配器（缺省按树深的步数预算）
   * @param {number}   [opts.floorPct]      预算地板（缺省 env 或 10）
   * @param {Function} [opts.onDegrade]     降级上下文注入回调
   * @param {string[]} [opts.availableTools]
   */
  constructor(opts = {}) {
    this.opts = opts || {};
  }

  /**
   * 按意图执行有限窗口降级 + 强制兜底。
   * @param {string|object} intentOrTree  意图名（用内置树）或一棵自定义 build() 树
   * @param {object} context              意图上下文（url/query/repair 等）
   * @returns {Promise<object>}  见 BudgetAwareExecutor.run 的返回形状
   */
  async run(intentOrTree, context = {}) {
    const tree = typeof intentOrTree === 'string' ? getIntentTree(intentOrTree) : intentOrTree;
    if (!tree || !Array.isArray(tree.plans)) {
      // 防呆：未知意图也要交差一份兜底，而不是抛错躺平。
      return {
        ok: false,
        intent: String(intentOrTree),
        circuit: 'unknown-intent',
        salvage: SalvageProtector.assemble({
          intent: String(intentOrTree),
          attempted: [],
          circuit: 'unknown-intent',
          lastFailure: { reason: 'unknown-intent', missingDependency: null },
        }),
      };
    }
    const executor = new BudgetAwareExecutor({
      runner: this.opts.runner,
      budget: this.opts.budget || makeStepBudget(tree.plans.length),
      floorPct: this.opts.floorPct,
      detector: this.opts.detector || new DeadLoopDetector(),
      onDegrade: this.opts.onDegrade,
      availableTools: this.opts.availableTools,
    });
    return executor.run(tree, context);
  }
}

module.exports = {
  // 门面
  ResilienceCoordinator,
  makeToolRunner,
  // 预算
  makeStepBudget,
  makeTokenBudget,
  DEFAULT_FLOOR_PCT,
  // 执行器
  BudgetAwareExecutor,
  // 降级树
  FallbackTreeBuilder,
  FallbackTreeError,
  MAX_FALLBACK_DEPTH,
  MAX_RETRY_PER_PLAN,
  getIntentTree,
  buildWebContentTree: intentTrees.buildWebContentTree,
  // 死循环 / 兜底 / 归类
  DeadLoopDetector,
  SalvageProtector,
  classifyFailure: errorSignature.classifyFailure,
  callSignature: errorSignature.callSignature,
};
