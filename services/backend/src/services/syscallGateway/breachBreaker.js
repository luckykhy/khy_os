'use strict';

/**
 * breachBreaker.js — 越权熔断器（**会话级，只内存**）。
 *
 * 监测两类越权信号，达阈即「跳闸」(trip)：
 *   ① 旁路注入：参数里夹带 `force:true` / `--yes` / `skipApproval` 等硬编码跳过审批的标记
 *      （来自 intentSchema.detectBypassMarkers）——**一次即跳闸**，零容忍。
 *   ② L2 反复硬闯：同一会话内被拒的 L2 请求累计达阈值（默认 3 次）——视为模型在试图
 *      磨穿红线，跳闸。
 *
 * 跳闸后果：
 *   - 整条流程标记为高危(highRisk)；
 *   - 此后所有调用一律 fail-closed 拒绝（连 L0 也不放——熔断优先于一切）；
 *   - 强制终止本会话登记在册的子进程（killer 可注入，便于离线测试，绝不误杀宿主/khy-os 自身）。
 *
 * 熔断不可在会话内自愈——只能随会话清零（reset），对齐「重启即归零」的最小权限语义。
 */

class BreachBreaker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.l2RetryThreshold=3] 被拒 L2 累计达此数跳闸
   * @param {(pid:number)=>void} [opts.killer]  终止子进程的注入点（默认 process.kill）
   * @param {(msg:string)=>void} [opts.onTrip]  跳闸回调（审计/告警）
   */
  constructor(opts = {}) {
    this._l2RetryThreshold = Number.isInteger(opts.l2RetryThreshold) && opts.l2RetryThreshold > 0
      ? opts.l2RetryThreshold : 3;
    this._killer = typeof opts.killer === 'function'
      ? opts.killer
      : (pid) => { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出/无权，忽略 */ } };
    this._onTrip = typeof opts.onTrip === 'function' ? opts.onTrip : () => {};
    this._tripped = false;
    this._tripReason = null;
    this._deniedL2 = 0;
    this._childPids = new Set();
    this._events = [];
  }

  get tripped() { return this._tripped; }
  get reason() { return this._tripReason; }

  /** 登记一个本会话产生的子进程 PID，供跳闸时清场。 */
  registerChild(pid) {
    if (Number.isInteger(pid) && pid > 0) this._childPids.add(pid);
  }

  /** 子进程正常退出，注销登记。 */
  unregisterChild(pid) { this._childPids.delete(pid); }

  /**
   * 上报一次旁路标记探测结果。markers 非空 → 立即跳闸（零容忍）。
   * @returns {boolean} 是否因此跳闸
   */
  reportBypass(markers) {
    if (Array.isArray(markers) && markers.length > 0) {
      this._trip(`检测到旁路注入标记: ${markers.join(', ')}`);
      return true;
    }
    return false;
  }

  /**
   * 上报一次被拒的 L2 请求。累计达阈值 → 跳闸。
   * @returns {boolean} 是否因此跳闸
   */
  reportDeniedL2() {
    this._deniedL2 += 1;
    if (this._deniedL2 >= this._l2RetryThreshold) {
      this._trip(`L2 高危请求被拒达 ${this._deniedL2} 次（阈值 ${this._l2RetryThreshold}），判定反复硬闯`);
      return true;
    }
    return false;
  }

  /** 熔断后该调用是否必须被拒。跳闸后恒为 true。 */
  shouldBlock() { return this._tripped; }

  _trip(reason) {
    if (this._tripped) return; // 已跳闸，幂等
    this._tripped = true;
    this._tripReason = reason;
    this._events.push(reason);
    // 清场：终止所有登记在册的子进程。killer 自身异常不得反噬熔断流程。
    for (const pid of this._childPids) {
      try { this._killer(pid); } catch { /* swallow */ }
    }
    this._childPids.clear();
    try { this._onTrip(reason); } catch { /* swallow */ }
  }

  /** 随会话清零；熔断状态不可在会话内自愈，只能整体重置。 */
  reset() {
    this._tripped = false;
    this._tripReason = null;
    this._deniedL2 = 0;
    this._childPids.clear();
    this._events = [];
  }
}

module.exports = { BreachBreaker };
