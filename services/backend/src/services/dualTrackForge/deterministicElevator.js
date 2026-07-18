'use strict';

/**
 * deterministicElevator.js — 确定性升维轨（§3.2 主干 / 保底）。
 *
 * 物理断言一旦判出硬伤，**必须强制**通过纯代码查表生成「保底需求」——零模型依赖、永远
 * 可产出。这是「模型宕机仍能持续把 Bug 转化为需求」的根基：升维只读 `physicalCodes` 单源
 * 的确定性映射，经 `evoRequirement.forge` 凝固成一份合法 EvoRequirement，交下游消费。
 *
 * 防呆③：本轨与模型无关、同步完成，门面据此保证「先发保底需求、模型解释只作后续补充」。
 * level 被映射表 `intendedLevel` 锁定在 L0/L1（测试断言 forge 实得级 === intendedLevel），
 * 防 classify 漂移把保底需求误升 L2。
 */

const evoRequirement = require('../evoEngine/evoRequirement');
const { mappingFor } = require('./physicalCodes');

class DeterministicElevator {
  /**
   * 把一个物理异常确定性升维为保底需求。
   * @param {{code:string, finding:string, detail?:object}} physical  PhysicalException（或其结构）
   * @returns {{requirement:object, code:string, finding:string, action:string, priority:string, intendedLevel:string}}
   */
  elevate(physical) {
    if (!physical || !physical.code) {
      throw new Error('DeterministicElevator.elevate: 需要带 code 的 PhysicalException');
    }
    const m = mappingFor(physical.code);
    if (!m) {
      throw new Error(`DeterministicElevator.elevate: 未知物理码 ${physical.code}`);
    }

    const surface = String((physical.detail && (physical.detail.surface || physical.detail.toolName)) || physical.code);
    const painPoint = `${physical.finding || physical.code}`;

    const requirement = evoRequirement.forge({
      signal: m.signal,
      painPoint,
      attribution: { kind: 'physical-assertion', why: m.why, surface },
      impact: `物理断言判定的硬伤（${physical.code}）：${m.action}。`,
      proposedModules: m.proposedModules,
      acceptanceCriteria: [`消除 ${physical.code} 类硬伤且不引入退化`, `${m.action} 后同类输入不再触发物理断言`],
    });

    return {
      requirement,
      code: physical.code,
      finding: `${physical.code}: ${physical.finding || m.action}`,
      action: m.action,
      priority: m.priority,
      intendedLevel: m.intendedLevel,
    };
  }
}

module.exports = { DeterministicElevator };
