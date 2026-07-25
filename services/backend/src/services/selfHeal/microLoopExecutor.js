'use strict';

/**
 * selfHeal/microLoopExecutor.js — MicroLoopExecutor：诊断 → 修复 → 重试 微循环。
 *
 * 「先救后报」的执行核心。对单次工具失败，做**恰好一轮**（硬上限 1 次）的：
 *   诊断（ErrorDiagnostician）→ 判级/熔断 → （L1 询问获批）→ 受控修复（FixActions）→ 产出新入参。
 * 它**不**自己重试工具——重试由调用方（降级执行器）以新入参执行恰一次，从而把
 * 「max_retry=1」与「max_loop=1」两道防呆都落在结构上，而非靠自觉。
 *
 * 防呆（硬约束，对应 Goal3）：
 *   ① 微循环硬编码上限 = 1 次：MAX_LOOP=1，且 repair() 对每个 Plan 只被降级执行器调用一次。
 *   ② 处方只来自字典：修复动作全部经 FixActions（命令来自 registry/固定候选），禁止模型自由生成。
 *   ③ L2 级禁止进入修复微循环：诊断 fixable=false（含 risk=L2 / refuse / degrade-direct）直接返回降级信号。
 *   ④ 处方级死循环熔断：同一条处方重复开具 → 判无效 → 中断微循环走降级。
 *
 * 两种用法：
 *   - repair(args)：适配 resilience BudgetAwareExecutor 的 ctx.repair 钩子，返回 {changed, params}。
 *   - runOnce(args)：独立微循环（用于直接编排/单测），返回 {ok, result, attempted_fixes, diagnosis}。
 *
 * 全程记录 attempted_fixes（{action, result, auto}）与 lastDiagnosis，供强制兜底报告引用。
 */

const { ErrorDiagnostician } = require('./errorDiagnostician');
const { PrescriptionDeadLoopDetector } = require('./deadLoopDetector');
const { FixActions } = require('./fixActions');

/** 微循环硬编码上限——诊断→修复→重试，仅一轮。**不可配置**（防呆①）。 */
const MAX_LOOP = 1;

class MicroLoopExecutor {
  /**
   * @param {object} [opts]
   * @param {ErrorDiagnostician} [opts.diagnostician]
   * @param {PrescriptionDeadLoopDetector} [opts.deadLoop]  跨 Plan 共享的处方熔断器
   * @param {FixActions} [opts.fixActions]
   * @param {Function} [opts.confirm]  L1 获批回调 async ({diagnosis,dep})=>boolean（缺省拒绝，安全方向）
   */
  constructor(opts = {}) {
    this.diagnostician = opts.diagnostician || new ErrorDiagnostician();
    this.deadLoop = opts.deadLoop || new PrescriptionDeadLoopDetector();
    this.fixActions = opts.fixActions || new FixActions();
    this.confirm = typeof opts.confirm === 'function' ? opts.confirm : null;
    /** @type {Array<{action:string,result:string,auto:boolean}>} 全程修复尝试流水 */
    this.attempted_fixes = [];
    /** @type {object|null} 首个有意义诊断（供兜底报告 diagnosis 字段） */
    this.lastDiagnosis = null;
    this.MAX_LOOP = MAX_LOOP;
  }

