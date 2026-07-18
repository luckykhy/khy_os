'use strict';

/**
 * resilience/deadLoopDetector.js — 死循环检测：连续相同调用 = 强制跳过。
 *
 * 模型最爱的"娇气 + 死缠"组合拳是：失败后既不换方法、也不换参数，原封不动再发一遍
 * （"让我再试一次"）。本检测器把"同一发子弹"用 callSignature 压成指纹后比对：
 *
 *   - inspect(tool, params)  记录本次签名并与**上一次已执行**的签名比对。若一致 → dead=true，
 *     执行器据此强制跳过该 Plan（绝不让同一调用连发两遍）。
 *   - 另外维护一个会话级计数表：同一签名出现过 ≥1 次再出现，也判 dead（跨非相邻位置的重复）。
 *
 * "只有在修复依赖或参数后方可重试" 由 changed(prev, next) 判定：新旧签名不同才算"真的换了"，
 * 否则视为同类死缠，拒绝那唯一一次重试。
 *
 * 纯内存、零副作用、绝不抛错。一个实例对应一次意图执行（或一个会话），用 reset() 复位。
 */

const { callSignature } = require('./errorSignature');

class DeadLoopDetector {
  constructor() {
    this._last = null;          // 上一次"已执行"调用的签名
    this._counts = new Map();   // 签名 → 出现次数
  }

  /**
   * 检视一次"即将执行"的调用：登记签名，并判断是否构成死循环。
   * @param {string} tool
   * @param {object} params
   * @returns {{ signature:string, dead:boolean, repeats:number, sameAsLast:boolean }}
   */
  inspect(tool, params = {}) {
    const signature = callSignature(tool, params);
    const sameAsLast = this._last !== null && this._last === signature;
    const prevCount = this._counts.get(signature) || 0;
    this._counts.set(signature, prevCount + 1);
    this._last = signature;
    return {
      signature,
      sameAsLast,
      repeats: prevCount + 1,
      // 与上一发完全相同，或此签名此前已出现过 → 死循环。
      dead: sameAsLast || prevCount >= 1,
    };
  }

  /**
   * 判断"修复后"的新调用相对旧调用是否**真的变了**（换了依赖/参数）。
   * 只有变了才允许那唯一一次重试；没变 = 同类死缠，拒绝。
   * @returns {boolean} true=变了（可重试一次）；false=没变（禁止重试）
   */
  changed(prevTool, prevParams, nextTool, nextParams) {
    return callSignature(prevTool, prevParams) !== callSignature(nextTool, nextParams);
  }

  /** 仅计算签名，不登记（供外部预判）。 */
  signature(tool, params = {}) {
    return callSignature(tool, params);
  }

  reset() {
    this._last = null;
    this._counts.clear();
  }
}

module.exports = { DeadLoopDetector };
