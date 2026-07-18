'use strict';

/**
 * ghostValueAnnotator.js — 幽灵值注记器（§3.2 幽灵注记 / 防呆②）。
 *
 * 主权裁决产生「唯一权威值」时，落败的数据并不被粗暴丢弃——若其出身为 P3 及以上阶层
 * （模型推理 / 工具返回 / 用户被更高铁律压制的指令），它被降维成一枚**只读幽灵**
 * `ghost_value` 随参数下发，让模型得以反思「我的推理为何被否决」。
 *
 * 但幽灵**绝无权限**参与逻辑流转（防呆②硬边界）。本注记器用两道物理屏障保证这一点：
 *   1. 幽灵对象被 `Object.freeze` 冻结，且打上不可伪造的 `__ghost` 标记；
 *   2. 幽灵与权威参数**物理分桶**下发——权威参数字典里**绝不**混入任何幽灵对象。
 *      `sanitizeForExecution` 在注入前再做一次泄漏断言：任一幽灵渗入执行参数即抛
 *      `GhostPollutionError`，把「模型偷用落败值跑逻辑」挡在编译期之外。
 *
 * 纯函数 + 不可变。不调模型、不做 I/O。
 */

const { rankOf, labelOf, isGhostable } = require('./sovereigntyTiers');

const GHOST_MARK = '__ghost';

class GhostPollutionError extends Error {
  constructor(param) {
    super(`幽灵污染：参数 "${param}" 的执行值是只读 ghost_value，绝无权限参与逻辑流转（防呆②）`);
    this.name = 'GhostPollutionError';
    this.code = 'ERR_GHOST_POLLUTION';
    this.param = param;
  }
}

class GhostValueAnnotator {
  /**
   * 把一份落败数据注记为只读幽灵。
   * @param {object} defeated  落败声明 { param, value, source, tier }
   * @param {object} winner    胜出声明 { source, tier }（记录「被谁否决」供模型溯因）
   * @returns {Readonly<object>} 冻结的幽灵对象
   */
  annotate(defeated, winner = {}) {
    const ghost = {
      [GHOST_MARK]: true,
      param: String(defeated.param),
      ghost_value: defeated.value,                    // 仅供模型只读反思，不可入逻辑
      source: String(defeated.source || 'unknown'),
      tier: defeated.tier,
      tierLabel: labelOf(defeated.tier),
      reason: `被更高主权阶层 ${winner.tier || '?'}(${labelOf(winner.tier)}) 否决——保留供模型反思，不参与执行`,
      overriddenBy: { source: winner.source, tier: winner.tier },
      readOnly: true,
    };
    return Object.freeze(ghost);
  }

  /** 该阶层的落败数据是否应留存为幽灵（P3 及以上，防呆②）。 */
  shouldDemote(tier) {
    return isGhostable(tier);
  }

  /** 判定任意值是否为本注记器产出的幽灵（标记不可伪造地随对象冻结）。 */
  isGhost(x) {
    return !!(x && typeof x === 'object' && x[GHOST_MARK] === true);
  }

  /**
   * 把一组落败声明按 param 分桶为「幽灵袋」。仅 P3 及以上阶层落败者入袋（防呆②）；
   * P4 默认值落败属噪音，静默丢弃不挂幽灵。
   * @param {Array<{param,value,source,tier}>} defeatedList
   * @param {object} winnerByParam  { param: {source, tier} }
   * @returns {Object<string, Array<Readonly<object>>>}
   */
  buildGhostBag(defeatedList, winnerByParam = {}) {
    const bag = {};
    for (const d of defeatedList) {
      if (!this.shouldDemote(d.tier)) continue;
      const param = String(d.param);
      (bag[param] || (bag[param] = [])).push(this.annotate(d, winnerByParam[param] || {}));
    }
    return bag;
  }

  /**
   * 极权注入前的最后一道闸门（防呆②）：断言权威参数字典里**没有任何幽灵渗入**。
   * 业务函数只能拿到这份纯净的权威值；幽灵必须经独立通道下发，绝不混入执行流。
   * @param {Object<string, any>} params  待注入的权威参数字典
   * @returns {Readonly<object>} 冻结的纯净参数（确认无幽灵后）
   */
  sanitizeForExecution(params = {}) {
    for (const [param, value] of Object.entries(params)) {
      if (this.isGhost(value)) {
        throw new GhostPollutionError(param);
      }
    }
    return Object.freeze({ ...params });
  }
}

module.exports = { GhostValueAnnotator, GhostPollutionError, GHOST_MARK };
