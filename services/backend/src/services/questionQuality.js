'use strict';

/**
 * questionQuality.js — 「提高 khy 提问质量 + 把推荐选项放到第一个」纯叶子(零 IO、零随机、绝不抛)。
 *
 * 诉求(goal 2026-07-03「提高 khy 的提问质量,并把推荐选项放到第一个」):
 *   AskUserQuestion 的「推荐选项应排第一」此前**只是系统提示里的一句话**(工具 prompt 第 26 行),
 *   没有任何代码强制;模型若把标了「(Recommended)/(推荐)」的选项放在非首位,TUI/REPL 会**照原序**
 *   渲染 → 推荐项错位。本叶子在工具 execute()(TUI 与 REPL 的**唯一必经点**)确定性地把带推荐
 *   标记的选项**提升到 index 0**,让「推荐第一」由代码保证而非全凭模型自觉。
 *
 * 契约:
 *   - `promoteRecommendedFirst(options)`:稳定提升——把**第一个**带推荐标记的选项移到队首,其余保持
 *     原相对序;无标记 → 返回**逐字节等价**(同引用不复制)。只认「括号包裹的 recommended/推荐」这类
 *     明确标记(半/全角括号),不误伤正文里恰好含 “recommended” 字样的选项。
 *   - `normalizeQuestions(questions, {env})`:对每张卡的 options 逐一提升;门控关或无标记 → 原样返回。
 *
 * 门控 KHY_QUESTION_RECOMMENDED_FIRST(默认开,值 ∈{0,false,off,no} 关)——沿用 questionCardModel.js
 * 同款 OFF_VALUES 语义,与近邻代码一致。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function _flagOn(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/** 门控:推荐项前置(默认开;仅显式 falsy 关 → 逐字节回退保留模型原序)。 */
function isRecommendedFirstEnabled(env = process.env) {
  return _flagOn(env && env.KHY_QUESTION_RECOMMENDED_FIRST);
}

// 明确的「推荐」标记:括号(半角/全角)包裹的 recommended / 推荐。刻意要求括号包裹,避免误伤
// 正文里恰好出现 “recommended settings” 之类的普通选项标签。
const _RECOMMENDED_MARKER_RE = /[（(]\s*(?:recommended|推荐)\s*[)）]/i;

function _optLabel(o) {
  if (typeof o === 'string') return o;
  return (o && (o.label || o.value)) ? String(o.label || o.value) : '';
}

/** 该选项是否带明确「推荐」标记。 */
function isRecommendedOption(option) {
  try {
    return _RECOMMENDED_MARKER_RE.test(_optLabel(option));
  } catch {
    return false;
  }
}

/**
 * 稳定提升:把第一个带推荐标记的选项移到队首,其余保持原相对序。
 * 无标记 / 已在首位 / 输入非数组 → 返回**原引用**(逐字节等价,零复制)。绝不抛。
 * @param {Array} options
 * @returns {Array}
 */
function promoteRecommendedFirst(options) {
  if (!Array.isArray(options) || options.length < 2) return options;
  try {
    let idx = -1;
    for (let i = 0; i < options.length; i++) {
      if (isRecommendedOption(options[i])) { idx = i; break; }
    }
    if (idx <= 0) return options; // 无标记或已在首位 → 原样(不复制)
    const reordered = options.slice();
    const [rec] = reordered.splice(idx, 1);
    reordered.unshift(rec);
    return reordered;
  } catch {
    return options; // fail-soft:任何异常都退回原序
  }
}

/**
 * 对整组 questions 逐卡提升 options 的推荐项。门控关 → 原样返回(同引用)。
 * 仅当至少一张卡实际发生重排时才产出新数组;否则返回原引用(逐字节等价)。绝不抛。
 * @param {Array} questions
 * @param {{env?:object}} [opts]
 * @returns {Array}
 */
function normalizeQuestions(questions, opts = {}) {
  const env = (opts && opts.env) || process.env;
  if (!isRecommendedFirstEnabled(env)) return questions;
  if (!Array.isArray(questions) || questions.length === 0) return questions;
  try {
    let changed = false;
    const out = questions.map((q) => {
      if (!q || !Array.isArray(q.options)) return q;
      const promoted = promoteRecommendedFirst(q.options);
      if (promoted === q.options) return q; // 未重排 → 同引用
      changed = true;
      return { ...q, options: promoted };
    });
    return changed ? out : questions;
  } catch {
    return questions;
  }
}

module.exports = {
  OFF_VALUES,
  isRecommendedFirstEnabled,
  isRecommendedOption,
  promoteRecommendedFirst,
  normalizeQuestions,
  _RECOMMENDED_MARKER_RE,
};
