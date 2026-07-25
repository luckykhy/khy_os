'use strict';

// Unit tests for caretGeometry (pure leaf: caret display-column geometry + gates).
// Shared by Fix 1a (system IME real-cursor follow) and Fix 1b (khy completion dropdown
// horizontal alignment). Pure — synthesizes `rows` arrays, never mounts ink.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const cg = require('./caretGeometry');

// Helper: a 'line' row shaped like PromptFrame.layoutPromptRows output.
const line = (text, caretCol = null) => ({ kind: 'line', text, caretCol });

// ── caretColumn: ASCII 列(offset 头/中/尾) ────────────────────────────────
test('caretColumn: ASCII caret at start/mid/end → MARKER_W + prefix width', () => {
  assert.deepEqual(cg.caretColumn([line('hello', 0)]), { col: 2, rowIndex: 0 });
  assert.deepEqual(cg.caretColumn([line('hello', 3)]), { col: 5, rowIndex: 0 });
  assert.deepEqual(cg.caretColumn([line('hello', 5)]), { col: 7, rowIndex: 0 });
});

// ── caretColumn: CJK 注入 measure(每字宽 2) ───────────────────────────────
test('caretColumn: CJK width via injected measure', () => {
  // measure counts CJK as width 2.
  const measure = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
  // "你好world", caret after "你好" (offset 2) → prefix width 4 → col 6.
  assert.deepEqual(cg.caretColumn([line('你好world', 2)], { measure }), { col: 6, rowIndex: 0 });
  // caret after "你好wo" (offset 4) → 4 + 2 = 6 width → col 8.
  assert.deepEqual(cg.caretColumn([line('你好world', 4)], { measure }), { col: 8, rowIndex: 0 });
});

// ── caretColumn: 多段换行,caret 落第二段 ─────────────────────────────────────
test('caretColumn: picks the row whose caretCol != null (second segment)', () => {
  const rows = [line('first-seg', null), line('second', 3)];
  assert.deepEqual(cg.caretColumn(rows), { col: 5, rowIndex: 1 });
});

// ── caretColumn: 空 / 无 caret / 非行 → 防御回退 ─────────────────────────────
test('caretColumn: no caret row / empty / non-array → {MARKER_W, -1}', () => {
  assert.deepEqual(cg.caretColumn([]), { col: 2, rowIndex: -1 });
  assert.deepEqual(cg.caretColumn([line('abc', null)]), { col: 2, rowIndex: -1 });
  assert.deepEqual(cg.caretColumn(null), { col: 2, rowIndex: -1 });
  assert.deepEqual(cg.caretColumn(undefined), { col: 2, rowIndex: -1 });
  // ellipsis rows are skipped.
  assert.deepEqual(cg.caretColumn([{ kind: 'ellipsis' }, line('x', 1)]), { col: 3, rowIndex: 1 });
});

// ── caretColumn: measure 抛 → fall back to length, 永不抛 ─────────────────────
test('caretColumn: throwing measure falls back to code-unit length', () => {
  const bad = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => cg.caretColumn([line('hello', 3)], { measure: bad }));
  assert.deepEqual(cg.caretColumn([line('hello', 3)], { measure: bad }), { col: 5, rowIndex: 0 });
});

// ── clampColumn: 越界 / 负值 / 非法钳制 ──────────────────────────────────────
test('clampColumn: clamps to [0, cols - minMenuWidth]', () => {
  assert.equal(cg.clampColumn(10, 80, 24), 10);            // in range
  assert.equal(cg.clampColumn(70, 80, 24), 56);            // 80-24=56 ceiling
  assert.equal(cg.clampColumn(0, 80, 24), 0);
  assert.equal(cg.clampColumn(-5, 80, 24), 0);             // negative → 0
  assert.equal(cg.clampColumn(10, 0, 24), 0);              // bad cols → 0
  assert.equal(cg.clampColumn(NaN, 80, 24), 0);            // bad col → 0
  assert.equal(cg.clampColumn(10, 80, 0), 10);             // no min → just floor(cols)
});

// ── 门控梯:KHY_IME_CURSOR ───────────────────────────────────────────────────
test('imeCursorEnabled: default on; explicit falsy off', () => {
  assert.equal(cg.imeCursorEnabled({}), true);
  assert.equal(cg.imeCursorEnabled(undefined), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(cg.imeCursorEnabled({ KHY_IME_CURSOR: v }), false, `value ${v}`);
  }
  assert.equal(cg.imeCursorEnabled({ KHY_IME_CURSOR: 'yes' }), true);
});

// ── 门控梯:KHY_COMPLETION_FOLLOW_CURSOR ──────────────────────────────────────
test('completionFollowEnabled: default on; explicit falsy off', () => {
  assert.equal(cg.completionFollowEnabled({}), true);
  assert.equal(cg.completionFollowEnabled(undefined), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(cg.completionFollowEnabled({ KHY_COMPLETION_FOLLOW_CURSOR: v }), false, `value ${v}`);
  }
  assert.equal(cg.completionFollowEnabled({ KHY_COMPLETION_FOLLOW_CURSOR: '1' }), true);
});

// ── MARKER_W 常量 ────────────────────────────────────────────────────────────
test('MARKER_W mirrors PromptFrame (=2)', () => {
  assert.equal(cg.MARKER_W, 2);
});
