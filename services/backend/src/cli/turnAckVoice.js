'use strict';

/**
 * turnAckVoice — 纯叶子:khy 收到用户提示词后「先及时回应用户,再继续做事」的 turn 级即时确认。
 *
 * 背景(2026-07-05 用户反馈):khy 收到输入后直接静默进 runToolUseLoop 调模型,全程没有任何
 * 「先回应用户」的文本(现有 toolPrefaceVoice 全是**逐工具**、且在模型跑起来之后才出)。用户要 khy
 * 在**代码级**先甩一句确定性短句回应,**再**继续干活。
 *
 * 时序:提交那刻无法预知这轮会不会跑工具(那是模型决定的),故只在**本轮首个工具即将派发**且
 * **模型尚未自己出文本**时注入(honor 用户「仅跑工具/耗时的轮次出」的取舍;模型已先出文本=用户已被
 * 回应,不再叠加,避免模板领跑)。调用方负责「首工具 / 每轮至多一次 / sawText」的判定,本叶子只产句。
 *
 * 问候轮豁免(2026-08-20 用户反馈「已读乱回」):用户只说一句「你好」,模型自行决定先跑个 git status
 * 摸底,首工具派发触发 ack → 用户看到的第一句话是「明白,我先动手了。」。句子本身没说错(确有工具将跑),
 * 但它是**开工口吻**,而这一轮根本没有「工」——读起来就是答非所问。故产句前先看一眼用户原话:是纯问候
 * 就判空,让模型自己去回这句招呼。
 *   与 toolUseLoopCore._isPureFirstTurnGreeting(KHY_GREETING_NO_TOOLS,「首轮纯问候 → 零工具」)
 *   同源同判据(共用 textHeuristics.isGreeting),覆盖的是那条边界**够不到**的场景:非首轮的问候
 *   (有历史 → 那条边界按设计不介入 → 工具照跑 → ack 照出)。两者正交,不重复判定。
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
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_TURN_ACK', e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e.KHY_TURN_ACK;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 问候轮豁免子门:KHY_TURN_ACK_GREETING_SKIP(default-on,父门 KHY_TURN_ACK)。
 * 父门关则整体关(先判 isEnabled);子门单独 CANON 4 词({0,false,off,no})关 → 问候轮照旧出 ack
 * (逐字节回退到本次改动之前的行为)。flagRegistry 优先,本地 CANON 回退。绝不抛。
 */
function isGreetingSkipEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  if (!isEnabled(e)) {
    return false;
  } // 父门关 → 整体关
  try {
    const reg = require('../services/flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_TURN_ACK_GREETING_SKIP', e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e.KHY_TURN_ACK_GREETING_SKIP;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 纯问候判定 —— 直接走 textHeuristics.isGreeting 这个**单一真源**(「首轮纯问候 → 零工具」边界
 * 用的是同一个谓词),本叶子刻意不另起炉灶维护第二份问候词表:两处判据一旦漂移,同一句「你好」
 * 在两条路径上的行为就会打架。叶子不可用/异常 → false(照旧出 ack = 改动前行为)。绝不抛。
 */
function _isGreeting(text) {
  try {
    const { isGreeting } = require('../services/textHeuristics');
    return typeof isGreeting === 'function' && isGreeting(String(text || '').trim());
  } catch {
    return false;
  }
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
 *   { turnIndex, sawText, userText, env } →
 *     ''      门控关 / 模型已出文本(sawText:true) / 本轮用户只是打招呼 / 异常 → 不注入
 *     短句    否则按 turnIndex 轮换取一句
 * turnIndex 非有效整数时钉为 0(取首句)。
 * userText 缺省/空串 → 跳过问候判定,逐字节回退历史行为(调用方未接线时输出不变)。
 */
function computeTurnAck(opts) {
  try {
    const { turnIndex, sawText, userText, env } = opts || {};
    if (!isEnabled(env)) {
      return '';
    }
    if (sawText === true) {
      return '';
    }
    // 纯问候轮:让模型自己回这句「你好」,khy 不抢在前面说「我先动手了」。
    if (userText && isGreetingSkipEnabled(env) && _isGreeting(userText)) {
      return '';
    }
    const n = Number.isInteger(turnIndex) && turnIndex >= 0 ? turnIndex : 0;
    return _ACK_LINES[n % _ACK_LINES.length];
  } catch {
    return '';
  }
}

module.exports = {
  isEnabled,
  isGreetingSkipEnabled,
  computeTurnAck,
  _ACK_LINES,
};
