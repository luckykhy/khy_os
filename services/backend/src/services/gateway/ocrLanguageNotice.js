'use strict';

/**
 * ocrLanguageNotice.js — 纯叶子:当「纯文本模型 + 图片 → 本地 OCR 兜底」时,若 khy 请求的 OCR 语言
 * (如 `chi_sim+eng`)在本机**缺少对应 traineddata 语言包**而被静默窄化成一个子集(如仅 `eng`),
 * 则被丢弃语言的文字**根本无法被识别**(输出乱码 / 空 / 被英文模型错误转写),此时追加一句诚实告诫:
 * 告诉文本模型「某些语言的文字未能识别」,并给出安装语言包的出路。
 *
 * 背景(/goal 2026-07-12,直击「能在没有识别图形的模型下**准确**识别图片」;与 ocrConfidenceCaveat
 * 「准确性」、ocrCoverageNotice「跨图完整性」、ocrTruncationNotice「单图内文本完整性」三条正交,本叶
 * 补**语言包可用性**——第四条诚实轴):`docHelper.py._resolve_lang` 把请求的 `a+b+c` 语言谱窄化成本机
 * 实际装了 traineddata 的子集,此前 JSON 只返回窄化后的 `lang`,从不返回原始请求,更无「哪些语言因
 * 缺包被丢弃」的信号 → 中文图 + 仅装 eng 时,khy 用英文模型 OCR 出乱码却仍告知模型「据此作答」,
 * 用户在「没有识别图形的模型下」拿到的不是准确识别、而是被沉默吞掉的语言。本轮把 requestedLang
 * 一路暴露到明细,本叶做请求减生效的集合差算出被丢弃语言并渲染告诫。
 *
 * 诚实边界(B2/B3):
 *   - 只在**真有语言被丢弃**(requestedLang 含、而 effective lang 不含的语言)时告诫;无丢弃 /
 *     无法内省(Python 原样返回请求)/ 门关 / 畸形 → null,逐字节回退,绝不误报。
 *   - `osd`(仅方向/脚本检测,非文字语言)不计入丢弃。
 *   - 只装饰:不改成败归属、不改剥图/清图不变量;任何异常 fail-safe 视为「不告诫」,绝不抛。
 *
 * 门控 KHY_OCR_LANGUAGE_NOTICE(default-on,仅 0/false/off/no 关)。
 *
 * @module services/gateway/ocrLanguageNotice
 */

const { isFlagEnabled } = require('../flagRegistry');

const FLAG = 'KHY_OCR_LANGUAGE_NOTICE';

/** 门是否开(default-on;不可用/异常 → fail-safe 视为关,绝不误注入)。 */
function isEnabled(env) {
  try {
    return isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

/** 把 'a+b+c' 语言谱切成去重、去空、排除 osd 的数组;非字符串 → []。 */
function _parts(spec) {
  if (typeof spec !== 'string') return [];
  const out = [];
  for (const raw of spec.split('+')) {
    const p = raw.trim();
    if (!p || p.toLowerCase() === 'osd') continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * 跨一批 OCR 明细,算出被静默丢弃的语言集合(请求了、但实际 OCR 未生效的语言)。
 * 每条明细:requestedLang(原始请求谱)减 lang(实际生效谱)= 该图被丢弃的语言。
 * 非数组 / 缺字段 / 二者相等 → 不产生丢弃。返回去重、稳定排序的数组;绝不抛。
 * @param {Array<{lang?:string, requestedLang?:string}>} details
 * @returns {string[]}
 */
function computeDroppedLangs(details) {
  if (!Array.isArray(details)) return [];
  const dropped = new Set();
  for (const d of details) {
    if (!d || typeof d !== 'object') continue;
    const requested = _parts(d.requestedLang);
    if (requested.length === 0) continue;
    const effective = new Set(_parts(d.lang));
    for (const lang of requested) {
      if (!effective.has(lang)) dropped.add(lang);
    }
  }
  return Array.from(dropped).sort();
}

/**
 * 构造语言包缺失告诫句;不满足则返回 null(调用方据此决定是否追加)。
 * 返回 null 的情形:门关 / dropped 非数组或空。
 * @param {{dropped?:string[], env?:object}} [opts]
 * @returns {string|null}
 */
function buildLanguageNotice({ dropped, env } = {}) {
  if (!isEnabled(env)) return null;
  if (!Array.isArray(dropped) || dropped.length === 0) return null;
  const list = dropped.join('、');
  return `[提示：本机未安装以下 OCR 语言包：${list}；若图片中包含这些语言的文字，它们可能未被识别`
    + `或被错误转写，上述 OCR 文本对这些语言并不可靠。请勿据此断定这些文字的内容；可安装对应语言包`
    + `（如 apt install tesseract-ocr-${dropped[0]}）后重试，或改用支持看图的多模态模型复核。]`;
}

module.exports = {
  isEnabled,
  computeDroppedLangs,
  buildLanguageNotice,
  FLAG,
};