  /**
   * 计算并尝试一次修复，产出可重试的新入参（不自行重试工具）。
   * @param {object} args { toolName, params, failure, context, control }
   * @returns {Promise<{ fixed:boolean, params?:object, diagnosis:object, degrade:boolean, record?:object }>}
   */
  async heal(args = {}) {
    const { toolName, params = {}, failure, context = {}, control = null } = args;

    // ① 精准归因（含 L2 判定、字典处方）。
    const diagnosis = this.diagnostician.diagnose(failure, { ...context, params, tool: toolName });
    if (!this.lastDiagnosis) this.lastDiagnosis = diagnosis;

    // ③ L2 / 不可本地修复 → 禁止进入修复微循环，直接降级。
    if (!diagnosis.fixable) {
      return { fixed: false, diagnosis, degrade: true };
    }

    // ④ 处方级死循环熔断：同处方已开过 → 判无效，转降级。
    const probe = this.deadLoop.check(diagnosis);
    if (probe.dead) {
      const rec = { action: diagnosis.action || diagnosis.fixKind, result: 'skipped:dead-loop(same-prescription)', auto: diagnosis.risk === 'L0' };
      this.attempted_fixes.push(rec);
      return { fixed: false, diagnosis, degrade: true, record: rec };
    }

    // L1：必须获批才执行（L0 自动，零询问）。
    if (diagnosis.needsConfirm) {
      let approved = false;
      if (this.confirm) {
        try { approved = !!(await this.confirm({ diagnosis, dependency: diagnosis.capture && diagnosis.capture.dep, action: diagnosis.action })); }
        catch { approved = false; }
      }
      if (!approved) {
        const rec = { action: diagnosis.action || diagnosis.fixKind, result: 'declined:user-not-approved', auto: false };
        this.attempted_fixes.push(rec);
        return { fixed: false, diagnosis, degrade: true, record: rec };
      }
    }

    // 登记处方（防呆④：登记后同处方再现即判死），然后执行受控修复。
    this.deadLoop.record(diagnosis);
    const fix = await this.fixActions.apply(diagnosis, { params, toolName, context, control });
    const auto = diagnosis.risk === 'L0';
    if (fix && fix.ok && fix.params) {
      const rec = { action: diagnosis.action || diagnosis.fixKind, result: 'fixed', auto };
      this.attempted_fixes.push(rec);
      return { fixed: true, params: fix.params, diagnosis, degrade: false, record: rec, info: fix.info };
    }
    const rec = { action: diagnosis.action || diagnosis.fixKind, result: `failed:${(fix && fix.reason) || 'unknown'}`, auto };
    this.attempted_fixes.push(rec);
    return { fixed: false, diagnosis, degrade: true, record: rec };
  }

  /**
   * resilience BudgetAwareExecutor 的 ctx.repair 适配器。
   * 每个 Plan 失败时被调用**一次**；返回 {changed, params} —— changed=true 才允许那唯一一次重试。
   * @param {object} hookArgs { node, failure, params, context }
   * @returns {Promise<{ changed:boolean, params?:object }>}
   */
  async repair(hookArgs = {}) {
    const { node, failure, params, context } = hookArgs;
    const r = await this.heal({
      toolName: node && node.tool,
      params,
      failure,
      context: context || {},
      control: context && context.control,
    });
    return r.fixed ? { changed: true, params: r.params } : { changed: false };
  }

  /**
   * 独立微循环：对一次工具失败做「诊断→修复→重试（恰一次）」，自行重试工具。
   * 用于不经降级树的直接编排与单测。
   * @param {object} args { toolName, params, failure, context, control, runTool }
   *   runTool: async (toolName, params) => 结构化结果（含 success 判定）
   * @returns {Promise<{ ok:boolean, result?:*, params?:object, diagnosis:object, attempted_fixes:Array, degrade:boolean }>}
   */
  async runOnce(args = {}) {
    const { toolName, params = {}, failure, context = {}, control = null, runTool } = args;
    const startCount = this.attempted_fixes.length;
    const r = await this.heal({ toolName, params, failure, context, control });
    const fixesThisRound = this.attempted_fixes.slice(startCount);
    if (!r.fixed) {
      return { ok: false, diagnosis: r.diagnosis, attempted_fixes: fixesThisRound, degrade: true };
    }
    // 恰一次重试（MAX_LOOP=1）。
    let result = null;
    if (typeof runTool === 'function') {
      try { result = await runTool(toolName, r.params); } catch (err) { result = { success: false, error: (err && err.message) || String(err) }; }
    }
    const ok = _isSuccess(result);
    // 重试结果回写到对应修复记录（fixed→但重试仍失败时降级）。
    if (!ok && fixesThisRound.length) {
      fixesThisRound[fixesThisRound.length - 1].result = 'fixed-but-retry-failed';
    }
    return { ok, result, params: r.params, diagnosis: r.diagnosis, attempted_fixes: fixesThisRound, degrade: !ok };
  }

  /** 清空本次运行的流水（复用同一实例时调用）。 */
  reset() {
    this.attempted_fixes = [];
    this.lastDiagnosis = null;
    this.deadLoop.reset();
  }
}

function _isSuccess(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.success === true) return true;
  if (result.success === false) return false;
  // 无显式 success：有 error/error_code 视为失败，否则视为成功。
  if (result.error || result.error_code) return false;
  return true;
}

module.exports = {
  MicroLoopExecutor,
  MAX_LOOP,
  _isSuccess,
};
