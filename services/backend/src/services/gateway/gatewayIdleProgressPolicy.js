'use strict';

/**
 * gatewayIdleProgressPolicy — 纯叶子:决定「网关 idle 看门狗」是否应把某次心跳
 * 计为"活动"从而**重置 idle 计时**。
 *
 * 排障根因(「khy 执行到一半卡住、转圈还在转、无法打断/无法自愈」的第四个根因):
 *   aiGatewayGenerateMethod 有一个 idle 看门狗:若 `gatewayIdleMs` 内网关"无活动"
 *   就 abort 当前请求兜底卡死。但"活动"的判定被**网关自己制造的心跳污染**了——
 *   适配器脉冲(startAdapterPulse 每 ~4s 发一条「已耗时 Xs」)和 idle 预警本身
 *   都会走 emitActivity → _touchGatewayActivity() → 重置 `_gatewayLastActivityAt`。
 *   于是"网关自言自语"被当成"有进展",`idleMs >= gatewayIdleMs` **永远不成立**,
 *   看门狗被自己的状态输出**永久重置**,兜底彻底失效。真正卡死(上游零 token、
 *   零适配器输出)时,用户只能看着转圈,既无法打断(见 abortRaceArm 三修)也无法自愈。
 *
 *   修正:区分**真实推进**(适配器 onChunk 的模型 token、真正的 assistant 内容)
 *   与**网关自造心跳**(状态行、脉冲计时、idle 预警)。只有真实推进才重置 idle;
 *   网关自言自语不再续命。这样真实卡死能在 `gatewayIdleMs` 内被兜底 abort,
 *   而慢任务(仍在吐 token / 有适配器输出)绝不会被误杀。
 *
 * 设计红线:
 *   - 纯函数、零 IO、**绝不抛**(异常 → 保守回退今日行为:重置 idle);
 *   - 无第三方依赖、无适配器名字面量;
 *   - 与 C(abortRaceArm 让 await 必返)**互补**:C 管"用户要打断",本叶子管
 *     "用户不管时系统自愈"。
 *
 * 门控 KHY_GATEWAY_IDLE_PROGRESS_ONLY(默认开;0/false/off/no → 关)。
 * 关门 → `shouldResetIdle` 恒返回 true → 逐字节回退今日「任何心跳(含网关自造)
 * 都重置 idle」的行为(即看门狗仍会被自身输出续命,与修复前完全等价)。
 */

const GATE_FLAG = 'KHY_GATEWAY_IDLE_PROGRESS_ONLY';

// 环境布尔门:缺省 / 空 → dflt;0/false/off/no → false。异常 → false。
// 收敛到 utils/onValueOr 单一真源(逐字节委托,调用点不变)
const _envOn = require('../../utils/onValueOr');

/**
 * 门控 KHY_GATEWAY_IDLE_PROGRESS_ONLY:默认开;0/false/off/no → 关。异常 → 关门(false)。
 * 关门表示「不启用本策略」→ 任何心跳都重置 idle(今日行为)。
 * @param {object} [env]
 * @returns {boolean}
 */
function idleProgressOnlyEnabled(env = process.env) {
  return _envOn(env && env[GATE_FLAG], true);
}

/**
 * 判定某次网关心跳是否应重置 idle 看门狗。纯函数、绝不抛。
 *
 * @param {boolean} isRealProgress
 *   true  = 真实推进(适配器模型 token / 真正 assistant 内容);
 *   false = 网关自造心跳(状态行 / 脉冲计时 / idle 预警)。
 * @param {object} [env]
 * @returns {boolean}
 *   true  = 应重置 idle(续命);
 *   false = 不重置(让看门狗继续逼近 gatewayIdleMs)。
 *
 *   语义:
 *   - 门关 → 恒 true(逐字节回退:任何心跳都续命);
 *   - 门开 + 真实推进 → true(慢任务不误杀);
 *   - 门开 + 网关自言自语 → false(卡死可被兜底 abort)。
 */
function shouldResetIdle(isRealProgress, env = process.env) {
  try {
    if (!idleProgressOnlyEnabled(env)) return true;
    return isRealProgress === true;
  } catch {
    // 保守:异常 → 回退今日行为(重置 idle),绝不因本叶子引入新的卡死。
    return true;
  }
}

module.exports = {
  shouldResetIdle,
  idleProgressOnlyEnabled,
  GATE_FLAG,
};
