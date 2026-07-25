'use strict';

/**
 * markdownToAst.js — deterministic Markdown → semantic document AST.
 *
 * The model is allowed to author in Markdown (the goal explicitly blesses "如
 * Markdown的#"): headings via #, bullet/numbered lists, quotes via >, code fences,
 * tables via pipes. We parse that SEMANTIC markup into the closed AST defined in
 * contentSchema.js. Crucially, this is a fixed deterministic parser — there is no
 * model in the loop and no presentation code is honored:
 *   - Page breaks come ONLY from an explicit sentinel line (default `[[newpage]]`),
 *     never from blank lines / form-feeds (防呆: no whitespace page-break hacks).
 *   - Inline emphasis **bold** / *italic* maps to SEMANTIC run flags, which the
 *     template later renders with its own emphasis font — it is not a format code.
 *   - Raw LaTeX/HTML inside text is left for contentSchema.validateDocument() to
 *     reject; this parser does not try to honor it.
 */

const PAGEBREAK_SENTINELS = [/^\s*\[\[\s*newpage\s*\]\]\s*$/i, /^\s*<<<\s*pagebreak\s*>>>\s*$/i];

/** Parse inline **bold** / *italic* / `code` into semantic runs. */
function parseInlineRuns(text) {
  const runs = [];
  let i = 0;
  const n = text.length;
  let buf = '';
  const flush = (extra) => {
    if (buf) runs.push({ text: buf });
    buf = '';
    if (extra) runs.push(extra);
  };
  while (i < n) {
    // **bold**
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > i + 1) { flush({ text: text.slice(i + 2, end), bold: true }); i = end + 2; continue; }
    }
    // *italic* (single, not part of **)
    if (text[i] === '*' && text[i + 1] !== '*') {
      const end = text.indexOf('*', i + 1);
      if (end > i) { flush({ text: text.slice(i + 1, end), italic: true }); i = end + 1; continue; }
    }
    // `inline code` → keep as plain semantic text (no styling claim)
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) { flush({ text: text.slice(i + 1, end) }); i = end + 1; continue; }
    }
    buf += text[i];
    i += 1;
  }
  flush();
  // Collapse to a single plain run when there is no emphasis — keeps the AST tidy.
  if (runs.length === 0) return [{ text: '' }];
  if (runs.length === 1 && !runs[0].bold && !runs[0].italic) return [{ text: runs[0].text }];
  return runs;
}

/** A paragraph block; uses plain `text` when there is no emphasis, else `runs`. */
function _paragraph(text) {
  const runs = parseInlineRuns(text);
  if (runs.length === 1 && !runs[0].bold && !runs[0].italic) return { type: 'paragraph', text: runs[0].text };
  return { type: 'paragraph', runs };
}

function _isTableSep(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}
function _splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/**
 * Convert a Markdown string to a document AST.
 * @param {string} markdown
 * @param {{ pagebreakSentinels?: RegExp[] }} [opts]
 * @returns {{ type: 'document', blocks: Array }}
 */
function markdownToAst(markdown, opts = {}) {
  const sentinels = opts.pagebreakSentinels || PAGEBREAK_SENTINELS;
  const src = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const blocks = [];

  let i = 0;
  let paraBuf = [];
  const flushPara = () => {
    if (paraBuf.length) {
      const text = paraBuf.join(' ').trim();
      if (text) blocks.push(_paragraph(text));
      paraBuf = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Explicit page break sentinel (deterministic — never whitespace).
    if (sentinels.some((re) => re.test(line))) {
      flushPara();
      blocks.push({ type: 'pagebreak' });
      i += 1;
      continue;
    }

    // Fenced code block.
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[1][0];
      const lang = fence[2] || undefined;
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker === '`' ? '`{3,}' : '~{3,}'}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // consume closing fence
      blocks.push({ type: 'code', text: body.join('\n'), ...(lang ? { lang } : {}) });
      continue;
    }

    // ATX heading.
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
      i += 1;
      continue;
    }

    // Blockquote (consume consecutive > lines).
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', text: q.join(' ').trim() });
      continue;
    }

    // Table (header row + separator + body).
    if (/\|/.test(line) && i + 1 < lines.length && _isTableSep(lines[i + 1])) {
      flushPara();
      const header = _splitRow(line);
      i += 2; // skip header + separator
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        rows.push(_splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', header, rows: rows.length ? rows : [header.map(() => '')] });
      continue;
    }

    // Lists (ordered / unordered) — consume consecutive item lines.
    const ulm = /^\s*[-*+]\s+(.*)$/.exec(line);
    const olm = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ulm || olm) {
      flushPara();
      const ordered = !!olm;
      const items = [];
      while (i < lines.length) {
        const um = /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        const om = /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]);
        if (ordered && om) items.push(om[1].trim());
        else if (!ordered && um) items.push(um[1].trim());
        else break;
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Horizontal rule → ignored (NOT a page break; pagination is template-driven).
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      i += 1;
      continue;
    }

    // Blank line ends a paragraph.
    if (!line.trim()) {
      flushPara();
      i += 1;
      continue;
    }

    // Otherwise accumulate into the current paragraph.
    paraBuf.push(line.trim());
    i += 1;
  }
  flushPara();

  return { type: 'document', blocks };
}

module.exports = { markdownToAst, parseInlineRuns, PAGEBREAK_SENTINELS };
