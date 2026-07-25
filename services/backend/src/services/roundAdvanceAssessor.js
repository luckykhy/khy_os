'use strict';

// [AI-弱模型·照抄] 本文件是纯叶子:改动照 planModeDirective.js / goalStopGate.js 的形状——
//   _isEnabled 委托 flagRegistry(注册表异常/关时逐字节回退 OFF_VALUES 手写判定);判定全在叶子、
//   零 I/O、确定性(无时钟/随机)、绝不抛、门关返 null;接线(toolUseLoop 每轮小结处)只做 IO、
//   包一层 try/catch fail-soft。别把评估逻辑写进接线处、别漏 try/catch、别让叶子抛、别让本判决
//   改变循环控制流(它只观测、不决策——纯粹给「这一轮值不值」一个确定性标签)。

/**
 * roundAdvanceAssessor.js — 纯叶子:以「本轮任务是否向前推动了一步」衡量该轮对话的必要性与价值。
 *
 * 诉求(goal 2026-07-06「khy 应该以每轮对话后任务是否向前推动了一步,来衡量该轮对话的必要性与
 * 价值」):toolUseLoop 每完成一轮(模型回应 + 工具执行)后,已经算出该轮的成功/失败/去重/读写命令
 * 分项(emitIterationSummary 的 payload)。本叶子吃这些**已有信号**,确定性地判一个判决——
 * 这一轮是否让任务真的前进了一步(advanced),据此给出必要性(necessary)与价值档位(value),
 * 以及一句人话理由 + 一个紧凑标签(供每轮小结行渲染)。
 *
 * 与既有件的关系(不重复造):
 *  - toolLoopDetector.noProgress —— 逐**工具调用**的输出同一性(same tool+params+result 连击),
 *    是机械重复检测;本叶子是逐**轮**的任务级推进判决,吃前者的去重信号但站在更高层。
 *  - consecutiveDedupIterations(toolUseLoop)—— 全去重轮的优雅退出;本叶子把「全去重 = 停滞」
 *    这一判断显式化成人可读判决,但**不夺取控制流**(退出仍由既有逻辑负责)。
 *  - intentCoverage / deliverableClosure —— 在**收尾**(模型声称做完)时评估;本叶子在**每一个
 *    有工具执行的轮次**结束时评估,二者互补(过程 vs 收尾)。
 *
 * 判决(纯启发式,顺序即优先级),输入取自每轮小结已算好的分项:
 *   1. 全部命中去重缓存(allDeduped)         → 停滞(stalled),重复了已完成操作,未推进。
 *   2. 无任何**新**成功(newSuccess<=0):
 *        有失败                                → 空转(unproductive),消耗预算未产出可用结果。
 *        否则(只有去重/无实质动作)            → 停滞(stalled)。
 *   3. 有新成功(newSuccess>0):
 *        产生状态变更(改动/执行/委派)          → 推进(advanced)· 价值 high。
 *        获取新信息(读取/搜索)                → 推进(advanced)· 价值 medium。
 *        其余成功                              → 推进(advanced)· 价值 medium。
 * newSuccess = 成功数 − 去重数(去重的「成功」是重放旧结果,不算新推进)。
 *
 * 契约:纯叶子——零 I/O、确定性、绝不抛(fail-soft)。
 *
 * 门控(dogfood flagRegistry):
 *   KHY_ROUND_ADVANCE_ASSESS  默认 on——每轮推进判决总开关。
 *     关 ⇒ assessRoundAdvance 恒返 null(caller 不给小结附 advance 字段、逐字节回退到无判决的旧小结)。
 *
 * @module services/roundAdvanceAssessor
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

const _isEnabled = require('../utils/isEnabledDefaultOn');

/** 每轮推进判决总开关。默认 on。 */
function isRoundAdvanceEnabled(env) {
  return _isEnabled('KHY_ROUND_ADVANCE_ASSESS', env);
}

