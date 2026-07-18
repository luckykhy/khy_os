'use strict';

/**
 * textAddress.js — 文本的**精确定位**与**按位置替换**（纯函数，可测，零依赖）。
 *
 * 目标（来自 /goal「文中同一个词如果出现，精确替换文中的某个词，如第二段第二句」）：
 * 当某个词在全文多次出现时，按 {段落, 句子, 第几次出现} 精确定位，只替换那一处，
 * 绝不退化成全局查找替换。
 *
 * 关键：所有切分都是**偏移保真**的——返回每个段落/句子在原文中的 [start,end)
 * 字符区间，替换在原始字符串上按区间裁切重组，保证除目标处外原文逐字不变。
 *
 * 寻址（均 1 基，贴合人类「第二段第二句」直觉）：
 *   paragraph N    第 N 段（空行分隔；保留段内换行）
 *   sentence M     第 N 段内第 M 句（句末标点 。！？!?；; 或英文 ". " 边界）
 *   occurrence K   定位范围内 word 的第 K 次出现（默认 1；'all' = 范围内全部）
 */

/** 段落：以一个或多个空行分隔。返回 [{index,start,end,text}]，偏移保真。 */
function splitParagraphs(text) {
  const s = String(text == null ? '' : text);
  const paras = [];
  // 匹配连续非空白段：段之间由「至少一个仅含空白的行」分隔。
  const re = /(?:[^\S\r\n]*\r?\n){2,}|(?:\r?\n[^\S\r\n]*){2,}/g; // 保底；下面用更稳的扫描
  // 用逐行扫描更稳：累积行，遇到空行作为分隔。
  let idx = 0;
  let curStart = -1;
  let i = 0;
  const n = s.length;
  // 以行为单位推进
  const pushPara = (start, end) => {
    // 去掉尾随纯空白但保留内部；用 trimEnd 计算真实 end
    let e = end;
    while (e > start && /\s/.test(s[e - 1])) e--;
    let b = start;
    while (b < e && /\s/.test(s[b])) b++;
    if (e > b) {
      paras.push({ index: paras.length + 1, start: b, end: e, text: s.slice(b, e) });
    }
  };
  while (i < n) {
    // 读到行尾
    let lineStart = i;
    while (i < n && s[i] !== '\n') i++;
    const lineEnd = i; // exclusive of \n
    const lineContent = s.slice(lineStart, lineEnd).replace(/\r$/, '');
    const isBlank = lineContent.trim() === '';
    if (isBlank) {
      if (curStart !== -1) { pushPara(curStart, lineStart); curStart = -1; }
    } else if (curStart === -1) {
      curStart = lineStart;
    }
    if (i < n) i++; // skip \n
  }
  if (curStart !== -1) pushPara(curStart, n);
  void re; void idx;
  return paras;
}

/**
 * 句子切分（偏移保真，**保留**句末标点在句内）。
 * @param {string} text 整篇或段落文本
 * @param {number} [base] 该文本在更大字符串中的起始偏移（用于回填全局区间）
 * @returns {Array<{index,start,end,text}>}
 */
function splitSentences(text, base = 0) {
  const s = String(text == null ? '' : text);
  const out = [];
  const n = s.length;
  let segStart = 0;
  let idx = 0;
  const flush = (segEnd) => {
    // 去掉两端空白但保留偏移
    let b = segStart, e = segEnd;
    while (b < e && /\s/.test(s[b])) b++;
    while (e > b && /\s/.test(s[e - 1])) e--;
    if (e > b) {
      idx++;
      out.push({ index: idx, start: base + b, end: base + e, text: s.slice(b, e) });
    }
    segStart = segEnd;
  };
  let i = 0;
  while (i < n) {
    const c = s[i];
    // CJK 句末标点：终止符自身归入当前句
    if (c === '。' || c === '！' || c === '？' || c === '；') {
      flush(i + 1); i++; continue;
    }
    // 西文句末：. ! ? ; 后接空白/换行/结尾 才算边界（避免 3.14 / e.g.）
    if (c === '.' || c === '!' || c === '?' || c === ';') {
      const next = i + 1 < n ? s[i + 1] : '';
      if (next === '' || /\s/.test(next)) { flush(i + 1); i++; continue; }
    }
    // 换行也作为软边界（多数文档一句一行或段内列举）
    if (c === '\n') {
      // 连续换行已被段落层处理；这里把单换行作为句界，避免跨行误判
      flush(i + 1); i++; continue;
    }
    i++;
  }
  if (segStart < n) flush(n);
  return out;
}

/** 在 [start,end) 区间内查找 word 的所有出现（精确子串），返回区间内的相对/绝对偏移。 */
function _findOccurrences(full, word, start, end) {
  const hits = [];
  if (!word) return hits;
  let from = start;
  while (from <= end - word.length) {
    const at = full.indexOf(word, from);
    if (at === -1 || at + word.length > end) break;
    hits.push(at);
    from = at + word.length; // 不重叠
  }
  return hits;
}

