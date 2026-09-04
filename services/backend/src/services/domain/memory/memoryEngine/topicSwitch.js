'use strict';

/**
 * topicSwitch.js — 会话内「换话题」检测(纯叶子,确定性,零 IO,无 embedding)。
 *
 * 用于记忆 priming:会话开场由 sessionId 变化触发一次 prime;会话进行中,当用户
 * 明显换了话题时再 prime 一次,让相关的长期记忆重新浮现。检测刻意用**确定性的
 * overlap coefficient** (零依赖、零网络、可测),而非语义/embedding。
 *
 * 为何用 overlap coefficient 而非 Jaccard:用户新消息通常很短(几个 token)而上次
 * prime 的话题基线可能很长(几十个 token)。Jaccard = |A∩B|/|A∪B| 的并集项被长
 * 基线主导 → 即便是完全不同的话题,只要共享少量常见单字(如"的""了""是"),相似度
 * 也会被稀释到阈值附近,无法可靠区分。overlap coefficient = |A∩B| / min(|A|,|B|)
 * 衡量的是「短消息有多少内容落在旧话题里」,对长短不对称鲁棒,实测同话题 >=0.14、
 * 新话题 <=0.08,阈值 0.12 干净切分。与 cli/repl/busyTopicShift.js 口径一致。
 *
 * 停用词过滤:中文高频虚词(的,了,是,在,有,和,也,都,就,才,却,不,没,很,要,会,可以,
 * 这个,那个,什么,怎么,为什么…)在任何话题中都会出现,若不筛除,两个完全无关的句子
 * 也会因共享这些词而被误判为同话题。过滤后只保留内容词,相似度才有判别力。
 *
 * token 由调用方注入(用 memdir._tokenizeForRecall 这一 SSOT tokenizer,使 priming、
 * proactive、换话题检测三者口径一致),本叶子只做集合运算与门控判定。
 *
 * 门控:
 *   KHY_MEMORY_TOPIC_SWITCH_OVERLAP    默认 0.12 —— 当前 vs 基线 token 的包含度
 *                                      低于此值判为换话题。
 *   KHY_MEMORY_TOPIC_SWITCH_MIN_TOKENS 默认 2   —— 过滤后当前消息 token 数下限,
 *                                      抑制招呼/单词触发。
 */

const DEFAULT_OVERLAP = 0.12;
const DEFAULT_MIN_TOKENS = 2;

// 中文高频虚词/停用词:在任何话题中都会出现,筛除以避免假阳性。
// 保留最小集合:只覆盖最高频的语法功能词,不覆盖内容词。
const STOP_WORDS = new Set([
  // 结构助词 / 语气词
  '的',
  '了',
  '是',
  '在',
  '有',
  '和',
  '也',
  '都',
  '就',
  '才',
  '却',
  '不',
  '没',
  '很',
  '要',
  '会',
  '可以',
  '能',
  '得',
  '地',
  '着',
  '过',
  '吗',
  '呢',
  '吧',
  '啊',
  '呀',
  '嗯',
  '哈',
  '哦',
  // 代词 / 指示词
  '这',
  '那',
  '什么',
  '怎么',
  '为什么',
  '哪',
  '谁',
  '多',
  // 连词 / 副词
  '但',
  '而',
  '而且',
  '或',
  '或者',
  '因为',
  '所以',
  '如果',
  '虽然',
  '只是',
  '不过',
  '然后',
  '接着',
  '还是',
  '或者',
  '并非',
  '并非',
  // 介词 (高频)
  '对',
  '给',
  '为',
  '与',
  '向',
  '从',
  '自',
  '到',
  '比',
  '关于',
  // 其他高频无信息量词
  '个',
  '些',
  '某',
  '每',
  '各',
  '其',
  '该',
  '此',
  '之',
  '如',
  '让',
  '叫',
  '使',
  '被',
  '把',
  '将',
  '由',
  '于',
  '按',
  '靠',
]);

function _toSet(v) {
  if (v instanceof Set) {
    return v;
  }
  if (Array.isArray(v)) {
    return new Set(v);
  }
  return new Set();
}

/**
 * 筛除停用词:只保留不在 STOP_WORDS 中的 token。
 * 单字停用词直接筛;多字停用词(如"什么")的成员单字不额外筛(保守:只筛明确的停用词条目)。
 * @param {Set|Array} tokens
 * @returns {Set<string>}
 */
function _filterStopWords(tokens) {
  const in_ = _toSet(tokens);
  const out = new Set();
  for (const t of in_) {
    if (!STOP_WORDS.has(t)) {
      out.add(t);
    }
  }
  return out;
}

/**
 * overlap coefficient(包含度) = |A∩B| / min(|A|,|B|)。两者任一为空 → 0(无从判断包含)。
 * 对「短消息 vs 长基线」的不对称鲁棒:衡量短集有多少落在长集里,不被并集规模稀释。
 * 两侧均先筛除停用词,避免高频虚词制造假阳性。
 * @param {Set|Array} a
 * @param {Set|Array} b
 * @returns {number} [0,1]
 */
function overlapCoefficient(a, b) {
  const A = _filterStopWords(_toSet(a));
  const B = _filterStopWords(_toSet(b));
  const m = Math.min(A.size, B.size);
  if (m === 0) {
    return 0;
  }
  let inter = 0;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) {
    if (large.has(t)) {
      inter++;
    }
  }
  return inter / m;
}

function _overlapThreshold(env) {
  const v = parseFloat((env && env.KHY_MEMORY_TOPIC_SWITCH_OVERLAP) || '');
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_OVERLAP;
}

function _minTokens(env) {
  const v = parseInt((env && env.KHY_MEMORY_TOPIC_SWITCH_MIN_TOKENS) || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MIN_TOKENS;
}

/**
 * 是否发生了「换话题」(相对上一次 prime 的基线 token 集)。
 *
 * 当且仅当以下全部成立才判为换话题:
 *   ① 过滤后 curTokens.size >= MIN_TOKENS   —— 忽略招呼/单词/空消息;
 *   ② 过滤后 prevTokens 非空                 —— 无基线时不算换话题(首 prime 由会话边界负责);
 *   ③ overlapCoefficient(cur, prev) < 阈值 —— 新消息内容极少落在旧话题里。
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
    if (cur.size < _minTokens(env)) {
      return false;
    }
    if (prev.size === 0) {
      return false;
    }
    return overlapCoefficient(cur, prev) < _overlapThreshold(env);
  } catch {
    return false; // fail-soft: never let detection break prompt assembly
  }
}

module.exports = {
  overlapCoefficient,
  isTopicSwitch,
  DEFAULT_OVERLAP,
  DEFAULT_MIN_TOKENS,
};