// 判决种类(单一真源·冻结)。label = 每轮小结行的紧凑标签;necessary/value = 必要性与价值档位。
const VERDICTS = Object.freeze({
  advanced: Object.freeze({ verdict: 'advanced', label: '推进', necessary: true }),
  stalled: Object.freeze({ verdict: 'stalled', label: '停滞', necessary: false }),
  unproductive: Object.freeze({ verdict: 'unproductive', label: '空转', necessary: false }),
});

// 有限数强转家族单一真源 utils/finiteNumber(见 finiteNumber.js)。
const _num = require('../utils/finiteNumber').toPositiveOr0;

/**
 * 评估一轮的任务推进情况。纯函数,绝不抛;门关或无可评估 → null。
 *
 * @param {object} signals 每轮小结已算好的分项:
 *   total, succeeded, failed, denied, deduped(数字);
 *   breakdown {reads, searches, writes, commands, agents}(数字);
 *   modifiedFiles(string[]);
 * @param {object} [env]
 * @returns {{advanced:boolean, verdict:string, value:string, necessary:boolean, label:string, reason:string}|null}
 */
function assessRoundAdvance(signals, env) {
  try {
    if (!isRoundAdvanceEnabled(env)) return null;
    if (!signals || typeof signals !== 'object') return null;

    const total = _num(signals.total);
    if (total <= 0) return null; // 无工具执行的轮次不在本叶子评估范围(收尾类由 intentCoverage 管)

    const succeeded = _num(signals.succeeded);
    const failed = _num(signals.failed);
    const deduped = _num(signals.deduped);
    const b = (signals.breakdown && typeof signals.breakdown === 'object') ? signals.breakdown : {};
    const reads = _num(b.reads);
    const searches = _num(b.searches);
    const writes = _num(b.writes);
    const commands = _num(b.commands);
    const agents = _num(b.agents);
    const modified = Array.isArray(signals.modifiedFiles) ? signals.modifiedFiles.filter(Boolean).length : 0;

    const newSuccess = Math.max(0, succeeded - deduped); // 去重的成功是重放旧结果,不计新推进
    const mutated = (writes + commands + agents) > 0 || modified > 0;
    const gathered = (reads + searches) > 0;
    const allDeduped = deduped > 0 && deduped >= total;

    // 1) 全去重 → 停滞
    if (allDeduped) {
      return _finish(VERDICTS.stalled, 'low',
        `本轮 ${total} 次工具调用全部命中去重缓存,重复了已完成的操作,任务未向前推进——该轮价值低。`);
    }
    // 2) 无新成功
    if (newSuccess <= 0) {
      if (failed > 0) {
        return _finish(VERDICTS.unproductive, 'low',
          `本轮工具调用未产出新的成功结果(${failed} 次失败),消耗了预算却未推进任务——该轮价值低。`);
      }
      return _finish(VERDICTS.stalled, 'low',
        '本轮没有产生新的实质动作(仅重复/无有效产出),任务未向前推进——该轮价值低。');
    }
    // 3) 有新成功 → 推进(状态变更价值最高,其次是新信息)
    if (mutated) {
      return _finish(VERDICTS.advanced, 'high',
        `本轮产生了状态变更(改动/执行/委派,${newSuccess} 项新成功),任务向前推进了一步——该轮必要且高价值。`);
    }
    if (gathered) {
      return _finish(VERDICTS.advanced, 'medium',
        `本轮获取了新信息(读取/搜索,${newSuccess} 项新成功),对任务的理解向前推进了一步——该轮有价值。`);
    }
    return _finish(VERDICTS.advanced, 'medium',
      `本轮有 ${newSuccess} 项新的成功工具调用,任务向前推进——该轮有价值。`);
  } catch {
    return null; // fail-soft:判决绝不反噬主循环,失败即等价于「无判决」
  }
}

function _finish(kind, value, reason) {
  return {
    advanced: kind.verdict === 'advanced',
    verdict: kind.verdict,
    value,
    necessary: kind.necessary,
    label: kind.label,
    reason,
  };
}

module.exports = {
  isRoundAdvanceEnabled,
  assessRoundAdvance,
  VERDICTS,
};
