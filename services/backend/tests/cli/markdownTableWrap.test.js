'use strict';

// markdownTableWrap 纯叶子:表格单元格「换行而非截断」(对齐 CC MarkdownTable.wrapText)。
// 验证词边界折行、超宽 token 硬切、内容零丢失、CJK 量宽、门控默认开 + 字节回退。
const test = require('node:test');
const assert = require('node:assert');
const {
  wrapCellLines,
  tableCellWrapEnabled,
} = require('../../src/cli/markdownTableWrap');

// ASCII: display width == char count.
const ascii = (s) => String(s).length;
// CJK: each non-ASCII code point counts as 2 columns (matches wcwidth-ish).
const cjk = (s) => Array.from(String(s)).reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2000 ? 2 : 1), 0);

test('内容能装下 → 单行返回原文(不折)', () => {
  assert.deepStrictEqual(wrapCellLines('short', 10, ascii), ['short']);
  assert.deepStrictEqual(wrapCellLines('exactfit!!', 10, ascii), ['exactfit!!']);
});

test('词边界贪心折行', () => {
  assert.deepStrictEqual(wrapCellLines('alpha beta gamma', 11, ascii), ['alpha beta', 'gamma']);
});

test('超过列宽的单 token 按显示宽度硬切(CJK 安全)', () => {
  assert.deepStrictEqual(wrapCellLines('abcdefghij', 4, ascii), ['abcd', 'efgh', 'ij']);
});

test('绝不截断/丢内容:所有词字符在折行后完整保留', () => {
  const text = 'the quick brown fox jumps over the lazy dog';
  const lines = wrapCellLines(text, 12, ascii);
  // 拼回所有非空白字符 == 原文非空白字符(折行只丢边界空白,绝不丢字)。
  const join = (s) => s.replace(/\s+/g, '');
  assert.strictEqual(lines.map(join).join(''), join(text));
  for (const l of lines) assert.ok(ascii(l) <= 12, `行宽 ${ascii(l)} 应 ≤12: ${JSON.stringify(l)}`);
});

test('CJK 按显示宽度折(每字 2 列)', () => {
  assert.deepStrictEqual(wrapCellLines('保存文件成功', 4, cjk), ['保存', '文件', '成功']);
});

test('续行不以游离空白开头(折行边界空白被丢弃)', () => {
  const lines = wrapCellLines('aaaa bbbb cccc', 4, ascii);
  for (const l of lines) assert.strictEqual(l, l.replace(/^\s+/, ''), '续行不应有前导空白');
  assert.deepStrictEqual(lines, ['aaaa', 'bbbb', 'cccc']);
});

test('空串 → 单个空行', () => {
  assert.deepStrictEqual(wrapCellLines('', 5, ascii), ['']);
});

test('width<=0 退化为 1 而非崩溃', () => {
  const lines = wrapCellLines('abc', 0, ascii);
  assert.ok(Array.isArray(lines) && lines.length >= 1);
  for (const l of lines) assert.ok(ascii(l) <= 1);
});

test('绝不抛:坏入参 fail-soft 返回单行', () => {
  assert.doesNotThrow(() => wrapCellLines(null, 5));
  assert.doesNotThrow(() => wrapCellLines(undefined, 5, ascii));
  assert.doesNotThrow(() => wrapCellLines('x', 5, /* bad measure */ 123));
  assert.deepStrictEqual(wrapCellLines(null, 5, ascii), ['']);
  // 数字被字符串化
  assert.deepStrictEqual(wrapCellLines(42, 5, ascii), ['42']);
});

test('每行显示宽度都 ≤ 列宽(无溢出)', () => {
  const lines = wrapCellLines('supercalifragilistic expialidocious word', 7, ascii);
  for (const l of lines) assert.ok(ascii(l) <= 7, `溢出: ${JSON.stringify(l)} = ${ascii(l)}`);
});

test('门控 tableCellWrapEnabled 默认开', () => {
  assert.strictEqual(tableCellWrapEnabled({}), true);
});

test('门控关 token(0/false/off/no,大小写无关)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off', ' NO ']) {
    assert.strictEqual(tableCellWrapEnabled({ KHY_TABLE_CELL_WRAP: v }), false, `=${v} 应关`);
  }
});

test('门控其他值 → 开', () => {
  assert.strictEqual(tableCellWrapEnabled({ KHY_TABLE_CELL_WRAP: '1' }), true);
  assert.strictEqual(tableCellWrapEnabled({ KHY_TABLE_CELL_WRAP: 'yes' }), true);
});
