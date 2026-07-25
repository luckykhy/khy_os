'use strict';

/**
 * evoTrustBreaker.js — 信任熔断与进化回滚（§3.4 + 防呆④）。
 *
 * 这是自举引擎的「失控保险丝」。它有三道独立的熔断逻辑：
 *
 *   1. 分支熔断（§3.4）：同一痛点（按 EvoRequirement.id）连续 2 次生成的补丁都过不了沙箱，
 *      熔断该演进分支——不再为该痛点自举，并产出**架构级人类告警**。
 *   2. 引擎只读锁（防呆④）：跨痛点**连续 2 次**沙箱验证失败，强制熔断整个演进引擎，锁定为
 *      只读模式——引擎自此拒绝一切热载，直到人工复位。
 *   3. 进化回滚（§3.4）：已热载的补丁若在后续 3 次任务中引发新异常，强制卸载并回滚。
 *
 * 关键铁律（防呆③）：本模块是「锁具」，**绝不**由自举逻辑（PainPointScanner / Sandbox /
 * HostPatcher / 自生成代码）修改——它对 evo 链路只读。它也守护一份 `PROTECTED_INVARIANTS`
 * 清单（信任熔断机制自身 + 防呆规则模块），任何热载若指向其中之一一律否决。
 *
 * 纯状态机，无 I/O（持久化由 engine 经 evoLedger 落不可变日志）。
 */

// 受宪法保护、绝不允许被自举热载触碰的不变量模块（防呆③）。路径片段匹配即否决。
const PROTECTED_INVARIANTS = Object.freeze([
  'evoTrustBreaker',        // 熔断机制自身
  'evoLedger',              // 不可变日志
  'organogenesisSandbox',   // 沙箱判决/凭证签发
  'constraints',            // 全局禁令单一真源
  'constitutionalRedLines', // 宪法红线
  'metaplan/trustCircuitBreaker',
]);

const DEFAULT_BRANCH_FUSE = 2;     // 同一痛点连续沙箱失败次数 → 分支熔断（§3.4）
const DEFAULT_ENGINE_FUSE = 2;     // 跨痛点连续沙箱失败次数 → 引擎只读（防呆④）
const DEFAULT_ROLLBACK_ANOMALIES = 3; // 已载补丁引发新异常次数 → 回滚（§3.4）

class EvoTrustBreaker {
  constructor(opts = {}) {
    this.branchFuseThreshold = _posInt(opts.branchFuseThreshold, DEFAULT_BRANCH_FUSE);
    this.engineFuseThreshold = _posInt(opts.engineFuseThreshold, DEFAULT_ENGINE_FUSE);
    this.rollbackAnomalyThreshold = _posInt(opts.rollbackAnomalyThreshold, DEFAULT_ROLLBACK_ANOMALIES);

    this._consecutiveSandboxFailures = 0;       // 跨痛点连续失败（引擎只读判据）
    this._branchFailures = new Map();           // painpointId → 连续失败计数
    this._fusedBranches = new Set();            // 已熔断的痛点分支
    this._engineReadOnly = false;               // 引擎只读锁
    this._patchAnomalies = new Map();           // patchId → 后续异常计数
    this._events = [];
  }

  /** 引擎是否被锁为只读（防呆④）。HostPatcher 据此拒绝一切热载。 */
  isEngineReadOnly() { return this._engineReadOnly; }

  /** 某痛点分支是否已熔断（不再为其自举）。 */
  isBranchFused(painpointId) { return this._fusedBranches.has(String(painpointId)); }

  /** 受保护不变量检查（防呆③）：目标是否触碰锁具/红线模块。 */
  static isProtectedTarget(target) {
    const t = String(target || '');
    return PROTECTED_INVARIANTS.some((p) => t.includes(p));
  }

  /**
   * 登记一次沙箱判决结果，驱动分支熔断 + 引擎只读两道保险。
   * @param {string} painpointId  EvoRequirement.id
   * @param {boolean} passed       沙箱是否通过
   * @returns {{branchFused:boolean, engineReadOnly:boolean, alert:(object|null)}}
   */
  recordSandboxResult(painpointId, passed) {
    const id = String(painpointId || 'unknown');
    let alert = null;

    if (passed) {
      this._consecutiveSandboxFailures = 0;
      this._branchFailures.set(id, 0);
      this._events.push({ type: 'sandbox_pass', painpointId: id });
      return { branchFused: false, engineReadOnly: this._engineReadOnly, alert };
    }

    // 失败：分支计数 + 全局连续计数。
    const branchCount = (this._branchFailures.get(id) || 0) + 1;
    this._branchFailures.set(id, branchCount);
    this._consecutiveSandboxFailures += 1;
    this._events.push({ type: 'sandbox_fail', painpointId: id, branchCount, consecutive: this._consecutiveSandboxFailures });

    // 分支熔断（§3.4）：同一痛点连续 N 次失败 → 熔断分支 + 架构级告警。
    if (branchCount >= this.branchFuseThreshold && !this._fusedBranches.has(id)) {
      this._fusedBranches.add(id);
      alert = {
        kind: 'architectural-alert',
        painpointId: id,
        message: `痛点 ${id} 连续 ${branchCount} 次补丁均未通过沙箱，已熔断该演进分支，需人类架构介入。`,
      };
      this._events.push({ type: 'branch_fuse', painpointId: id, alert });
    }

    // 引擎只读（防呆④）：跨痛点连续 N 次失败 → 整机熔断只读。
    if (this._consecutiveSandboxFailures >= this.engineFuseThreshold && !this._engineReadOnly) {
      this._engineReadOnly = true;
      this._events.push({ type: 'engine_readonly', consecutive: this._consecutiveSandboxFailures });
    }

    return { branchFused: this._fusedBranches.has(id), engineReadOnly: this._engineReadOnly, alert };
  }

  /**
   * 登记一个**已热载补丁**在后续任务中的运行结果，驱动进化回滚（§3.4）。
   * @param {string} patchId
   * @param {boolean} anomaly  本次任务是否出现新异常
   * @returns {{rollback:boolean, anomalies:number}}
   */
  recordPostLoadOutcome(patchId, anomaly) {
    const id = String(patchId || 'unknown');
    if (!anomaly) {
      // 一次干净运行不清零（异常是累积证据）；但记录，便于审计。
      this._events.push({ type: 'patch_ok', patchId: id });
      return { rollback: false, anomalies: this._patchAnomalies.get(id) || 0 };
    }
    const count = (this._patchAnomalies.get(id) || 0) + 1;
    this._patchAnomalies.set(id, count);
    this._events.push({ type: 'patch_anomaly', patchId: id, count });
    const rollback = count >= this.rollbackAnomalyThreshold;
    if (rollback) this._events.push({ type: 'rollback_triggered', patchId: id, anomalies: count });
    return { rollback, anomalies: count };
  }

  events() { return this._events.map((e) => ({ ...e })); }

  _snapshot() {
    return {
      engineReadOnly: this._engineReadOnly,
      consecutiveSandboxFailures: this._consecutiveSandboxFailures,
      fusedBranches: Array.from(this._fusedBranches),
    };
  }
}

function _posInt(v, d) {
  return Number.isFinite(v) && v > 0 ? v : d;
}

module.exports = {
  EvoTrustBreaker,
  PROTECTED_INVARIANTS,
  DEFAULT_BRANCH_FUSE,
  DEFAULT_ENGINE_FUSE,
  DEFAULT_ROLLBACK_ANOMALIES,
};
