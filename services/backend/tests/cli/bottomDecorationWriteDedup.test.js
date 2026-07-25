'use strict';

/**
 * bottomDecorationWriteDedup 单测。
 *
 * 覆盖:
 *  - isEnabled:default-on + CANON off-words。
 *  - shouldWrite:首次写返 true · 相同串第二次返 false(去重) · 串变化返 true · 门控关恒 true ·
 *    非字符串保守写 true · invalidate 后同串重返 true。
 *  - invalidate:清槽,强制下次必写。
 *  - LIVE wiring:repl.js 经 bottomDecorationWriteDedup.shouldWrite 门控 stdout.write + 各 frame
 *    转换处 invalidate。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dedup = require('../../src/cli/repl/bottomDecorationWriteDedup');

test('isEnabled: default-on, CANON off-words', () => {
  assert.equal(dedup.isEnabled({}), true);
  assert.equal(dedup.isEnabled({ KHY_BOTTOM_DECORATION_WRITE_DEDUP: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(dedup.isEnabled({ KHY_BOTTOM_DECORATION_WRITE_DEDUP: off }), false, `off=${off}`);
  }
  assert.deepEqual(dedup.OFF_VALUES, ['0', 'false', 'off', 'no']);
});

test('shouldWrite: first write true, identical repeat false', () => {
  dedup.invalidate();
  const s = '\x1b[1B\x1b[2K\x1b[1Grule\x1b[3A\x1b[6G';
  assert.equal(dedup.shouldWrite(s, {}), true, 'first write');
  assert.equal(dedup.shouldWrite(s, {}), false, 'identical repeat deduped');
  assert.equal(dedup.shouldWrite(s, {}), false, 'still deduped');
});

test('shouldWrite: changed string writes again', () => {
  dedup.invalidate();
  assert.equal(dedup.shouldWrite('A', {}), true);
  assert.equal(dedup.shouldWrite('A', {}), false);
  assert.equal(dedup.shouldWrite('B', {}), true, 'different string → write');
  assert.equal(dedup.shouldWrite('B', {}), false);
  assert.equal(dedup.shouldWrite('A', {}), true, 'back to A → write (only last remembered)');
});

test('shouldWrite: gate off → always true (byte-revert)', () => {
  dedup.invalidate();
  const off = { KHY_BOTTOM_DECORATION_WRITE_DEDUP: 'off' };
  assert.equal(dedup.shouldWrite('same', off), true);
  assert.equal(dedup.shouldWrite('same', off), true, 'no dedup when gated off');
  assert.equal(dedup.shouldWrite('same', off), true);
});

test('shouldWrite: non-string → conservative write true', () => {
  dedup.invalidate();
  assert.equal(dedup.shouldWrite(null, {}), true);
  assert.equal(dedup.shouldWrite(undefined, {}), true);
  assert.equal(dedup.shouldWrite(42, {}), true);
});

test('invalidate: forces next write of same string', () => {
  dedup.invalidate();
  const s = 'decoration';
  assert.equal(dedup.shouldWrite(s, {}), true);
  assert.equal(dedup.shouldWrite(s, {}), false, 'deduped');
  dedup.invalidate();
  assert.equal(dedup.shouldWrite(s, {}), true, 'after invalidate same string writes again');
  assert.equal(dedup._peek(), s);
});

test('invalidate: clears slot to null', () => {
  dedup.shouldWrite('x', {});
  dedup.invalidate();
  assert.equal(dedup._peek(), null);
});

test('gate off does not populate slot (so ON afterwards still fresh)', () => {
  dedup.invalidate();
  dedup.shouldWrite('y', { KHY_BOTTOM_DECORATION_WRITE_DEDUP: 'off' });
  assert.equal(dedup._peek(), null, 'off path never records');
  // now ON: first write true
  assert.equal(dedup.shouldWrite('y', {}), true);
});

test('LIVE wiring: repl.js gates stdout.write via shouldWrite + invalidates on frame transitions', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/cli/repl.js'), 'utf8');
  assert.ok(/require\(['"]\.\/repl\/bottomDecorationWriteDedup['"]\)/.test(src), 'requires the dedup leaf');
  assert.ok(/_bdwDedup\.shouldWrite\(_repaint,\s*process\.env\)/.test(src), 'gates the repaint write via shouldWrite');
  // write happens inside the shouldWrite branch
  assert.ok(/shouldWrite\(_repaint[\s\S]{0,120}process\.stdout\.write\(_repaint\)/.test(src), 'stdout.write is guarded by shouldWrite');
  // at least one invalidate on frame render, at least one on resize teardown
  const invalidates = (src.match(/_bdwDedup\.invalidate\(\)/g) || []).length;
  assert.ok(invalidates >= 2, `invalidate wired at frame transitions (found ${invalidates})`);
});
