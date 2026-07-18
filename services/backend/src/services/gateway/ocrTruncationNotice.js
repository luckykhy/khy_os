'use strict';

/**
 * ocrTruncationNotice.js — 纯叶子:当「纯文本模型 + 图片 → 本地 OCR 兜底」把 OCR 文本注入
 * prompt 作为「请据此作答」的权威依据时,若某些图片的识别文本**因长度上限被截断**(只保留了
 * 前 maxChars 个字符、尾部被丢),则追加一句诚实告诫,让文本模型知道它看到的是**残缺**文本,
 * 别把「没提到」当成「不存在」。
 *
 * 背景(/goal 2026-07-12,与 ocrConfidenceCaveat「准确性」、ocrCoverageNotice「跨图完整性」
 * 三条互相正交,本叶补**单图内文本完整性**):一张稠密文档/截图的 OCR 全文可能超过 maxChars
 * (默认 1200)被截断,此前「被截断」只在文本里留一个内嵌英文 `...[truncated]` 标记、从不作为
 * 结构化信号离开 ocrSnippetService。本轮把 truncated 一路暴露到 extractImageOcrDetails 的明细,
 * 本叶据此渲染一句面向中文语境的诚实告诫。这直接命中「我发了一个图片」的单图稠密场景。
 *
 * 诚实边界(B2/B3):
 *   - 只在**真有截断**(detail.truncated===true)时告诫;未截断 / 门关 / 畸形 → null,逐字节回退。
 *   - 只装饰:不改成败归属、不改剥图/清图不变量;任何异常 fail-safe 视为「不告诫」,绝不抛。
 *
 * 门控 KHY_OCR_TRUNCATION_NOTICE(default-on,仅 0/false/off/no 关)。
 *
 * @module services/gateway/ocrTruncationNotice
 */

const { isFlagEnabled } = require('../flagRegistry');

const FLAG = 'KHY_OCR_TRUNCATION_NOTICE';

/** 门是否开(default-on;不可用/异常 → fail-safe 视为关,绝不误注入)。 */
function isEnabled(env) {
  try {
    return isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

/**
 * 统计一批 OCR 明细里有多少张的文本被截断。非数组 → 0。
 * @param {Array<{truncated?:boolean}>} details
 * @returns {number}
 */
function countTruncated(details) {
  if (!Array.isArray(details)) return 0;
  let n = 0;
  for (const d of details) {
    if (d && typeof d === 'object' && d.truncated === true) n += 1;
  }
  return n;
}

/**
 * 构造截断告诫句;不满足则返回 null(调用方据此决定是否追加)。
 * 返回 null 的情形:门关 / count 非有限 / count < 1。
 * @param {{count?:number, total?:number, env?:object}} [opts]
 * @returns {string|null}
 */
function buildTruncationNotice({ count, total, env } = {}) {
  if (!isEnabled(env)) return null;
  const n = Number(count);
  if (!Number.isFinite(n) || n < 1) return null;
  const scope = Number.isFinite(Number(total)) && Number(total) > 0
    ? `其中 ${n}/${Number(total)} 张`
    : `其中 ${n} 张`;
  return `[提示：${scope}图片的 OCR 文本因长度上限被截断，仅保留了前一部分，尾部内容未包含在上述`
    + `文本中；请勿因某些信息「未出现」就断定它不存在，必要时请用户提供更清晰/更小范围的图片，`
    + `或改用支持看图的多模态模型复核。]`;
}

module.exports = {
  isEnabled,
  countTruncated,
  buildTruncationNotice,
  FLAG,
};
