'use strict';

/**
 * entropyAssessor.js — 输入熵评估与三级坍缩路由（DESIGN-ARCH-036 §3.2）。
 *
 * 「万物结构化熔炉」的第一道闸：把一段无序自然语言量化为一个熵分，再据熵分
 * 决定该用哪一级坍缩协议。熵分越高 = 越混乱/越多依赖/越多矛盾，需要越重的
 * 结构化武器。
 *
 *   L0 降维打击   单任务、无依赖           → ActionIntent
 *   L1 意图织网   含时序/因果/条件依赖     → TaskGraph (DAG)
 *   L2 骨相重构   极长/矛盾/多主题混乱     → StateMachine
 *
 * 纯函数、零副作用、零依赖。所有判据来自显式词法标记 + 规模量纲，绝不调用模型，
 * 这样路由本身不烧 Token、可单测、可复现（防呆：路由器永不“脑补”）。
 */

// 因果/时序标记 → 一旦出现就至少 L1（依赖必须织成 DAG，防呆②）。
const CAUSAL_TEMPORAL_RE =
  /(如果|假如|若|一旦|否则|然后|接着|之后|随后|先|再|最后|等到|当.*?时|完成后|成功后|失败后)|\b(if|when|then|else|after|before|once|unless|while|until|otherwise)\b/i;

// 并列多动作标记 → 复合需求，倾向 L1。
const MULTI_ACTION_RE =
  /(并且|同时|以及|还要|另外|顺便|接下来|分别|；|;)|\b(and then|also|additionally|plus)\b/i;

// 矛盾/混乱标记 → 倾向 L2（须语义切片 + 矛盾标记）。
const CONTRADICTION_RE =
  /(但是|可是|不过|然而|矛盾|又要.*?又要|既要.*?又要|不想.*?但|算了|还是别|改主意|推翻)|\b(but|however|actually|nevermind|on second thought|contradict)\b/i;

// 编号列表（1. 2. / 一、二、 / - * 项目符号）→ 多步骤，至少 L1。
const ENUMERATION_RE = /(^|\n)\s*(\d+[.、)]|[一二三四五六七八九十]+[、.)]|[-*]\s)/;

/** 句子切分（中英标点）。空白/纯标点不计。 */
function _countSentences(text) {
  const parts = String(text)
    .split(/[。！？!?\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length || (text.trim() ? 1 : 0);
}

function _countMatches(re, text) {
  // 全局重扫一遍计频（构造全局副本，避免污染原带 i 标记的 RE 的 lastIndex）。
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let n = 0;
  while (g.exec(text) !== null) {
    n += 1;
    if (g.lastIndex === 0) break; // 防零宽匹配死循环
  }
  return n;
}

/**
 * 评估输入熵并给出坍缩级别。
 *
 * @param {string} raw
 * @returns {{
 *   entropy: number,           // 0..1 归一熵分
 *   level: 'L0'|'L1'|'L2',
 *   signals: {
 *     length: number, sentences: number,
 *     causal: number, multiAction: number, contradiction: number,
 *     enumerated: boolean,
 *   },
 * }}
 */
function assess(raw) {
  const text = String(raw || '');
  const length = text.length;
  const sentences = _countSentences(text);
  const causal = _countMatches(CAUSAL_TEMPORAL_RE, text);
  const multiAction = _countMatches(MULTI_ACTION_RE, text);
  const contradiction = _countMatches(CONTRADICTION_RE, text);
  const enumerated = ENUMERATION_RE.test(text);

  // 加权熵分（各量纲先饱和到 [0,1] 再加权，权重之和=1，结果天然落 [0,1]）。
  const sat = (x, k) => 1 - Math.exp(-x / k); // 单调饱和，越多越接近 1
  const entropy = Math.min(1,
    0.18 * sat(length, 160) +
    0.16 * sat(sentences - 1, 2) +
    0.24 * sat(causal, 1.2) +
    0.14 * sat(multiAction, 1.5) +
    0.20 * sat(contradiction, 1) +
    0.08 * (enumerated ? 1 : 0));

  // 级别判定：硬信号优先于纯熵分，保证“依赖必织网 / 矛盾必重构”不被规模稀释。
  let level = 'L0';
  const hasDependency = causal > 0 || enumerated || multiAction > 0 || sentences >= 3;
  const isChaotic = contradiction > 0 || length >= 400 || sentences >= 6 || entropy >= 0.6;

  if (isChaotic) level = 'L2';
  else if (hasDependency) level = 'L1';
  else level = 'L0';

  return {
    entropy: Number(entropy.toFixed(4)),
    level,
    signals: { length, sentences, causal, multiAction, contradiction, enumerated },
  };
}

/** 该输入是否含必须织成 DAG 的依赖（防呆②的判据，供织网器/校验器复用）。 */
function hasCausalDependency(raw) {
  const text = String(raw || '');
  return CAUSAL_TEMPORAL_RE.test(text) || MULTI_ACTION_RE.test(text) || ENUMERATION_RE.test(text);
}

module.exports = {
  assess,
  hasCausalDependency,
  // 暴露判据 RE 供坍缩器复用（单一真源，避免各模块各写一套词表）。
  CAUSAL_TEMPORAL_RE,
  MULTI_ACTION_RE,
  CONTRADICTION_RE,
  ENUMERATION_RE,
};
