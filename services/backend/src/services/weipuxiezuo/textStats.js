'use strict';

/**
 * weipuxiezuo/textStats.js — 中文文本的确定性统计层（纯函数，零副作用）。
 *
 * detector / scorer / constraints 共用的「客观度量」都在这里算一次：段落/句子切分、
 * 句长方差（突发性 burstiness 的代理量）、加粗数、显式引用数、化用年份标记数、
 * 数字/年份等具体性信号。全部不需要模型——这正是「用代码实现，不塞提示词」的地基：
 * 先有可复算的数，才谈得上打分与判合格。
 */

// 句子终止符（中英）。分号也作句界，贴合学术长句的语义停顿。
const SENTENCE_TERMINATORS = /[。！？!?；;]+/;

// 用于剥离不计入「自然语言长度」的标记：加粗、上标引用、裸角标、URL。
const STRIP_MARKUP = /\*\*|<\/?sup>|\[\s*\d+\s*\]|https?:\/\/\S+/g;

/**
 * 把文本切成段落，并保留每段在原文中的起始偏移（供 detector 定位）。
 * 主切分用「空行」(\n\n+)；若得不到 ≥2 段而文本含换行，回退到按单换行切。
 * @param {string} text
 * @returns {Array<{ text: string, start: number }>}
 */
function paragraphsWithOffsets(text) {
  const out = [];
  const re = /\n{2,}/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: text.slice(last, m.index), start: last });
    last = m.index + m[0].length;
  }
  out.push({ text: text.slice(last), start: last });
  let paras = out.filter((p) => p.text.trim().length > 0);

  if (paras.length < 2 && /\n/.test(text)) {
    const single = [];
    const re2 = /\n+/g;
    let last2 = 0;
    let m2;
    while ((m2 = re2.exec(text)) !== null) {
      single.push({ text: text.slice(last2, m2.index), start: last2 });
      last2 = m2.index + m2[0].length;
    }
    single.push({ text: text.slice(last2), start: last2 });
    const filtered = single.filter((p) => p.text.trim().length > 0);
    if (filtered.length > paras.length) paras = filtered;
  }
  return paras;
}

/**
 * 把一段/全文切成句子（非空，已 trim）。
 * @param {string} text
 * @returns {string[]}
 */
function sentences(text) {
  return String(text || '')
    .split(SENTENCE_TERMINATORS)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 「自然语言长度」：剥离 markdown/引用标记并去空白后的字符数。
 * @param {string} s
 * @returns {number}
 */
function naturalLength(s) {
  return String(s || '').replace(STRIP_MARKUP, '').replace(/\s+/g, '').length;
}

/**
 * 句长的变异系数 CV = 标准差 / 均值。人类学术写作长短句交错，CV 偏高；
 * AI 文本节奏均一，CV 偏低。是「突发性」最稳的确定性代理量。
 * @param {number[]} lengths
 * @returns {{ mean: number, std: number, cv: number }}
 */
function lengthVariation(lengths) {
  const n = lengths.length;
  if (n === 0) return { mean: 0, std: 0, cv: 0 };
  const mean = lengths.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return { mean: 0, std: 0, cv: 0 };
  const variance = lengths.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const std = Math.sqrt(variance);
  return { mean, std, cv: std / mean };
}

/** 显式引用：`<sup>[n]</sup>` 优先，兼容裸 `[n]` 角标。 */
const SUP_CITATION = /<sup>\s*\[\s*(\d{1,3})\s*\]\s*<\/sup>/g;
const BARE_CITATION = /(?<![\d\w])\[\s*(\d{1,3})\s*\](?![\d\w])/g;

/** 化用年份标记：(Author, 2023) / 张等（2022） / Entman（1993） / CNNIC, 2023。 */
const CITATION_YEAR = /[（(][^（）()\n]{0,28}(?:19|20)\d{2}[）)]/g;

/** 具体性信号：年份、带单位/百分比的数字。 */
const YEAR = /(?:19|20)\d{2}/g;
const NUMBER_UNIT = /\d+(?:\.\d+)?\s*(?:%|％|ms|s|分|项|个|人|次|倍|元|km|kg|°c)/gi;

function _countMatches(re, text) {
  re.lastIndex = 0;
  let c = 0;
  while (re.exec(text) !== null) c += 1;
  return c;
}

function _collectNumbers(re, text) {
  re.lastIndex = 0;
  const set = new Set();
  let m;
  while ((m = re.exec(text)) !== null) set.add(m[1] !== undefined ? m[1] : m[0]);
  return set;
}

/**
 * 计算全文级统计。
 * @param {string} text
 * @returns {{
 *   chars: number, paragraphCount: number, sentenceCount: number,
 *   sentenceLengths: number[], rhythm: {mean,std,cv},
 *   boldCount: number,
 *   explicitCitations: number, distinctCitationNumbers: number, citationNumbers: number[],
 *   huayongMarkers: number,
 *   yearCount: number, numberUnitCount: number,
 * }}
 */
function compute(text) {
  const src = String(text || '');
  const paras = paragraphsWithOffsets(src);
  const sents = sentences(src);
  const lengths = sents.map(naturalLength).filter((n) => n > 0);

  const supNumbers = _collectNumbers(SUP_CITATION, src);
  const supCount = _countMatches(SUP_CITATION, src);
  // 仅在没有 <sup> 角标时回退裸 [n]（避免对同一处重复计数）。
  let citationNumbers = supNumbers;
  let explicitCitations = supCount;
  if (supCount === 0) {
    citationNumbers = _collectNumbers(BARE_CITATION, src);
    explicitCitations = _countMatches(BARE_CITATION, src);
  }

  return {
    chars: naturalLength(src),
    paragraphCount: paras.length,
    sentenceCount: sents.length,
    sentenceLengths: lengths,
    rhythm: lengthVariation(lengths),
    boldCount: _countMatches(/\*\*[^*\n]+\*\*/g, src),
    explicitCitations,
    distinctCitationNumbers: citationNumbers.size,
    citationNumbers: [...citationNumbers].map((n) => parseInt(n, 10)),
    huayongMarkers: _countMatches(CITATION_YEAR, src),
    yearCount: _collectNumbers(YEAR, src).size,
    numberUnitCount: _countMatches(NUMBER_UNIT, src),
  };
}

module.exports = {
  paragraphsWithOffsets,
  sentences,
  naturalLength,
  lengthVariation,
  compute,
  // 正则导出供 detector 复用，避免重复定义。
  SENTENCE_TERMINATORS,
  CITATION_YEAR,
  SUP_CITATION,
  BARE_CITATION,
};
