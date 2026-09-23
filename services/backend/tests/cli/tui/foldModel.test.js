'use strict';

// foldModel + foldLongLines — H5 click-expand / line-height signature.
// `node --test`.

const test = require('node:test');
const assert = require('node:assert');
const { makeFoldItem, lineHeightSignature, toggle, currentRows } = require('../../../src/cli/tui/foldModel');
const { foldLongLines } = require('../../../src/cli/tui/foldLongLines');

// ── H5: signature changes when expanded flips ───────────────────────────────
test('H5: line-height signature changes when expanded state changes', () => {
  const item = makeFoldItem({ id: 't', kind: 'tool', text: 'a'.repeat(120), width: 40 });
  assert.equal(item.expanded, false);
  const s1 = lineHeightSignature(item);
  toggle(item);
  const s2 = lineHeightSignature(item);
  assert.notEqual(s1, s2, 'expand → 签名必变(防陈旧行高复现残影)');
  toggle(item);
  assert.equal(lineHeightSignature(item), s1, '再 toggle 回折叠态 → 签名还原');
});

test('line-height signature is stable for equal (kind, rows, expanded)', () => {
  const a = makeFoldItem({ id: 'a', kind: 'longline', text: 'x'.repeat(500), width: 40 });
  const b = makeFoldItem({ id: 'b', kind: 'longline', text: 'y'.repeat(500), width: 40 });
  assert.equal(lineHeightSignature(a), lineHeightSignature(b));
});

test('currentRows: collapsed 1, expanded = body rows', () => {
  const item = makeFoldItem({ id: 't', kind: 'tool', text: 'a\nb\nc\nd', width: 40 });
  assert.equal(currentRows(item), 1);
  toggle(item);
  assert.equal(currentRows(item), item.expandedRows);
});

// ── foldLongLines: four hard constraints ────────────────────────────────────
test('foldLongLines: short text is the zero-allocation fast path', () => {
  const r = foldLongLines('a\nb\nc', { limit: 100, width: 40 });
  assert.equal(r.byIdentity, true);
  assert.equal(r.folded, 0);
  assert.deepEqual(r.lines, ['a', 'b', 'c']);
});

test('foldLongLines: over-long line gets an inline hint, not a silent cut', () => {
  const r = foldLongLines('x'.repeat(2000), { limit: 100, width: 40 });
  assert.equal(r.folded, 1);
  assert.equal(r.lines.length, 1);
  assert.ok(r.lines[0].includes('已折叠'), '尾部有折叠提示');
  assert.ok(r.lines[0].includes('点击或 Ctrl+O 展开'));
});

test('foldLongLines: surrogate pairs are never split', () => {
  const r = foldLongLines('a'.repeat(120) + '❤️'.repeat(40), { limit: 100, width: 40 });
  // No orphaned high surrogate anywhere in the visible head.
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r.lines[0].split('…')[0]));
});

test('foldLongLines: line boundaries (\\n) are preserved', () => {
  const r = foldLongLines('short\n' + 'y'.repeat(500) + '\ntail', { limit: 100, width: 40 });
  assert.equal(r.lines.length, 3, '3 逻辑行 → 3 行');
  assert.equal(r.lines[0], 'short');
  assert.equal(r.lines[2], 'tail');
  assert.equal(r.folded, 1, '只有中间行被折叠');
});
