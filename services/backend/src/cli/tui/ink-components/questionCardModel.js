'use strict';

/**
 * questionCardModel.js
 *
 * 纯逻辑单一真源,供 QuestionPrompt(ink 组件)消费 —— 把「选项卡」交互里所有**确定性**
 * 的决策抽离成无副作用函数,便于单测,且让组件保持薄。
 *
 * 这里实现新增的两个能力(对齐目标「体察人的惰性」):
 *  1) 每张卡在真实选项之后,确定性地追加**「可讨论」**行(用户「这一点想再聊聊 / 由你
 *     来定」的出口)与**「自由输入(Other)」**行 —— 即便模型忘了给,这两个出口也始终在。
 *  2) **多张卡可左右切换**(环绕索引);卡内**上下选择**(环绕光标)。配合组件里「每张卡
 *     独立持久状态」,左右来回切换不丢已选。
 *
 * 行布局(自上而下):
 *   [0 .. optionsLen-1]  真实选项
 *   [discussRow = optionsLen]      「可讨论」
 *   [otherRow   = optionsLen + 1]  「自由输入(Other)」
 *   rowCount = optionsLen + 2
 */

const DISCUSS_LABEL = '可讨论';
const DISCUSS_HINT = '这一点想再聊聊 / 由你来定';
const OTHER_LABEL = 'Other (free input)';

