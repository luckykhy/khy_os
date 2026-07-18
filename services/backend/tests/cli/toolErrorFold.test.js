'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  planErrorFold,
  toolErrorFoldEnabled,
  ERR_RENDERED_LINES,
  LEGACY_ERR_LINES,
} = require('../../src/cli/toolErrorFold');

const ON = {}; // gate unset → default on
const OFF = { KHY_TOOL_ERROR_FOLD: '0' };

function lines(n) {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`);
}

test('gate ladder: unset/true/1 → on; 0/false/off/no → off', () => {
  assert.equal(toolErrorFoldEnabled({}), true);
  assert.equal(toolErrorFoldEnabled({ KHY_TOOL_ERROR_FOLD: 'true' }), true);
  assert.equal(toolErrorFoldEnabled({ KHY_TOOL_ERROR_FOLD: '1' }), true);
  assert.equal(toolErrorFoldEnabled({ KHY_TOOL_ERROR_FOLD: '0' }), false);
  assert.equal(toolErrorFoldEnabled({ KHY_TOOL_ERROR_FOLD: 'false' }), false);
  assert.equal(toolErrorFoldEnabled({ KHY_TOOL_ERROR_FOLD: 'off' }), false);
  assert.equal(toolErrorFoldEnabled({ KHY_TOOL_ERROR_FOLD: 'NO' }), false);
});

test('CC head cap = 10', () => {
  assert.equal(ERR_RENDERED_LINES, 10);
});

test('gate on, collapsed, <=10 lines → all shown, nothing hidden', () => {
  const r = planErrorFold(lines(7), false, ON);
  assert.deepEqual(r.shown, lines(7));
  assert.equal(r.hidden, 0);
});

test('gate on, collapsed, exactly 10 lines → all shown, nothing hidden', () => {
  const r = planErrorFold(lines(10), false, ON);
  assert.equal(r.shown.length, 10);
  assert.equal(r.hidden, 0);
});

test('gate on, collapsed, 13 lines → head 10 shown, 3 hidden (honest count)', () => {
  const r = planErrorFold(lines(13), false, ON);
  assert.equal(r.shown.length, 10);
  assert.deepEqual(r.shown, lines(10));
  assert.equal(r.hidden, 3);
});

test('gate on, expanded (Ctrl+O) → ALL lines shown, nothing hidden', () => {
  const r = planErrorFold(lines(40), true, ON);
  assert.equal(r.shown.length, 40);
  assert.equal(r.hidden, 0);
});

test('gate OFF → byte-identical legacy silent 3-line cap, ignores expanded', () => {
  // collapsed
  const c = planErrorFold(lines(13), false, OFF);
  assert.deepEqual(c.shown, lines(3));
  assert.equal(c.hidden, 0);
  // expanded must NOT reveal more when gate off (legacy ignored expanded)
  const e = planErrorFold(lines(13), true, OFF);
  assert.deepEqual(e.shown, lines(3));
  assert.equal(e.hidden, 0);
  assert.equal(LEGACY_ERR_LINES, 3);
});

test('gate off short error (<=3) → unchanged, no marker', () => {
  const r = planErrorFold(lines(2), false, OFF);
  assert.deepEqual(r.shown, lines(2));
  assert.equal(r.hidden, 0);
});

test('defensive: non-array input → empty, never throws', () => {
  assert.deepEqual(planErrorFold(null, false, ON), { shown: [], hidden: 0 });
  assert.deepEqual(planErrorFold(undefined, true, OFF), { shown: [], hidden: 0 });
});

test('the gate-on vs gate-off divergence appears ONLY past the legacy cap', () => {
  // 3 lines: both gates render the same first 3, no marker either way.
  const on = planErrorFold(lines(3), false, ON);
  const off = planErrorFold(lines(3), false, OFF);
  assert.deepEqual(on.shown, off.shown);
  assert.equal(on.hidden, 0);
  assert.equal(off.hidden, 0);
});
