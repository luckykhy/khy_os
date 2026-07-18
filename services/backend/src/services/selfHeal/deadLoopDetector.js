'use strict';

/**
 * selfHeal/deadLoopDetector.js — 处方级死循环熔断器（PrescriptionDeadLoopDetector）。
 *
 * 与 resilience/deadLoopDetector.js 互补但**职责不同**：
 *   - resilience 那个是「调用签名」级——同一 (tool, params) 原地重发即判死，护的是"重试"。
 *   - 本模块是「修复处方」级——同一条修复处方（如 `install-dependency:puppeteer`）被重复开具
 *     即判无效，护的是"修复"。对应 Goal3 防呆：
 *       「修复处方与上次执行命令一致 → 判修复无效 → 中断微循环走降级」。
 *
 * 处方签名 = `${fixKind}:${稳定化(capture)}`，与具体工具/参数无关——这样即便在降级树里
 * 换了工具（WebBrowser→WebFetch），只要开出的还是同一条修复处方，依旧会被熔断。
 *
 * 纯内存、零依赖、绝不抛错。生命周期 = 一次 FallbackTreeWithHeal 运行（跨多个降级 Plan 共享）。
 */

class PrescriptionDeadLoopDetector {
  constructor() {
    /** @type {Set<string>} 已开具过的处方签名 */
    this._issued = new Set();
    /** @type {Map<string, number>} 处方 → 出现次数 */
    this._counts = new Map();
    this._lastSignature = null;
  }

  /**
   * 计算一条诊断的处方签名（稳定、与工具无关）。
   * @param {object} diagnosis  ErrorDiagnostician.diagnose 的产物
   * @returns {string}
   */
  signature(diagnosis) {
    if (!diagnosis || !diagnosis.fixKind) return 'none:none';
    const cap = diagnosis.capture || {};
    // 只取决定"命令身份"的受控字段，保证同一处方稳定同签名。
    const key = cap.dep
      || (cap.candidates && cap.candidates.length ? `${cap.command || ''}->${cap.candidates[0]}` : '')
      || (cap.command || '')
      || (cap.hostPort && cap.hostPort.port ? `${cap.hostPort.host || ''}:${cap.hostPort.port}` : '')
      || (cap.path || '')
      || '∅';
    return `${diagnosis.fixKind}:${key}`;
  }

  /**
   * 检查：这条处方是否已开过（重复 = 死循环，应中断微循环转降级）。
   * **只读**，不改状态——确认要真正执行修复时才调 record()。
   * @param {object} diagnosis
   * @returns {{ signature:string, dead:boolean, repeats:number, sameAsLast:boolean }}
   */
  check(diagnosis) {
    const signature = this.signature(diagnosis);
    const repeats = this._counts.get(signature) || 0;
    return {
      signature,
      dead: this._issued.has(signature),
      repeats,
      sameAsLast: this._lastSignature === signature,
    };
  }

  /**
   * 登记一条已真正开具/执行的处方。返回登记后的统计。
   * @param {object} diagnosis
   */
  record(diagnosis) {
    const signature = this.signature(diagnosis);
    this._issued.add(signature);
    this._counts.set(signature, (this._counts.get(signature) || 0) + 1);
    this._lastSignature = signature;
    return { signature, repeats: this._counts.get(signature) };
  }

  reset() {
    this._issued.clear();
    this._counts.clear();
    this._lastSignature = null;
  }
}

module.exports = { PrescriptionDeadLoopDetector };
