'use strict';

/**
 * turnAckVoice — 纯叶子:khy 收到用户提示词后「先及时回应用户，再继续做事」的 turn 级即时确认。
 *
 * 背景(2026-07-05 用户反馈):khy 收到输入后直接静默进 runToolUseLoop 调模型，全程没有任何
 * 「先回应用户」的文本(现有 toolPrefaceVoice 全是**逐工具**、且在模型跑起来之后才出)。用户要 khy
 * 在**代码级**先甩一句确定性短句回应，**再**继续干活。
 *
 * 时序:提交那刻无法预知这轮会不会跑工具(那是模型决定的),故只在**本轮首个工具即将派发**且
 * **模型尚未自己出文本**时注入(honor 用户「仅跑工具/耗时的轮次出」的取舍;模型已先出文本=用户已被
 * 回应,不再叠加,避免模板领跑)。调用方负责「首工具 / 每轮至多一次 / sawText」的判定,本叶子只产句。
 *
 * 契约:纯函数、零 IO、确定性(无随机·按 turnIndex 轮换)、绝不抛(异常 → '')。门控 KHY_TURN_ACK
 * 默认开,仅 CANON 4 词({0,false,off,no})关 → 逐字节回退到「无 ack」。flagRegistry 优先,本地回退。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_TURN_ACK 默认开,仅 {0,false,off,no} 关。flagRegistry 优先,本地 CANON 回退。 */
function isEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  try {
    const reg = require('../services/flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_TURN_ACK', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_TURN_ACK;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// 短确认句(纯中文、单行、不复述用户原话)。按 turnIndex 轮换,避免每轮字面重复(治单调)。
// ≥2 条即保证相邻两轮不同;满一轮才回头。措辞刻意口语、各异,不带工具意图(那是逐工具 preface 的事)。
const _ACK_LINES = [
  '收到，我来处理。',
  '好的，这就开始。',
  '明白，我先动手了。',
  '收到，马上安排。',
  '好，我来看看怎么弄。',
];

/**
 * 产出本轮的即时确认句。
 *   { turnIndex, sawText, env } →
 *     ''      门控关 / 模型已出文本(sawText:true) / 异常 → 不注入(逐字节回退无 ack)
 *     短句    否则按 turnIndex 轮换取一句
 * turnIndex 非有效整数时钉为 0(取首句)。
 */
function computeTurnAck(opts) {
  try {
    const { turnIndex, sawText, env } = opts || {};
    if (!isEnabled(env)) return '';
    if (sawText === true) return '';
    const n = (Number.isInteger(turnIndex) && turnIndex >= 0) ? turnIndex : 0;
    return _ACK_LINES[n % _ACK_LINES.length];
  } catch {
    return '';
  }
}

module.exports = {
  isEnabled,
  computeTurnAck,
  _ACK_LINES,
};
