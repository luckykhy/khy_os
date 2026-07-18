'use strict';

/**
 * ocrCoverageNotice.js — 纯叶子:当「纯文本模型 + 图片 → 本地 OCR 兜底」把 OCR 文本注入
 * prompt 作为「请据此作答」的权威依据时,若这批文本**并未覆盖全部输入图片**,则追加一句诚实
 * 的「覆盖率」告诫,让文本模型知道自己看到的不是全部,别默认已看到所有图片内容。
 *
 * 背景(/goal 2026-07-12「模型为纯文本、非多模态、识图模型不可用时正确兜底提取图片信息」的
 * 又一正交诚实缺口,与 ocrConfidenceCaveat 的「置信度/准确性」诚实**正交**,本叶补「覆盖率/
 * 完整性」诚实):gateway 三处 OCR 注入点(aiGatewayGenerateMethod.js)都以
 * `extractImageOcrDetails(images, { maxImages: 3, maxChars: 1200 })` 提取,其中
 *   - `images.slice(0, maxImages)`(aiGateway.js) → 第 4 张起被**静默丢弃**,无计数、无标记;
 *   - 部分图片(如纯照片/场景图或缺字库)提取不到文字 → 在这批里**静默消失**。
 * 于是模型收到 【图片1】【图片2】【图片3】 三块并被告知「以下为图片 OCR 识别文本,请据此作答」,
 * 却以为这就是全部 —— 用户发了 5 张、其中 2 张读不出时,模型会基于**残缺**输入自信作答而毫不知情。
 * 这正是「silent truncation reads as covered everything」反模式:上限已在代码里生效,却从不向
 * 作答的模型披露被截断/被丢弃了什么。本叶把这份缺口变成一句可见的诚实告诫。
 *
 * 诚实边界(B2/B3 纪律,关键):
 *   - **只在真有覆盖缺口时**告诫(omitted>0 或 unreadable>0);干净的单图/全覆盖 → null,逐字节回退,
 *     绝不对每一次完整提取误报。
 *   - `unreadable` 只统计**已尝试但无文字**的图片(attempted − withText),不把「超上限未尝试」的图
 *     重复计入(那归 omitted)。全部读不出(withText===0)时注入分支根本不会跑本告诫(另有
 *     visionOcrFallback.buildVisionUnreadableNote 兜底),故本叶与其**不重叠**。
 *   - 只装饰:不改成败归属、不改剥图/清图不变量;任何异常 fail-safe 视为「不告诫」,绝不抛。
 *
 * 门控 KHY_OCR_COVERAGE_NOTICE(default-on,仅 0/false/off/no 关):关 → buildCoverageNotice
 * 返 null,不注入,逐字节回退。
 *
 * @module services/gateway/ocrCoverageNotice
 */

const { isFlagEnabled } = require('../flagRegistry');

const FLAG = 'KHY_OCR_COVERAGE_NOTICE';

/** 门是否开(default-on;不可用/异常 → fail-safe 视为关,绝不误注入)。 */
function isEnabled(env) {
  try {
    return isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

/** 保守取非负有限整数;非法 → 0。 */
function _nonNegInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * 纯算术:由「本次输入图片总数 / 成功提取到文字的图片数 / 单次 OCR 图片上限」推出覆盖率明细。
 * 全程 fail-safe(非法输入 → 0),绝不抛。
 *
 * @param {{totalImages?:number, ocrTextCount?:number, maxImages?:number}} [opts]
 * @returns {{total:number, cap:number, attempted:number, withText:number, omitted:number, unreadable:number}}
 */
function computeCoverage({ totalImages, ocrTextCount, maxImages } = {}) {
  const total = _nonNegInt(totalImages);
  const capRaw = _nonNegInt(maxImages);
  const cap = capRaw >= 1 ? capRaw : 0; // 0 表示「上限未知」→ 不推断 omitted
  // withText 不可能超过实际尝试数;先按 total 夹紧,后按 attempted 夹紧。
  let withText = _nonNegInt(ocrTextCount);
  if (withText > total) withText = total;
  const attempted = cap > 0 ? Math.min(total, cap) : total;
  if (withText > attempted) withText = attempted;
  const omitted = cap > 0 ? Math.max(0, total - attempted) : 0;
  const unreadable = Math.max(0, attempted - withText);
  return { total, cap, attempted, withText, omitted, unreadable };
}

/**
 * 构造覆盖率告诫句;不满足则返回 null(调用方据此决定是否追加)。
 * 返回 null 的情形:门关 / 无覆盖缺口(omitted<1 且 unreadable<1) / 异常。
 *
 * @param {{totalImages?:number, ocrTextCount?:number, maxImages?:number, env?:object}} [opts]
 * @returns {string|null}
 */
function buildCoverageNotice({ totalImages, ocrTextCount, maxImages, env } = {}) {
  try {
    if (!isEnabled(env)) return null;
    const c = computeCoverage({ totalImages, ocrTextCount, maxImages });
    if (c.omitted < 1 && c.unreadable < 1) return null;
    const parts = [];
    if (c.omitted > 0) {
      parts.push(
        `因单次 OCR 图片上限（${c.cap} 张），本次共 ${c.total} 张图片中仅识别了前 ${c.attempted} 张，`
        + `另有 ${c.omitted} 张未做识别`
      );
    }
    if (c.unreadable > 0) {
      parts.push(
        `另有 ${c.unreadable} 张图片未能提取到文字（可能为纯图像/照片，或缺少对应语言字库）`
      );
    }
    return `[提示：${parts.join('；')}。上述 OCR 文本并未覆盖全部图片，请勿默认已看到所有图片内容；`
      + `必要时请用户分批发送、精简图片，或改用支持看图的多模态模型复核。]`;
  } catch {
    return null; // fail-safe:任何异常都视为「不告诫」,逐字节回退
  }
}

module.exports = {
  isEnabled,
  computeCoverage,
  buildCoverageNotice,
  FLAG,
};
