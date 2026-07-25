'use strict';

/**
 * topicSwitch.js — 会话内「换话题」检测(纯叶子,确定性,零 IO,无 embedding)。
 *
 * 用于记忆 priming:会话开场由 sessionId 变化触发一次 prime;会话进行中,当用户
 * 明显换了话题时再 prime 一次,让相关的长期记忆重新浮现。检测刻意用**确定性的
 * Jaccard token 相似度**(零依赖、零网络、可测),而非语义/embedding。
 *
 * token 由调用方注入(用 memdir._tokenizeForRecall 这一 SSOT tokenizer,使 priming、
 * proactive、换话题检测三者口径一致),本叶子只做集合运算与门控判定。
 *
 * 门控:
 *   KHY_MEMORY_TOPIC_SWITCH_JACCARD    默认 0.2 —— 当前 vs 基线 token 的 Jaccard
 *                                      低于此值判为换话题。
 *   KHY_MEMORY_TOPIC_SWITCH_MIN_TOKENS 默认 2   —— 当前消息 token 数下限,抑制
 *                                      招呼/单词触发。
 */

const DEFAULT_JACCARD = 0.2;
const DEFAULT_MIN_TOKENS = 2;

function _toSet(v) {
  if (v instanceof Set) return v;
  if (Array.isArray(v)) return new Set(v);
  return new Set();
}

/**
 * Jaccard 相似度 |A∩B| / |A∪B|。两者皆空 → 1(视为「相同」,不算换话题)。
 * @param {Set|Array} a
 * @param {Set|Array} b
 * @returns {number} [0,1]
 */
function jaccard(a, b) {
  const A = _toSet(a);
  const B = _toSet(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

function _jaccardThreshold(env) {
  const v = parseFloat((env && env.KHY_MEMORY_TOPIC_SWITCH_JACCARD) || '');
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_JACCARD;
}

function _minTokens(env) {
  const v = parseInt((env && env.KHY_MEMORY_TOPIC_SWITCH_MIN_TOKENS) || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MIN_TOKENS;
}

/**
 * 是否发生了「换话题」(相对上一次 prime 的基线 token 集)。
 *
 * 当且仅当以下全部成立才判为换话题:
 *   ① curTokens.size >= MIN_TOKENS   —— 忽略招呼/单词/空消息;
 *   ② prevTokens 非空                 —— 无基线时不算换话题(首 prime 由会话边界负责);
 *   ③ jaccard(cur, prev) < JACCARD    —— 与上一话题重叠很低。
 *
 * 纯函数、绝不抛。token 由调用方用 memdir._tokenizeForRecall 生成后传入。
 *
 * @param {Set|Array} curTokens  当前用户消息的 token 集
 * @param {Set|Array} prevTokens 上一次 prime 时的 token 集(基线)
 * @param {object} [env]
 * @returns {boolean}
 */
function isTopicSwitch(curTokens, prevTokens, env = process.env) {
  try {
    const cur = _toSet(curTokens);
    const prev = _toSet(prevTokens);
    if (cur.size < _minTokens(env)) return false;
    if (prev.size === 0) return false;
    return jaccard(cur, prev) < _jaccardThreshold(env);
  } catch {
    return false; // fail-soft: never let detection break prompt assembly
  }
}

module.exports = {
  jaccard,
  isTopicSwitch,
  DEFAULT_JACCARD,
  DEFAULT_MIN_TOKENS,
};
