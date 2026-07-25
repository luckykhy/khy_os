'use strict';

/**
 * busyTopicShift.js — 忙碌插话的「转向新话题」判定(确定性、零 IO、绝不抛)。
 *
 * 背景:khy 忙碌时用户插话被 `busyInputClassifiers.routeBusyInput` 按**关键词/正则**分成
 * urgent/steer/interrupt/queue。其中 `steer`(命中「另外/还要/改成/also/instead…」等方向词)
 * 会在下一个工具边界把插话作为 `[用户方向修正]` **注入正在跑的 turn**。问题:这些方向词在
 * **真·新话题**里同样常见,于是一条其实是「转向新话题」的插话会被误当方向修正注入,污染当前任务。
 *
 * 本判定给 `steer` 加一道语义闸:把插话与**当前正在跑的 turn 文本**做确定性 token 相似度比较;
 * 若重叠极低 = 换了话题 → 建议把 steer **降级为排队**(作独立新 turn 在收口后跑),不中途注入。
 * 降级是保守动作:插话绝不丢失、绝不误中断——最坏情况只是一条真方向修正被延后成新 turn 执行。
 *
 * **为何用 overlap coefficient 而非 Jaccard**:插话通常很短(几个 token)而运行话题很长(几十
 * 个 token)。Jaccard = |A∩B|/|A∪B| 的并集项被长话题主导 → 即便是「同话题的方向修正」相似度也被
 * 压得极低,无法与真·新话题区分(E2E 实测:同话题 Jaccard 0.02~0.11 与新话题 0.00~0.03 完全重叠)。
 * 正确的问题是**包含度**——「这条短插话有多少内容已出现在运行话题里」——即 overlap coefficient
 * = |A∩B| / min(|A|,|B|)(对长短不对称鲁棒)。实测同话题 ≥0.14、新话题 ≤0.08,阈值 0.12 干净切分。
 * token 由调用方用 memdir._tokenizeForRecall + memoryRecallTokens.enrichTokens(CJK 二元组,缓解
 * 单字中文噪声)生成后注入,保持本叶子纯净。
 *
 * 门控(独立,不与记忆 priming 的换话题门控耦合,便于各自调参):
 *   KHY_BUSY_STEER_TOPIC_GUARD       默认 on —— 总开关;关 → 恒返 false(逐字节回退今日 steer)。
 *   KHY_BUSY_STEER_TOPIC_OVERLAP     默认 0.12 —— 插话对运行话题的包含度低于此判为新话题。
 *   KHY_BUSY_STEER_TOPIC_MIN_TOKENS  默认 2   —— 插话 token 数下限;过短(单字/招呼)不判,保守留 steer。
 */

const flagRegistry = require('../../services/flagRegistry');

const DEFAULT_OVERLAP = 0.12;
const DEFAULT_MIN_TOKENS = 2;
const OFF_VALUES = ['0', 'false', 'off', 'no'];

function _toSet(v) {
  if (v instanceof Set) return v;
  if (Array.isArray(v)) return new Set(v);
  return new Set();
}

/**
 * overlap coefficient(包含度)= |A∩B| / min(|A|,|B|)。两者任一为空 → 0(无从判断包含)。
 * 对「短插话 vs 长运行话题」的不对称鲁棒:衡量短集有多少落在长集里,不被并集规模稀释。
 */
function overlapCoefficient(a, b) {
  const A = _toSet(a);
  const B = _toSet(b);
  const m = Math.min(A.size, B.size);
  if (m === 0) return 0;
  let inter = 0;
  // 遍历较小集,减少 has 调用。
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) if (large.has(t)) inter++;
  return inter / m;
}

/** 总开关。dogfood flagRegistry;registry 缺失/异常 → 回退 CANON off 词表判定。默认 on。 */
function isEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  try {
    return flagRegistry.isFlagEnabled('KHY_BUSY_STEER_TOPIC_GUARD', e);
  } catch {
    const v = String((e && e.KHY_BUSY_STEER_TOPIC_GUARD) || '').trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  }
}

function _threshold(env) {
  const v = parseFloat((env && env.KHY_BUSY_STEER_TOPIC_OVERLAP) || '');
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_OVERLAP;
}

function _minTokens(env) {
  const v = parseInt((env && env.KHY_BUSY_STEER_TOPIC_MIN_TOKENS) || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MIN_TOKENS;
}

/**
 * 一条(已被判为 steer 的)忙碌插话是否其实在「转向新话题」,应降级为排队。
 *
 * 当且仅当以下全部成立才判为新话题:
 *   ① 门控 KHY_BUSY_STEER_TOPIC_GUARD 开;
 *   ② curTokens.size >= MIN_TOKENS   —— 过短插话不判(保守留 steer);
 *   ③ baselineTokens 非空            —— 无运行话题基线时不判(留 steer);
 *   ④ overlapCoefficient(cur, baseline) < 阈值 —— 插话内容极少落在运行话题里。
 *
 * 纯函数、绝不抛。token 由调用方用 memdir._tokenizeForRecall(+enrichTokens)生成后传入
 * (单一 tokenizer 真源;CJK 二元组富化缓解单字噪声)。
 *
 * @param {Set|Array} curTokens       插话文本的 token 集
 * @param {Set|Array} baselineTokens  当前正在跑的 turn 文本的 token 集(话题基线)
 * @param {object} [env]
 * @returns {boolean} true = 转向新话题 → 建议 steer 降级为 queue
 */
function isNewTopicInterjection(curTokens, baselineTokens, env) {
  try {
    const e = env || (typeof process !== 'undefined' ? process.env : {});
    if (!isEnabled(e)) return false;
    const cur = _toSet(curTokens);
    const base = _toSet(baselineTokens);
    if (cur.size < _minTokens(e)) return false;
    if (base.size === 0) return false;
    return overlapCoefficient(cur, base) < _threshold(e);
  } catch {
    return false; // fail-soft:判定绝不能拖垮忙碌插话路由
  }
}

module.exports = {
  isEnabled,
  isNewTopicInterjection,
  overlapCoefficient,
  DEFAULT_OVERLAP,
  DEFAULT_MIN_TOKENS,
};