/**
 * 精确定位替换。
 *
 * @param {string} text 原文
 * @param {object} loc
 * @param {string} loc.word         要替换的词（精确子串）
 * @param {string} loc.replacement  替换为
 * @param {number} [loc.paragraph]  第几段（1 基）；省略=全文范围
 * @param {number} [loc.sentence]   段内第几句（1 基）；需配合 paragraph
 * @param {number|'all'} [loc.occurrence] 范围内第几次出现（1 基，默认 1）；'all'=全部
 * @returns {{ok:boolean, text?:string, replaced?:number, scope?:object, error?:string, hint?:string, available?:object}}
 */
function replaceAtLocation(text, loc = {}) {
  const s = String(text == null ? '' : text);
  const { word, replacement } = loc;
  if (typeof word !== 'string' || word.length === 0) {
    return { ok: false, error: 'word（要替换的词）必填且非空。' };
  }
  if (typeof replacement !== 'string') {
    return { ok: false, error: 'replacement（替换为）必填（可为空字符串以删除）。' };
  }

  // 1) 确定作用区间 [start,end)
  let start = 0, end = s.length;
  let scope = { kind: 'document' };
  if (loc.paragraph != null) {
    const paras = splitParagraphs(s);
    const p = paras[loc.paragraph - 1];
    if (!p) {
      return { ok: false, error: `第 ${loc.paragraph} 段不存在。`, hint: `全文共 ${paras.length} 段。`, available: { paragraphs: paras.length } };
    }
    start = p.start; end = p.end; scope = { kind: 'paragraph', paragraph: loc.paragraph, text: p.text };

    if (loc.sentence != null) {
      const sents = splitSentences(s.slice(p.start, p.end), p.start);
      const sent = sents[loc.sentence - 1];
      if (!sent) {
        return { ok: false, error: `第 ${loc.paragraph} 段第 ${loc.sentence} 句不存在。`, hint: `该段共 ${sents.length} 句。`, available: { sentences: sents.length } };
      }
      start = sent.start; end = sent.end; scope = { kind: 'sentence', paragraph: loc.paragraph, sentence: loc.sentence, text: sent.text };
    }
  }

  // 2) 范围内定位 word
  const hits = _findOccurrences(s, word, start, end);
  if (hits.length === 0) {
    const globalHits = _findOccurrences(s, word, 0, s.length).length;
    return {
      ok: false,
      error: `在指定位置（${_scopeLabel(scope)}）未找到「${word}」。`,
      hint: globalHits > 0
        ? `「${word}」在全文共出现 ${globalHits} 次，但不在该位置——请核对段/句序号。`
        : `「${word}」在全文中也不存在，请核对原词。`,
      available: { inScope: 0, inDocument: globalHits },
    };
  }

  // 3) 选择第 K 次（或全部）
  const occ = loc.occurrence;
  let targets;
  if (occ === 'all') {
    targets = hits;
  } else {
    const k = occ == null ? 1 : Number(occ);
    if (!Number.isInteger(k) || k < 1) return { ok: false, error: 'occurrence 必须是 ≥1 的整数或 "all"。' };
    if (k > hits.length) {
      return { ok: false, error: `范围内「${word}」只出现 ${hits.length} 次，无法替换第 ${k} 次。`, available: { inScope: hits.length } };
    }
    targets = [hits[k - 1]];
  }

  // 4) 从后往前替换（保持前面偏移不变）
  let out = s;
  const ordered = targets.slice().sort((a, b) => b - a);
  for (const at of ordered) {
    out = out.slice(0, at) + replacement + out.slice(at + word.length);
  }

  return { ok: true, text: out, replaced: targets.length, scope };
}

function _scopeLabel(scope) {
  if (scope.kind === 'sentence') return `第${scope.paragraph}段第${scope.sentence}句`;
  if (scope.kind === 'paragraph') return `第${scope.paragraph}段`;
  return '全文';
}

/** 仅定位、不替换——用于预览「某词在第几段第几句出现」。 */
function locateWord(text, word) {
  const s = String(text == null ? '' : text);
  const paras = splitParagraphs(s);
  const found = [];
  for (const p of paras) {
    const sents = splitSentences(s.slice(p.start, p.end), p.start);
    for (const sent of sents) {
      const hits = _findOccurrences(s, word, sent.start, sent.end);
      hits.forEach((at, k) => {
        found.push({ paragraph: p.index, sentence: sent.index, occurrenceInSentence: k + 1, offset: at });
      });
    }
  }
  return found;
}

module.exports = {
  splitParagraphs,
  splitSentences,
  replaceAtLocation,
  locateWord,
};
