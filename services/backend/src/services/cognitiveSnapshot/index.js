'use strict';

/**
 * cognitiveSnapshot/index.js — CognitiveContextEngine，上下文永续与记忆压缩引擎门面。
 *
 * 把四个纯模块编排成一条「每步闭环」，在极窄的上下文寄存器里让长链路任务无缝接力：
 *
 *   planStep()    → 产出/校验资源预算规划（防呆⑤），不合规即阻断。
 *   beforeStep()  → 前置溢出熔断：越 80% 上限转压缩/卸载流（§3.4）。
 *   commitStep()  → 压缩历史 + 融合进度 → 生成并**持久化**快照（防呆②：无快照=无效步）。
 *   onTruncation()→ 截断异常熔断 → 紧急快照（防呆④）。
 *   hotStart()    → 跨会话热启，自动注入状态、跳过寒暄（防呆⑥）。
 *
 * 零侵入：只复用 contextWasm（token 真源）+ dataHome（持久化分桶），不改 toolUseLoop /
 * 调度器。接管真实 loop 是后续 PR 的事；本引擎是可独立驱动、可单测的状态机。
 */

const workbench = require('./workbench');
const compressionEngine = require('./compressionEngine');
const snapshotManager = require('./snapshotManager');
const overflowInterceptor = require('./overflowInterceptor');
const offloadStore = require('./offloadStore');

const DEFAULT_WINDOW = parseInt(process.env.KHY_CONTEXT_TOKEN_LIMIT || '131072', 10);

class CognitiveContextEngine {
  /**
   * @param {object} opts
   * @param {string} opts.taskId        全局任务 ID（必填）
   * @param {string} opts.ultimateGoal  终极目标 / 指南针（必填）
   * @param {number} [opts.contextWindowTokens]
   * @param {function} [opts.estimateTokensFn]  token 估算（默认 contextWasm）
   * @param {string} [opts.model] [opts.workspace]
   */
  constructor(opts = {}) {
    if (!opts.taskId) throw new Error('CognitiveContextEngine: taskId 必填');
    if (!opts.ultimateGoal) throw new Error('CognitiveContextEngine: ultimateGoal 必填（指南针不可空）');
    this.taskId = String(opts.taskId);
    this.ultimateGoal = String(opts.ultimateGoal);
    this.window = Math.max(1, Number(opts.contextWindowTokens) || DEFAULT_WINDOW);
    this.estimate = typeof opts.estimateTokensFn === 'function'
      ? opts.estimateTokensFn
      : (() => { try { return require('../contextWasm').estimateTokens; } catch { return (t) => Math.ceil(String(t || '').length / 4); } })();
    this.model = opts.model;
    this.workspace = opts.workspace;
    this.step = 0;
    this.retryCount = 0;
    this.offloadPointers = [];
  }

  /** 当前上下文占用率（0..1），基于已用 token / 窗口。 */
  usageRatio(usedTokens) {
    return Math.max(0, Number(usedTokens) || 0) / this.window;
  }

  /**
   * 产出本步资源预算规划（防呆⑤）。模型/调用方也可自带 plan 覆盖；这里给确定性默认。
   * @returns {{remaining:number, estimatedStepCost:number, strategy:string, ratio:number}}
   */
  planStep({ usedTokens = 0, estimatedStepTokens = 0 } = {}) {
    const remaining = Math.max(0, this.window - usedTokens);
    const ratio = this.usageRatio(usedTokens);
    const level = compressionEngine.selectLevel(ratio);
    const strategy = level === compressionEngine.LEVELS.L0 ? 'proceed'
      : level === compressionEngine.LEVELS.L3 ? 'offload' : 'compress';
    return { remaining, estimatedStepCost: estimatedStepTokens, strategy, ratio, level };
  }