// 门控:沿用 liveRegionBudget/caretGeometry 同 OFF_VALUES 语义(显式 falsy 关,其余含 unset 开)。
const OFF_VALUES = ['0', 'false', 'off', 'no'];
function _flagOn(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/** Fix 2 — 自由输入(Other)左右移动光标默认开;仅显式 falsy 关(→ 行尾追加/退格 legacy)。 */
function questionTextCursorEnabled(env = process.env) {
  return _flagOn(env && env.KHY_QUESTION_TEXT_CURSOR);
}

/** Fix 3 — 单选卡按 Space 临时提升为多选默认开;仅显式 falsy 关(→ 单选立即提交 legacy)。 */
function questionMultipickEnabled(env = process.env) {
  return _flagOn(env && env.KHY_QUESTION_MULTIPICK);
}

/**
 * 有效多选:模型显式声明 multiSelect 恒多选;否则仅当门控开且用户已按 Space 提升(promoted)
 * 才多选。缺省(promoted 全 false)→ 与今日单选行为逐字节一致。
 * @param {{ multiSelect?:boolean, promoted?:boolean, env?:object }} p
 * @returns {boolean}
 */
function effectiveMulti({ multiSelect = false, promoted = false, env = process.env } = {}) {
  return !!multiSelect || (questionMultipickEnabled(env) && !!promoted);
}

function optLabel(o) {
  if (typeof o === 'string') return o;
  return (o && (o.label || o.value)) || String(o);
}
function optDesc(o) {
  return (o && typeof o === 'object' && o.description) ? String(o.description) : '';
}
function optPreview(o) {
  return (o && typeof o === 'object' && o.preview) ? String(o.preview) : '';
}

/**
 * 行布局:真实选项 + 可讨论 + 自由输入。
 * @param {number} optionsLen
 * @returns {{discussRow:number, otherRow:number, rowCount:number}}
 */
function rowLayout(optionsLen) {
  const n = Math.max(0, Number(optionsLen) || 0);
  return { discussRow: n, otherRow: n + 1, rowCount: n + 2 };
}

/** 环绕步进(用于卡片左右切换 / 卡内上下光标)。count<=0 时恒定返回 0。 */
function wrapIndex(idx, count) {
  const c = Math.max(0, Number(count) || 0);
  if (c <= 0) return 0;
  const i = Number(idx) || 0;
  return ((i % c) + c) % c;
}

function nextCard(idx, count) { return wrapIndex((Number(idx) || 0) + 1, count); }
function prevCard(idx, count) { return wrapIndex((Number(idx) || 0) - 1, count); }
function moveCursor(cursor, delta, rowCount) { return wrapIndex((Number(cursor) || 0) + (Number(delta) || 0), rowCount); }

/** 给定光标位置,它落在哪类行上。 */
function rowKind(cursor, optionsLen) {
  const { discussRow, otherRow } = rowLayout(optionsLen);
  if (cursor === discussRow) return 'discuss';
  if (cursor === otherRow) return 'other';
  if (cursor >= 0 && cursor < optionsLen) return 'option';
  return 'option';
}

/**
 * 多选卡的答案组装(确定性顺序:真实选项原序 → 可讨论 → 自由输入)。
 * 「体察惰性」收尾约定:多选卡若一项未选,回退为「可讨论」—— 把「没想好」表达成一个
 * 明确、可继续对话的出口,而不是空答案。
 * @returns {string[]} 选中的标签数组(至少含一项)
 */
function multiSelection({ options = [], checked = new Set(), discussChecked = false, otherValue = '' }) {
  const labels = [];
  for (let i = 0; i < options.length; i++) {
    if (checked.has(i)) labels.push(optLabel(options[i]));
  }
  if (discussChecked) labels.push(DISCUSS_LABEL);
  const other = String(otherValue || '').trim();
  if (other) labels.push(other);
  if (labels.length === 0) labels.push(DISCUSS_LABEL); // 惰性回退
  return labels;
}

/**
 * 单选卡的答案(由当前光标位置决定):可讨论 / 自由输入 / 具体选项。
 * @returns {string}
 */
function singleSelection({ options = [], cursor = 0, otherValue = '' }) {
  const kind = rowKind(cursor, options.length);
  if (kind === 'discuss') return DISCUSS_LABEL;
  if (kind === 'other') {
    const other = String(otherValue || '').trim();
    return other || DISCUSS_LABEL; // 空自由输入 → 惰性回退可讨论
  }
  return optLabel(options[cursor] != null ? options[cursor] : options[0]);
}

/**
 * 计算一张卡的最终答案字符串(用于 resolve 时收齐全部卡)。
 * 多选 join ", ",与既有 commitRound 行为一致。
 * `multi` 为模型声明的 multiSelect;`promoted` 为用户按 Space 临时提升标记(Fix 3);
 * 有效多选由 effectiveMulti 判定(门控关时 promoted 被忽略=向后兼容)。
 * @returns {string}
 */
function cardAnswer({ multi = false, promoted = false, env = process.env, options = [], checked = new Set(), discussChecked = false, otherValue = '', cursor = 0 }) {
  if (effectiveMulti({ multiSelect: multi, promoted, env })) {
    return multiSelection({ options, checked, discussChecked, otherValue }).join(', ');
  }
  return singleSelection({ options, cursor, otherValue });
}

/**
 * 收齐全部卡的答案(供 resolve)。逐卡按各自持久状态计算,因此左右来回切换、只改了某张
 * 卡也能被如实收上来。
 * @param {Array} questions
 * @param {object} state  { cursors:number[], checkedSets:Set[], discussChecked:boolean[], otherVals:string[], promotedMulti?:boolean[] }
 * @param {object} [env]
 * @returns {Record<string,string>} answers keyed by question text
 */
function collectAllAnswers(questions, state = {}, env = process.env) {
  const cursors = state.cursors || [];
  const checkedSets = state.checkedSets || [];
  const discussFlags = state.discussChecked || [];
  const otherVals = state.otherVals || [];
  const promotedMulti = state.promotedMulti || [];
  const answers = {};
  (Array.isArray(questions) ? questions : []).forEach((q, i) => {
    if (!q) return;
    const qText = String(q.question || '').trim() || `Question ${i + 1}`;
    const options = Array.isArray(q.options) ? q.options : [];
    answers[qText] = cardAnswer({
      multi: !!q.multiSelect,
      promoted: !!promotedMulti[i],
      env,
      options,
      checked: checkedSets[i] instanceof Set ? checkedSets[i] : new Set(),
      discussChecked: !!discussFlags[i],
      otherValue: otherVals[i] || '',
      cursor: Number(cursors[i]) || 0,
    });
  });
  return answers;
}

module.exports = {
  DISCUSS_LABEL,
  DISCUSS_HINT,
  OTHER_LABEL,
  OFF_VALUES,
  questionTextCursorEnabled,
  questionMultipickEnabled,
  effectiveMulti,
  optLabel,
  optDesc,
  optPreview,
  rowLayout,
  wrapIndex,
  nextCard,
  prevCard,
  moveCursor,
  rowKind,
  multiSelection,
  singleSelection,
  cardAnswer,
  collectAllAnswers,
};
