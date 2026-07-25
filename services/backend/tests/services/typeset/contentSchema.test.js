/**
 * contentSchema.test.js — the semantic AST grammar + 防呆 format-code interception.
 *
 * Asserts that structurally valid documents pass, that every forbidden
 * presentation code (LaTeX / HTML / docx-XML / inline CSS / RTF) is rejected, and
 * that a code block's body is EXEMPT from the scan (rendered verbatim, never
 * interpreted).
 */
'use strict';

const {
  BLOCK_TYPES,
  scanFormatCodes,
  validateBlock,
  validateDocument,
  DOCUMENT_JSON_SCHEMA,
} = require('../../../src/services/typeset/contentSchema');

describe('contentSchema — block grammar', () => {
  test('accepts a well-formed document', () => {
    const doc = {
      type: 'document',
      title: '测试论文',
      blocks: [
        { type: 'heading', level: 1, text: '引言' },
        { type: 'paragraph', text: '这是正文。' },
        { type: 'paragraph', runs: [{ text: '强调', bold: true }, { text: '普通' }] },
        { type: 'list', ordered: true, items: ['第一', '第二'] },
        { type: 'table', header: ['列A', '列B'], rows: [['1', '2']] },
        { type: 'quote', text: '引文。' },
        { type: 'code', text: 'print("hi")', lang: 'python' },
        { type: 'pagebreak' },
        { type: 'reference', entries: ['[1] 作者. 标题. 出版社, 2020.'] },
      ],
    };
    expect(validateDocument(doc)).toEqual({ valid: true });
  });

  test('rejects unknown block type', () => {
    const r = validateBlock({ type: 'banner', text: 'x' }, 0);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/unknown type/);
  });

  test('rejects heading with out-of-range level', () => {
    expect(validateBlock({ type: 'heading', level: 9, text: 'x' }, 0).valid).toBe(false);
    expect(validateBlock({ type: 'heading', level: 0, text: 'x' }, 0).valid).toBe(false);
  });

  test('rejects empty heading text', () => {
    expect(validateBlock({ type: 'heading', level: 1, text: '   ' }, 0).valid).toBe(false);
  });

  test('paragraph requires text or runs', () => {
    expect(validateBlock({ type: 'paragraph' }, 0).valid).toBe(false);
    expect(validateBlock({ type: 'paragraph', text: 'ok' }, 0).valid).toBe(true);
  });

  test('list items must be a non-empty array of strings', () => {
    expect(validateBlock({ type: 'list', items: [] }, 0).valid).toBe(false);
    expect(validateBlock({ type: 'list', items: [1, 2] }, 0).valid).toBe(false);
  });

  test('table rows must be arrays of strings', () => {
    expect(validateBlock({ type: 'table', rows: 'nope' }, 0).valid).toBe(false);
    expect(validateBlock({ type: 'table', rows: [['ok']] }, 0).valid).toBe(true);
  });

  test('document.blocks must be an array', () => {
    expect(validateDocument({ blocks: 'x' }).valid).toBe(false);
  });

  test('document.type, if present, must be "document"', () => {
    expect(validateDocument({ type: 'paper', blocks: [] }).valid).toBe(false);
  });

  test('BLOCK_TYPES is a closed set matching the JSON schema enum', () => {
    const enumVals = DOCUMENT_JSON_SCHEMA.properties.blocks.items.properties.type.enum;
    expect(new Set(enumVals)).toEqual(BLOCK_TYPES);
  });
});

describe('contentSchema — 防呆 format-code interception', () => {
  const forbidden = [
    ['LaTeX command', '\\textbf{粗体}'],
    ['LaTeX command', '请在此处 \\newpage 换页'],
    ['LaTeX command', '\\vspace{1cm}'],
    ['LaTeX command', '\\section{标题}'],
    ['LaTeX macro', '\\customcmd{x}'],
    ['HTML/XML tag', '正文 <b>粗</b>'],
    ['HTML/XML tag', '<font size="3">大</font>'],
    ['HTML/XML tag', '<w:rPr><w:b/></w:rPr>'],
    ['HTML/XML tag', '<p style="font-size:12pt">x</p>'],
    ['inline CSS', '段落 style="color:red;font-weight:bold" 结束'],
    ['RTF control word', '{\\rtf1 hello}'],
  ];

  test.each(forbidden)('scanFormatCodes flags %s', (label, text) => {
    const scan = scanFormatCodes(text);
    expect(scan.clean).toBe(false);
    expect(scan.label).toBe(label);
  });

  test('ordinary prose with punctuation is clean', () => {
    expect(scanFormatCodes('成本约为 12.5 元/件，占比 < 30%。').clean).toBe(true);
    expect(scanFormatCodes('使用 a < b 与 x > y 的不等式。').clean).toBe(true);
  });

  test('validateDocument rejects a smuggled LaTeX command in a paragraph', () => {
    const r = validateDocument({ blocks: [{ type: 'paragraph', text: '正文 \\textbf{x}' }] });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/LaTeX command/);
  });

  test('validateDocument rejects an HTML tag inside a list item', () => {
    const r = validateDocument({ blocks: [{ type: 'list', items: ['<b>x</b>'] }] });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/HTML\/XML tag/);
  });

  test('validateDocument rejects a format code in the title', () => {
    const r = validateDocument({ title: '\\textbf{标题}', blocks: [] });
    expect(r.valid).toBe(false);
  });

  test('code block body is EXEMPT — backslashes and tags render verbatim', () => {
    const r = validateDocument({
      blocks: [{ type: 'code', text: '\\textbf{this is literal}\n<b>so is this</b>', lang: 'tex' }],
    });
    expect(r).toEqual({ valid: true });
  });
});
