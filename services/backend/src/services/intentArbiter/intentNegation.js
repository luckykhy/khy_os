'use strict';

/**
 * intentNegation.js — 纯叶子:意图光谱评分的「否定语境检测」单一真源(P0#1)。
 *
 * 背景(诚实记录现状 / 为什么需要本叶子):
 *   - 否定词(`别执行`/`不要执行`)历史上只存在于 intentLexicon 的 FALSE_TRIGGER_SIGNALS,
 *     且**仅被 misjudgmentQuencher 事后消费**;首遍打分 intentSpectrumAnalyzer._score
 *     对「不要执行这个」与「执行这个」给完全相同的置信度(都靠 _hits 子串命中 `执行`)。
 *   - 否定语境在第一遍评分里完全不存在 —— 这是本叶子要补的缺口。
 *
 * 设计取舍(批判性):**绝不**用 `\b执行\b` 词边界正则——`\b` 对 CJK 无意义(中文字符间
 *   无词边界),会破坏现有匹配。改用**高精度邻接判据**:
 *     - 前向否定:否定词 marker 紧贴动词左侧(`不要执行`/`别执行`/`不执行`)。
 *     - 后向情态:无能/失败 modal 紧贴动词右侧(`执行不了`/`执行失败`)。
 *   严格邻接(slice === marker)杜绝 `不仅/不但/不光` 这类让步词误伤(它们不在 marker 表,
 *   且裸 `不` 在 `不仅执行` 中不与 `执行` 邻接)。逐次出现扫描:只要存在一次非否定出现,
 *   该动词即「主动」(保 `别执行A但执行B` 仍算有命令)。
 *
 * 纯叶子契约:零 IO、确定性、绝不抛、可单测。env 由调用方注入(不在叶子内读 process.env)。
 * 门控 KHY_INTENT_NEGATION 默认开;关 → selectNegatedVerbs 返回 [](字节回退:评分等价历史)。
 */

const FALSY = new Set(['0', 'false', 'off', 'no']);

/** 否定子门控(默认开;{0,false,off,no} 关闭)。 */
function isEnabled(env) {
  const e = env && typeof env === 'object' ? env : {};
  const raw = e.KHY_INTENT_NEGATION;
  if (raw === undefined || raw === null || raw === '') return true;
  return !FALSY.has(String(raw).trim().toLowerCase());
}

/**
 * 单次出现是否处于否定语境(高精度邻接判据)。纯字符串运算,容错。
 * @param {string} text   原文
 * @param {string} verb   动词
 * @param {number} idx    本次出现的起始下标
 * @param {string[]} markers 前向否定词(紧贴动词左侧)
 * @param {string[]} modals  后向无能/失败情态(紧贴动词右侧)
 * @returns {boolean}
 */
function _occurrenceNegated(text, verb, idx, markers, modals) {
  // 前向:某 marker 紧贴动词左侧。
  for (const m of markers) {
    if (idx >= m.length && text.slice(idx - m.length, idx) === m) return true;
  }
  // 后向:某 modal 紧贴动词右侧。
  const after = idx + verb.length;
  for (const md of modals) {
    if (text.slice(after, after + md.length) === md) return true;
  }
  return false;
}

/**
 * 从 verbs 中挑出「每一次出现都处于否定语境」的动词(即不存在任何主动出现)。
 * 门控关 → 返回 [](字节回退)。
 *
 * @param {string} text     原文
 * @param {string[]} verbs  候选动词(通常是命中的特权动词)
 * @param {object} [env]    环境(门控 + 词表注入点,默认读 intentLexicon 的 markers/modals)
 * @param {object} [lexicon] 可注入词表 {markers, modals};缺省由调用方传 lexicon 常量
 * @returns {string[]} 被完全否定的动词子集
 */
function selectNegatedVerbs(text, verbs, env, lexicon) {
  if (!isEnabled(env)) return [];
  if (typeof text !== 'string' || !text) return [];
  if (!Array.isArray(verbs) || verbs.length === 0) return [];

  const lex = lexicon && typeof lexicon === 'object' ? lexicon : {};
  const markers = Array.isArray(lex.markers) ? lex.markers : [];
  const modals = Array.isArray(lex.modals) ? lex.modals : [];
  if (markers.length === 0 && modals.length === 0) return [];

  const negated = [];
  for (const verb of verbs) {
    if (typeof verb !== 'string' || !verb) continue;
    let hasActive = false;
    let idx = text.indexOf(verb);
    if (idx === -1) continue; // 未实际出现 → 不判定
    while (idx !== -1) {
      if (!_occurrenceNegated(text, verb, idx, markers, modals)) { hasActive = true; break; }
      idx = text.indexOf(verb, idx + 1);
    }
    if (!hasActive) negated.push(verb);
  }
  return negated;
}

module.exports = {
  isEnabled,
  selectNegatedVerbs,
  _occurrenceNegated,
};
