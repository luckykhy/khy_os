'use strict';

/**
 * ocrConfidenceCaveat.js — 纯叶子:当「纯文本模型 + 图片 → 本地 OCR 兜底」把 OCR 文本注入
 * prompt 作为「请据此作答」的权威依据时,若 OCR 引擎自评置信度偏低,则追加一句诚实告诫,
 * 让文本模型知道这些文字可能有误识/漏识,别当成铁定事实。
 *
 * 背景(/goal 2026-07-11「模型为纯文本、非多模态、识图模型不可用时正确兜底提取图片信息」的
 * 一个正交诚实缺口):tesseract 的每词置信度会算出一个平均分,pytesseract 路径据此设
 * needsAiFallback = avg<60;CLI 路径经本轮 docHelper 改造后同样产出真实 confidence /
 * needsAiFallback。但这个「质量信号」在 ocrSnippetService → extractImageOcrTexts → 注入点
 * 一路被丢弃 —— gateway 把低置信 OCR 文本原样当权威依据注入,文本模型据此自信作答,用户拿到
 * 一个「基于误识文字」的错误回答却毫不知情。姊妹的 RecognizeImage 工具路径(imageOcr.js)早已
 * 消费 needsAiFallback(置低 lowConfidence 标记),此处补齐 gateway 侧这块非对称。
 *
 * 诚实边界(B2/B3 纪律,关键):**只在有正向低置信信号时**告诫。CLI 路径在无 tsv 时 confidence
 * 退化为 0(未知)且 needsAiFallback=false —— 那是「没测量」而非「测量到低」,此时**绝不**告诫
 * (逐字节回退),否则每一次干净的 CLI 提取都会误报低置信。判据:needsAiFallback===true(引擎
 * 自评低)**或** 有限的 confidence 落在 (0, 60)。0/缺失/非有限 + needsAiFallback≠true → 不告诫。
 *
 * 门控 KHY_OCR_LOW_CONFIDENCE_CAVEAT(default-on,仅 0/false/off/no 关):关 →
 * buildLowConfidenceCaveat 返 null,不注入,逐字节回退。绝不抛:任何异常 fail-safe 视为「不告诫」。
 *
 * @module services/gateway/ocrConfidenceCaveat
 */

const { isFlagEnabled } = require('../flagRegistry');

const FLAG = 'KHY_OCR_LOW_CONFIDENCE_CAVEAT';
// 与 docHelper.py 的 needsAiFallback = avg_conf < 60 对齐(单一阈值真源在 Python 侧;这里只作
// 「有测量分数但偏低」的二次判定,threshold 保持一致以免两侧语义漂移)。
const LOW_CONFIDENCE_THRESHOLD = 60;

/** 门是否开(default-on;不可用/异常 → fail-safe 视为关,绝不误注入)。 */
function isEnabled(env) {
  try {
    return isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

/**
 * 单张 OCR 结果是否为**正向**低置信信号。
 * true 仅当:needsAiFallback===true(引擎自评低) 或 有限 confidence ∈ (0, 60)。
 * 未知置信(0 / 非有限)且 needsAiFallback≠true → false(绝不把「没测量」谎报成「低」)。
 * @param {{confidence?:number, needsAiFallback?:boolean}} detail
 * @returns {boolean}
 */
function isLowConfidence(detail) {
  if (!detail || typeof detail !== 'object') return false;
  if (detail.needsAiFallback === true) return true;
  const c = Number(detail.confidence);
  if (Number.isFinite(c) && c > 0 && c < LOW_CONFIDENCE_THRESHOLD) return true;
  return false;
}

/**
 * 统计一批 OCR 明细里有多少张是正向低置信。非数组 → 0。
 * @param {Array<{confidence?:number, needsAiFallback?:boolean}>} details
 * @returns {number}
 */
function countLowConfidence(details) {
  if (!Array.isArray(details)) return 0;
  let n = 0;
  for (const d of details) {
    if (isLowConfidence(d)) n += 1;
  }
  return n;
}

/**
 * 构造低置信告诫句;不满足则返回 null(调用方据此决定是否追加)。
 * 返回 null 的情形:门关 / count 非有限 / count < 1。
 * @param {{count?:number, total?:number, env?:object}} [opts]
 * @returns {string|null}
 */
function buildLowConfidenceCaveat({ count, total, env } = {}) {
  if (!isEnabled(env)) return null;
  const n = Number(count);
  if (!Number.isFinite(n) || n < 1) return null;
  const scope = Number.isFinite(Number(total)) && Number(total) > 0
    ? `其中 ${n}/${Number(total)} 张`
    : `其中 ${n} 张`;
  return `[提示：${scope}图片的 OCR 识别置信度较低，文字可能存在误识或漏识，请谨慎对待上述识别文本，`
    + `不要当作确定无误的事实；必要时请用户核对原图，或改用支持看图的多模态模型复核。]`;
}

module.exports = {
  isEnabled,
  isLowConfidence,
  countLowConfidence,
  buildLowConfidenceCaveat,
  FLAG,
  LOW_CONFIDENCE_THRESHOLD,
};
