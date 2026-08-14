'use strict';

/**
 * Regression guard for the echoed user-message background block.
 *
 * renderUserMessage() draws each line of the user's message on a dark
 * background. It used to pad with String.prototype.padEnd (i.e. by `.length`),
 * so any CJK line — the common case in this Chinese-first tool — under-counted
 * its width and the colored block ended with a ragged right edge. The block
 * must instead pad by *display width* so every line ends at the same column and
 * the background forms a clean rectangle.
 */

const test = require('node:test');
const assert = require('node:assert');
const stringWidth = require('string-width');

const { renderUserMessage } = require('../../src/cli/spinner');

function captureBlockWidths(message) {
  const calls = [];
  const original = console.log;
  console.log = (line = '') => calls.push(String(line));
  try {
    renderUserMessage(message);
  } finally {
    console.log = original;
  }
  return calls
    .filter((l) => l.trim().length > 0) // drop the blank spacer lines
    .map((l) => stringWidth(l.replace(/\x1b\[[0-9;]*m/g, '')));
}

test('pure-CJK multi-line message renders a clean rectangle', () => {
  const widths = captureBlockWidths('完善Khy希望体验顺滑\n这是较短的一行');
  assert.ok(widths.length >= 2, 'expected one rendered line per input line');
  assert.strictEqual(new Set(widths).size, 1, `ragged block: widths=${widths}`);
});

test('mixed CJK + ASCII lines align to one width', () => {
  const widths = captureBlockWidths('mixed 中英文 line\nplain ascii only\n纯中文行内容');
  assert.strictEqual(new Set(widths).size, 1, `ragged block: widths=${widths}`);
});

test('single ASCII line still produces a padded block', () => {
  const widths = captureBlockWidths('hello world');
  assert.strictEqual(widths.length, 1);
  // padEnd(maxLen + 2) semantics preserved: leading space + content + 2 pad.
  assert.ok(widths[0] >= stringWidth('hello world'));
});
