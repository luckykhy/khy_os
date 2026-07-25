'use strict';

/**
 * markdownTableWrap — 纯叶子:markdown 表格单元格「换行而非截断」。
 *
 * 对齐 CC `src/components/MarkdownTable.tsx` 的 `wrapText`:CC 在单元格内容超过列宽时
 * 把文本**按词边界折到多行**(明确「Wrapping text within cells (no truncation)」),
 * 内容永不被静默丢弃。Khy 既有 `markdownRenderer._formatTableFromData` 在
 * `plainWidth > colWidths[col]` 时调 `truncateToWidth` **截断**单元格(吞内容 + 追 `…`),
 * 这是与 CC 后端逻辑的真分歧:对比矩阵类表格会丢列内容。
 *
 * 本叶子只做「给定纯文本 + 列宽 + 量宽函数 → 折出的行数组」这一确定性计算(渲染器无关):
 * 词边界贪心装箱,超过列宽的单 token 才按显示宽度硬切(CJK 安全),绝不丢字。
 * 量宽函数由调用方注入(渲染器传 `formatters.displayWidth`),保持本叶子零依赖、零 IO、
 * 确定性、绝不抛(leaf-contract)。门控 `KHY_TABLE_CELL_WRAP`(默认开)由渲染器读取,
 * 关 → 渲染器走旧截断分支逐字节回退;本叶子同时导出 `tableCellWrapEnabled` 供纯测。
 */

/**
 * Read the KHY_TABLE_CELL_WRAP gate. Default ON; only the canonical off-tokens
 * (`0`/`false`/`off`/`no`, case-insensitive) disable it, matching the project's
 * gate convention. Pure: reads env, never mutates.
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function tableCellWrapEnabled(env = process.env) {
  const flag = String((env && env.KHY_TABLE_CELL_WRAP) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * Hard-split a single token that is wider than the column, by display width,
 * so no fragment overflows. CJK/surrogate-aware via the injected measure fn.
 * @param {string} token
 * @param {number} width  positive integer column width
 * @param {(s:string)=>number} measure
 * @returns {string[]}
 */
function _hardSplitToken(token, width, measure) {
  const out = [];
  let cur = '';
  let curW = 0;
  for (const ch of Array.from(token)) {
    const w = measure(ch);
    if (curW + w > width && cur !== '') {
      out.push(cur);
      cur = ch;
      curW = w;
    } else {
      cur += ch;
      curW += w;
    }
  }
  if (cur !== '') out.push(cur);
  return out.length ? out : [''];
}

/**
 * Wrap a cell's plain text to `width` display columns at word boundaries.
 * Mirrors CC MarkdownTable.wrapText: greedy word packing; an over-wide single
 * token is hard-split; whitespace at a wrap boundary is dropped. Never truncates,
 * never throws — on any anomaly returns the text as a single line.
 * @param {string} plainText  markdown-stripped cell text (no embedded newlines)
 * @param {number} width      target column width (display columns)
 * @param {(s:string)=>number} [measure]  display-width fn (defaults to .length)
 * @returns {string[]}  one or more lines, each ≤ width display columns; ['' ] for empty
 */
function wrapCellLines(plainText, width, measure) {
  try {
    const text = String(plainText == null ? '' : plainText);
    const w = Number.isFinite(width) && width > 0 ? Math.floor(width) : 1;
    const m = typeof measure === 'function' ? measure : (s) => String(s).length;
    if (text === '') return [''];
    if (m(text) <= w) return [text];

    const tokens = text.match(/\s+|\S+/g) || [];
    const lines = [];
    let cur = '';
    let curW = 0;
    // Trim trailing whitespace on flush: a space that fit but whose following
    // word didn't would otherwise leave a dangling space at the line end.
    const flush = () => { lines.push(cur.replace(/\s+$/, '')); cur = ''; curW = 0; };

    for (const tok of tokens) {
      const tw = m(tok);
      if (/^\s+$/.test(tok)) {
        // Whitespace only matters mid-line; at a line start it is dropped so
        // wrapped continuation lines don't begin with stray spaces.
        if (cur === '') continue;
        if (curW + tw > w) { flush(); continue; }
        cur += tok;
        curW += tw;
        continue;
      }
      if (tw > w) {
        // Token wider than the whole column: flush, then hard-split.
        if (cur !== '') flush();
        const parts = _hardSplitToken(tok, w, m);
        for (let i = 0; i < parts.length - 1; i++) lines.push(parts[i]);
        cur = parts[parts.length - 1];
        curW = m(cur);
        continue;
      }
      if (curW + tw > w) flush();
      cur += tok;
      curW += tw;
    }
    flush();
    return lines.length ? lines : [''];
  } catch {
    // Fail-soft: never break table rendering — fall back to the text as one line.
    return [String(plainText == null ? '' : plainText)];
  }
}

module.exports = { wrapCellLines, tableCellWrapEnabled, _hardSplitToken };
