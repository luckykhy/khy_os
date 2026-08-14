'use strict';

/**
 * interruptHint — pins the pure-leaf decision for the streaming "esc 中断"
 * discoverability hint (aligns with CC's isLoading "esc to interrupt" footer).
 *
 * The key LOGIC being pinned: the hint only shows while busy AND with an empty
 * queue — when a queue exists, the queue panel already shows the accurate two-step
 * hint, so a blanket "esc 中断" (whose first press would actually drain the queue,
 * not interrupt) must NOT be shown. Gate KHY_ESC_INTERRUPT_HINT default on.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ih = require('../src/cli/tui/interruptHint');

test('isInterruptHintEnabled: default on, {0,false,off,no} off', () => {
  assert.strictEqual(ih.isInterruptHintEnabled({}), true);
  assert.strictEqual(ih.isInterruptHintEnabled({ KHY_ESC_INTERRUPT_HINT: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(ih.isInterruptHintEnabled({ KHY_ESC_INTERRUPT_HINT: v }), false, `expected off for ${v}`);
  }
});

test('busy + empty queue → shows the interrupt hint', () => {
  const hint = ih.buildInterruptHint({ busy: true, queueLen: 0 }, {});
  assert.strictEqual(hint, ih.INTERRUPT_HINT_TEXT);
  assert.strictEqual(hint, 'esc 中断');
});

test('not busy → no hint', () => {
  assert.strictEqual(ih.buildInterruptHint({ busy: false, queueLen: 0 }, {}), '');
});

test('busy + queue present → no hint (queue panel owns the two-step affordance)', () => {
  assert.strictEqual(ih.buildInterruptHint({ busy: true, queueLen: 1 }, {}), '');
  assert.strictEqual(ih.buildInterruptHint({ busy: true, queueLen: 5 }, {}), '');
});

test('busy but compacting → no hint (compaction has its own UI)', () => {
  assert.strictEqual(ih.buildInterruptHint({ busy: true, queueLen: 0, compacting: true }, {}), '');
});

test('busy but awaiting a choice overlay → no hint (focus is on the overlay)', () => {
  assert.strictEqual(ih.buildInterruptHint({ busy: true, queueLen: 0, awaitingChoice: true }, {}), '');
});

test('gate off → no hint even when busy + empty queue', () => {
  assert.strictEqual(ih.buildInterruptHint({ busy: true, queueLen: 0 }, { KHY_ESC_INTERRUPT_HINT: 'off' }), '');
});

test('fail-soft: bad input never throws, returns empty string', () => {
  assert.doesNotThrow(() => ih.buildInterruptHint());
  assert.strictEqual(ih.buildInterruptHint(undefined, {}), '');
  assert.strictEqual(ih.buildInterruptHint({ busy: true, queueLen: NaN }, {}), 'esc 中断');
});

// ── Post-interrupt "what to do instead" guidance (aligns with CC's
//    `Interrupted · What should Claude do instead?`). Gate default on;
//    off / any error → byte-for-byte fallback to today's bare `已中断`. ──

test('isInsteadHintEnabled: default on, {0,false,off,no} off', () => {
  assert.strictEqual(ih.isInsteadHintEnabled({}), true);
  assert.strictEqual(ih.isInsteadHintEnabled({ KHY_ESC_INTERRUPT_INSTEAD_HINT: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(ih.isInsteadHintEnabled({ KHY_ESC_INTERRUPT_INSTEAD_HINT: v }), false, `expected off for ${v}`);
  }
});

test('buildPostInterruptHint: default on → guidance text', () => {
  const t = ih.buildPostInterruptHint({});
  assert.strictEqual(t, ih.POST_INTERRUPT_HINT_TEXT);
  assert.strictEqual(t, '已中断 · 想让 khy 做什么替代?');
});

test('buildPostInterruptHint: gate off → byte-identical fallback 已中断', () => {
  assert.strictEqual(ih.buildPostInterruptHint({ KHY_ESC_INTERRUPT_INSTEAD_HINT: 'off' }), '已中断');
  assert.strictEqual(ih.POST_INTERRUPT_FALLBACK, '已中断');
});

test('buildPostInterruptHint: independent from the streaming hint gate', () => {
  // Turning the streaming discoverability hint off must NOT change the post-interrupt guidance.
  assert.strictEqual(ih.buildPostInterruptHint({ KHY_ESC_INTERRUPT_HINT: 'off' }), ih.POST_INTERRUPT_HINT_TEXT);
});

test('buildPostInterruptHint: fail-soft never throws, falls back to 已中断', () => {
  assert.doesNotThrow(() => ih.buildPostInterruptHint());
  // A hostile env whose getter throws must degrade to the fallback, not crash the interrupt path.
  const hostile = {};
  Object.defineProperty(hostile, 'KHY_ESC_INTERRUPT_INSTEAD_HINT', { get() { throw new Error('boom'); } });
  assert.strictEqual(ih.buildPostInterruptHint(hostile), '已中断');
});
