'use strict';

/**
 * repeatedPromptRounds.js — 识别「同一请求被重复发送的轮次」(单一真源,纯叶子)。
 *
 * 背景(goal 2026-06-25):用户在用 Khyos 开发时,会**重复发送基本相同的提示词**,本意是
 * 「在上一轮成果的基础上继续往前推进 / 换个角度再挖一层」。但弱模型常把这理解成「这事我
 * 已经做完了」而原地复述上一轮的结论,甚至直接回一句「已经做完了」。用户的诉求很明确:
 *
 *   「如果在我重复发送相同提示词时 khyos 要知道这是第一轮、第二轮、第三轮,
 *     而不是说我已经做完了。」
 *
 * 本模块只做一件事:给定当前 user 提示词 + 历史 user 轮次,**无状态地数出这是第几轮重复**,
 * 并产出一条 `[SYSTEM]` 指令,告诉模型「这是第 N 轮,请继续深入而非声称已完成」。
 *
 * 设计要点:
 *   - **无状态**:轮次完全从对话历史(initialMessages 里的历史 user 轮)派生,不持有跨请求
 *     状态。历史被 compaction 截断会少数几轮 → 保守退化(只会少报,不会误报),可接受。
 *   - **纯叶子**:零 IO、确定性、可单测。判同主要靠 normalize 后的精确相等;模糊兜底用字符
 *     二元组 Jaccard,既能容忍尾随「,继续」之类的小改动,又对 CJK/拉丁混排都成立。
 *   - **只增不减**:仅在 round≥2 注入提示;round=1(首次)返回 null,对正常单次请求零影响。
 *
 * env:
 *   KHY_PROMPT_ROUND_TRACKER = (默认开) 0 | false | off 关闭 → countRound 恒为 1、不注入。
 *   KHY_PROMPT_ROUND_SIM     = 模糊判同的 Jaccard 阈值(默认 0.9;精确相等始终判同)。
 */

function isEnabled(env = process.env) {
  const v = env && env.KHY_PROMPT_ROUND_TRACKER;
  return !(v === '0' || v === 'false' || v === 'off');
}

function _simThreshold(env) {
  const v = Number(env && env.KHY_PROMPT_ROUND_SIM);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.9;
}

/** 归一化:转字符串、去首尾空白、小写、折叠内部连续空白为单空格。 */
function normalize(text) {
  return String(text == null ? '' : text).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 字符二元组集合(模糊判同用)。单字符串本身回退为单元素集。 */
function _bigrams(s) {
  const set = new Set();
  if (s.length <= 1) { if (s) set.add(s); return set; }
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 两段文本的相似度 ∈ [0,1]:归一精确相等→1;否则字符二元组 Jaccard。 */
function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = _bigrams(na);
  const B = _bigrams(nb);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}

/** 是否「同一请求」:归一精确相等,或模糊相似度 ≥ 阈值。 */
function isSamePrompt(a, b, env = process.env) {
  if (normalize(a) === normalize(b)) return true;
  return similarity(a, b) >= _simThreshold(env);
}

/** 从消息数组里抽取历史 user 轮次的文本(role==='user')。 */
function priorUserTextsFrom(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (m && m.role === 'user') {
      out.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content));
    }
  }
  return out;
}

/**
 * 当前提示词是第几轮重复 = 1 + 历史 user 轮里与当前「同一请求」的条数。
 * 首次发送(无历史同款)→ 1。关闭或空提示 → 1。
 * @param {string} currentText
 * @param {string[]} priorUserTexts  历史 user 轮文本(通常来自 priorUserTextsFrom(initialMessages))
 */
function countRound(currentText, priorUserTexts, env = process.env) {
  if (!isEnabled(env)) return 1;
  if (!normalize(currentText)) return 1;
  const arr = Array.isArray(priorUserTexts) ? priorUserTexts : [];
  let repeats = 0;
  for (const p of arr) {
    if (isSamePrompt(currentText, p, env)) repeats++;
  }
  return repeats + 1;
}

const _ORDINAL = ['第一轮', '第二轮', '第三轮', '第四轮', '第五轮', '第六轮', '第七轮', '第八轮', '第九轮'];
function _ordinal(n) { return _ORDINAL[n - 1] || `第 ${n} 轮`; }

/**
 * 产出注入给模型的 `[SYSTEM]` 指令:告诉它这是同一请求的第 N 轮重复,**不要回答「已经做完了」**,
 * 而要把重复当作「在已完成的基础上继续深入 / 换角度 / 找出还没覆盖到的部分」。round≤1 返回 null。
 * @param {number} round
 * @returns {string|null}
 */
function buildRoundHint(round, env = process.env) {
  if (!isEnabled(env)) return null;
  if (!(round >= 2)) return null;
  const ord = _ordinal(round);
  return `[SYSTEM] 重复请求识别:用户已第 ${round} 次发送基本相同的请求(这是${ord})。`
    + `这通常不是要你回答「已经做完了」,而是希望你在上一轮成果之上继续推进。请在本轮:`
    + `①明确说明这是${ord};②给出与前几轮不重复的新进展、更深一层的实现,或换一个角度的处理;`
    + `③只有当你确信确实再无可做时,才明确说「已穷尽,无新增可做」并给出依据,而不是笼统地说「已完成」。`;
}

module.exports = {
  isEnabled,
  normalize,
  similarity,
  isSamePrompt,
  priorUserTextsFrom,
  countRound,
  buildRoundHint,
};