  /**
   * 前置闸门（§3.4）：校验预算规划 + 80% 熔断。返回裁决，allow=false 时上层须先压缩/卸载。
   */
  beforeStep({ usedTokens = 0, estimatedStepTokens = 0, budgetPlan, canCompress = true } = {}) {
    const plan = budgetPlan || this.planStep({ usedTokens, estimatedStepTokens });
    return overflowInterceptor.preflight({
      usedTokens, estimatedStepTokens, windowTokens: this.window, budgetPlan: plan, canCompress,
    });
  }

  /**
   * 一步执行完毕的闭环：压缩历史 → 生成快照 → 持久化。
   * 防呆②：持久化失败即返回 invalid，调用方据此判定该步无效、需重做。
   *
   * @param {object} args
   * @param {Array<object>} args.steps       至今的全部步骤记录（按时间序）
   * @param {number} args.usedTokens         当前已用 token（决定压缩级别）
   * @param {string} args.nextInstruction    下一步具体指令
   * @param {boolean} [args.offloadCold=true] L3 时是否真正把冷数据落盘
   * @returns {{valid:boolean, snapshot?:object, level:string, retainedRatio:number,
   *   offloaded:number, error?:string}}
   */
  commitStep(args = {}) {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    this.step = steps.length ? (steps[steps.length - 1].step ?? steps.length) : this.step + 1;

    const ratio = this.usageRatio(args.usedTokens);
    const compressed = compressionEngine.compressHistory(steps, {
      usageRatio: ratio, estimateTokensFn: this.estimate,
    });

    // L3：把冷候选真正卸载离境，上下文里只回填指针（§3.2 L3 / §3.3 指针集）。
    let offloaded = 0;
    if (args.offloadCold !== false && compressed.offloadCandidates.length) {
      for (const cand of compressed.offloadCandidates) {
        const ptr = offloadStore.offload(this.taskId, cand.step, cand.folded);
        this.offloadPointers.push(ptr);
        offloaded += 1;
        const slot = compressed.history.find((h) => h.offloaded && h.step === cand.step);
        if (slot) slot.ref = ptr.ref; // 回填寻址指针
      }
    }

    const snapshot = snapshotManager.build({
      taskId: this.taskId,
      ultimateGoal: this.ultimateGoal,         // 指南针：永不删除
      step: this.step,
      compressedHistory: compressed.history,
      nextInstruction: args.nextInstruction || '',
      offloadPointers: this.offloadPointers,
      retryCount: this.retryCount,
      entities: compressed.entities,
      lessons: compressed.lessons,             // 防呆③：错误教训随快照常驻
      model: this.model,
      workspace: this.workspace,
    });

    const res = snapshotManager.persist(snapshot);
    return {
      valid: res.ok,                            // 防呆②：无快照 → 无效步
      snapshot: res.ok ? snapshot : undefined,
      level: compressed.level,
      retainedRatio: compressed.retainedRatio,
      offloaded,
      error: res.ok ? undefined : res.error,
    };
  }

  /** 错误重试计数 +1（写入下一张快照）。 */
  bumpRetry() { this.retryCount += 1; return this.retryCount; }

  /** 防呆④：截断异常熔断 → 紧急快照。 */
  onTruncation(steps = [], nextInstruction) {
    return overflowInterceptor.emergencySnapshot({
      taskId: this.taskId,
      ultimateGoal: this.ultimateGoal,
      step: this.step,
      steps,
      nextInstruction,
      retryCount: this.retryCount,
      offloadPointers: this.offloadPointers,
    });
  }

  /** 标记任务完成（hotStart 不再热启）。 */
  complete() { return snapshotManager.markComplete(this.taskId); }

  /** 跨会话热启（防呆⑥）：自动注入状态，绝不要求用户复述。 */
  hotStart() { return snapshotManager.hotStart(this.taskId); }

  /** 静态热启：新会话不知道 taskId 内部状态时直接据盘上快照接力。 */
  static hotStart(taskId) { return snapshotManager.hotStart(taskId); }
}

module.exports = {
  CognitiveContextEngine,
  workbench,
  compressionEngine,
  snapshotManager,
  overflowInterceptor,
  offloadStore,
};
