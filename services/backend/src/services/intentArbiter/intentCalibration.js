'use strict';

/**
 * intentCalibration.js — 纯叶子:意图裁决「确定性历史校准」决策单一真源(Phase C-2 第 2 层)。
 *
 * 背景(为什么需要本叶子):
 *   intent_arbiter_pool 进化账本(误判淬火落账)历史上**只写不读** —— feedback() 把用户的
 *   误触/漏判纠正记进哈希链,却从无任何路径回头消费它。本叶子让账本变得**可用**:对落在
 *   **歧义带(confirm)**的输入,用既往「误触(false-trigger)」纠正记录做一次确定性校准。
 *
 * 批判取舍(对齐用户「否决向量/模型进热路径」):**绝不**引入向量检索(learningRetrieval)或
 *   生成模型(getAiChat) —— 它们破坏裁决器的确定性与可解释性、给默认关的安全检查引入网络
 *   延迟、且 headless 下 fail-open 形同虚设。校准只用**纯词法相似度**(CJK 字符 bigram
 *   Jaccard,零网络、零模型、无分词词典)。
 *
 * 安全不变式(防呆②「歧义带绝不自主猜测执行」的代码化):本叶子**结构上只能降级**——
 *   selectCalibration 的任何返回路径要么 `{adjusted:false}`,要么 `band=BANDS.CHAT`(把
 *   confirm 压向更安全的对话带)。**绝无**任何路径产出 EXECUTION 或抬升 band。故即便调用方
 *   误传「漏判(miss)」样本,也不可能据此升档执行(漏判记录刻意不参与自动路由,仅留人工审阅)。
 *
 * 纯叶子契约:零 IO、确定性、绝不抛、可单测。env / exemplars 由调用方注入(不读账本、不做 IO)。
 * 门控 KHY_INTENT_CALIBRATION 默认开;关 → selectCalibration 返回 {adjusted:false}(字节回退)。
 */

const L = require('./intentLexicon');

const FALSY = new Set(['0', 'false', 'off', 'no']);

// 相似度阈值:纯算法常量(非 host/port/path/model 基础设施字面量)。默认偏保守——
// 宁可不校准也不误降一条真命令。可由 KHY_INTENT_CALIBRATION_MIN 覆盖(带解析守卫)。
const DEFAULT_MIN_SIMILARITY = 0.6;

/** 校准子门控(默认开;{0,false,off,no} 关闭)。 */
function isEnabled(env) {
  const e = env && typeof env === 'object' ? env : {};
  const raw = e.KHY_INTENT_CALIBRATION;
  if (raw === undefined || raw === null || raw === '') return true;
  return !FALSY.has(String(raw).trim().toLowerCase());
}

/** 解析相似度阈值(env 覆盖,守卫非法值回退默认)。 */
function _minSimilarity(env) {
  const e = env && typeof env === 'object' ? env : {};
  const raw = e.KHY_INTENT_CALIBRATION_MIN;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MIN_SIMILARITY;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0 || n > 1) return DEFAULT_MIN_SIMILARITY;
  return n;
}

/** 切字符 bigram 集合(剥空白)。单字降级到字符集合,空串 → 空集。纯字符串运算。 */
function _bigrams(s) {
  const chars = Array.from(String(s == null ? '' : s)).filter((c) => !/\s/.test(c));
  if (chars.length === 0) return new Set();
  if (chars.length === 1) return new Set([chars[0]]);
  const out = new Set();
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
  return out;
}

/**
 * 纯词法相似度:CJK 字符 bigram Jaccard ∈ [0,1]。对称、自反、无交集为 0。
 * 无分词词典、无网络、无模型 —— 完全确定性。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function lexicalSimilarity(a, b) {
  const A = _bigrams(a);
  const B = _bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 历史校准决策(仅降级)。门控关 / 非歧义带 / 无样本 / 无相似命中 → {adjusted:false}。
 * 命中既往误触样本(相似度 ≥ 阈值)→ 把歧义带压向安全对话带(CHAT)。
 *
 * **结构安全**:返回 band 恒为 BANDS.CHAT —— 绝无升档路径(防呆②)。
 *
 * @param {object} analysis  IntentSpectrumAnalyzer.analyze 输出(读 band/text)
 * @param {Array<{originalText:string}|string>} exemplars  既往误触样本(调用方已按 false-trigger 过滤)
 * @param {object} [env]  环境(门控 + 阈值注入点)
 * @returns {{adjusted:boolean, band?:string, confidence?:number, similarity?:number, matched?:string, reason?:string}}
 */
function selectCalibration(analysis, exemplars, env) {
  if (!isEnabled(env)) return { adjusted: false };
  if (!analysis || typeof analysis !== 'object') return { adjusted: false };
  // 只对歧义带生效:CHAT 已是最安全带无需降;EXECUTION 是强意图,校准绝不插手(防呆①/②)。
  if (analysis.band !== L.BANDS.CONFIRM) return { adjusted: false };
  if (!Array.isArray(exemplars) || exemplars.length === 0) return { adjusted: false };

  const text = typeof analysis.text === 'string' ? analysis.text : '';
  if (!text) return { adjusted: false };

  const min = _minSimilarity(env);
  let best = 0;
  let matched = null;
  for (const ex of exemplars) {
    const orig = ex && typeof ex === 'object'
      ? ex.originalText
      : (typeof ex === 'string' ? ex : '');
    if (typeof orig !== 'string' || !orig) continue;
    const sim = lexicalSimilarity(text, orig);
    if (sim > best) { best = sim; matched = orig; }
  }

  if (matched && best >= min) {
    // 目标置信度:落在 CHAT 带 [0, CONFIRM_MIN) 内的确定中点(由 band 边界派生,非魔数)。
    const confidence = Math.round((L.BAND_EDGES.CONFIRM_MIN / 2) * 100) / 100;
    return {
      adjusted: true,
      band: L.BANDS.CHAT,
      confidence,
      similarity: best,
      matched,
      reason: `历史误触校准:与既往纠正「${matched}」高度相似(${best.toFixed(2)}),压向安全对话带(防呆②:绝不据此升档执行)`,
    };
  }
  return { adjusted: false };
}

module.exports = {
  isEnabled,
  lexicalSimilarity,
  selectCalibration,
  DEFAULT_MIN_SIMILARITY,
};
