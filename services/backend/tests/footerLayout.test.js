'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { stripAnsi, truncatePlain, composePermissionFooter } = require('../src/cli/repl/footerLayout');

// 原始 _buildPermissionBarText 尾部布局逻辑的逐字副本，用于等价性对照（identity 样式）。
function originalCompose(permLeft, rightPlainRaw, cols, dim) {
  const _strip = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
  const _trunc = (s, n) => {
    const text = String(s || '');
    if (n <= 0) return '';
    if (text.length <= n) return text;
    return n <= 1 ? text.slice(0, n) : `${text.slice(0, n - 1)}…`;
  };
  const maxRightLen = Math.max(0, cols - 8);
  const rightPlain = _trunc(rightPlainRaw, maxRightLen);
  const rightText = rightPlain ? dim(rightPlain) : '';
  const plainLeft = _strip(permLeft);
  const rightLen = _strip(rightText).length;
  const leftBudget = Math.max(1, cols - rightLen - 2);
  const safeLeft = plainLeft.length > leftBudget
    ? dim(plainLeft.slice(0, Math.max(1, leftBudget - 1)) + '…')
    : permLeft;
  const leftLen = _strip(safeLeft).length;
  const pad = Math.max(1, cols - leftLen - rightLen - 1);
  const line = safeLeft + ' '.repeat(pad) + rightText;
  const plainLine = _strip(line);
  const maxFooterCols = Math.max(1, cols - 1);
  if (plainLine.length > maxFooterCols) {
    return dim(_trunc(plainLine, maxFooterCols));
  }
  return line;
}

const id = (s) => s;

test('stripAnsi 去色，truncatePlain 边界正确', () => {
  assert.strictEqual(stripAnsi('\x1b[2mhi\x1b[22m'), 'hi');
  assert.strictEqual(truncatePlain('hello', 10), 'hello');
  assert.strictEqual(truncatePlain('hello', 3), 'he…');
  assert.strictEqual(truncatePlain('hello', 1), 'h');
  assert.strictEqual(truncatePlain('hello', 0), '');
  assert.strictEqual(truncatePlain(null, 5), '');
});

test('与原始内联算法逐字节等价（identity 样式）', () => {
  const cases = [
    ['accept edits on', '12% ctx · 80% until auto-compact', 80],
    ['(shift+tab to cycle)', '', 80],
    ['bypass permissions on', '50% ctx', 40],
    ['ask before all tools on', '99% ctx · 1% until auto-compact', 20],
    ['very long permission label that exceeds budget for sure', '95% ctx', 24],
    ['x', 'a · b · c', 10],
    ['mode', 'right', 8],
    ['mode', 'right', 5],
  ];
  for (const [left, right, cols] of cases) {
    assert.strictEqual(
      composePermissionFooter({ permLeft: left, rightPlain: right, cols, dim: id }),
      originalCompose(left, right, cols, id),
      `不等价: left=${JSON.stringify(left)} right=${JSON.stringify(right)} cols=${cols}`,
    );
  }
});

test('整行永不超出 cols-1（硬钳位）', () => {
  for (const cols of [80, 40, 20, 10, 8, 5, 3]) {
    const line = composePermissionFooter({
      permLeft: 'some long label here', rightPlain: '12% ctx · 80% until auto-compact', cols, dim: id,
    });
    assert.ok(stripAnsi(line).length <= Math.max(1, cols - 1),
      `cols=${cols} 行宽 ${stripAnsi(line).length} 超钳位`);
  }
});

test('空右侧 → 仅左标签 + 补白，无尾随信息', () => {
  const line = composePermissionFooter({ permLeft: 'L', rightPlain: '', cols: 80, dim: id });
  assert.ok(line.startsWith('L'));
  assert.strictEqual(stripAnsi(line).trimEnd(), 'L');
});

test('cols 缺省/非正 → 退化为 80，不抛', () => {
  assert.doesNotThrow(() => composePermissionFooter({ permLeft: 'L', rightPlain: 'R', cols: 0, dim: id }));
  assert.doesNotThrow(() => composePermissionFooter({ permLeft: 'L', rightPlain: 'R', cols: undefined }));
});
