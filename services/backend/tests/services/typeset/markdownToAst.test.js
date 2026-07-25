/**
 * markdownToAst.test.js — deterministic Markdown → semantic AST.
 *
 * The parser honors only SEMANTIC markup (headings, lists, quotes, tables, code,
 * bold/italic emphasis). Page breaks come ONLY from an explicit sentinel, never
 * from blank lines or horizontal rules (防呆: no whitespace page-break hacks).
 */
'use strict';

const { markdownToAst, parseInlineRuns, PAGEBREAK_SENTINELS } = require('../../../src/services/typeset/markdownToAst');

describe('markdownToAst — block parsing', () => {
  test('ATX headings carry their level', () => {
    const { blocks } = markdownToAst('# 一级\n## 二级\n### 三级');
    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: '一级' },
      { type: 'heading', level: 2, text: '二级' },
      { type: 'heading', level: 3, text: '三级' },
    ]);
  });

  test('blank line separates paragraphs; wrapped lines join with a space', () => {
    const { blocks } = markdownToAst('第一段第一行\n第一段第二行\n\n第二段');
    expect(blocks).toEqual([
      { type: 'paragraph', text: '第一段第一行 第一段第二行' },
      { type: 'paragraph', text: '第二段' },
    ]);
  });

  test('unordered and ordered lists', () => {
    const ul = markdownToAst('- a\n- b').blocks[0];
    expect(ul).toEqual({ type: 'list', ordered: false, items: ['a', 'b'] });
    const ol = markdownToAst('1. a\n2. b').blocks[0];
    expect(ol).toEqual({ type: 'list', ordered: true, items: ['a', 'b'] });
  });

  test('blockquote consumes consecutive > lines', () => {
    const { blocks } = markdownToAst('> 引文一\n> 引文二');
    expect(blocks[0]).toEqual({ type: 'quote', text: '引文一 引文二' });
  });

  test('fenced code preserves body verbatim and captures lang', () => {
    const { blocks } = markdownToAst('```python\nprint(1)\n  indented\n```');
    expect(blocks[0]).toEqual({ type: 'code', text: 'print(1)\n  indented', lang: 'python' });
  });

  test('pipe table → header + rows', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |';
    expect(markdownToAst(md).blocks[0]).toEqual({
      type: 'table',
      header: ['A', 'B'],
      rows: [['1', '2'], ['3', '4']],
    });
  });
});

describe('markdownToAst — deterministic pagination (防呆)', () => {
  test('[[newpage]] sentinel produces a pagebreak block', () => {
    const { blocks } = markdownToAst('前文\n\n[[newpage]]\n\n后文');
    expect(blocks).toEqual([
      { type: 'paragraph', text: '前文' },
      { type: 'pagebreak' },
      { type: 'paragraph', text: '后文' },
    ]);
  });

  test('<<<pagebreak>>> sentinel also works', () => {
    expect(markdownToAst('a\n<<< pagebreak >>>\nb').blocks.some((b) => b.type === 'pagebreak')).toBe(true);
  });

  test('horizontal rule is NOT a page break (ignored)', () => {
    const { blocks } = markdownToAst('a\n\n---\n\nb');
    expect(blocks.find((b) => b.type === 'pagebreak')).toBeUndefined();
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
  });

  test('blank lines never create a page break', () => {
    const { blocks } = markdownToAst('a\n\n\n\n\nb');
    expect(blocks.some((b) => b.type === 'pagebreak')).toBe(false);
  });

  test('PAGEBREAK_SENTINELS is exported and non-empty', () => {
    expect(Array.isArray(PAGEBREAK_SENTINELS)).toBe(true);
    expect(PAGEBREAK_SENTINELS.length).toBeGreaterThan(0);
  });
});

describe('parseInlineRuns — semantic emphasis (not format codes)', () => {
  test('plain text collapses to a single run', () => {
    expect(parseInlineRuns('纯文本')).toEqual([{ text: '纯文本' }]);
  });

  test('**bold** maps to a bold run flag', () => {
    expect(parseInlineRuns('前 **粗** 后')).toEqual([
      { text: '前 ' },
      { text: '粗', bold: true },
      { text: ' 后' },
    ]);
  });

  test('*italic* maps to an italic run flag', () => {
    expect(parseInlineRuns('*斜*')).toEqual([{ text: '斜', italic: true }]);
  });

  test('paragraph with emphasis becomes a runs[] block', () => {
    const blk = markdownToAst('这是 **重点** 内容').blocks[0];
    expect(blk.type).toBe('paragraph');
    expect(blk.runs).toEqual([
      { text: '这是 ' },
      { text: '重点', bold: true },
      { text: ' 内容' },
    ]);
  });
});
