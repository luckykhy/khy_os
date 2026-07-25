'use strict';

/**
 * onValueOr.test.js — 锁 utils/onValueOr 口径(收敛 3 处 gateway/* `_envOn(raw,dflt=true)` 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const onValueOr = require('../src/utils/onValueOr');

test('null/空串/纯空白 → dflt', () => {
  assert.strictEqual(onValueOr(null), true);
  assert.strictEqual(onValueOr(undefined), true);
  assert.strictEqual(onValueOr(''), true);
  assert.strictEqual(onValueOr('   '), true);
  assert.strictEqual(onValueOr(null, false), false);
  assert.strictEqual(onValueOr('  ', false), false);
});

test('off-set {0,false,off,no} → false(trim+大小写不敏感)', () => {
  for (const v of ['0', 'false', 'OFF', ' No ', 'FALSE']) {
    assert.strictEqual(onValueOr(v), false, `for '${v}'`);
    assert.strictEqual(onValueOr(v, true), false, `for '${v}' with dflt=true`);
  }
});

test('其余非空值 → true', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'maybe', 'enabled']) {
    assert.strictEqual(onValueOr(v), true, `for '${v}'`);
  }
});

test('抛异常的 toString → false(fail-safe)', () => {
  const bad = { toString() { throw new Error('boom'); } };
  assert.strictEqual(onValueOr(bad), false);
});

test('与原 inline 形式逐输入等价', () => {
  const inline = (raw, dflt = true) => {
    try {
      if (raw == null || String(raw).trim() === '') return dflt;
      const v = String(raw).trim().toLowerCase();
      return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
    } catch { return false; }
  };
  const cases = [null, undefined, '', '  ', '0', 'false', 'off', 'no', '1', 'ON', 'Yes', 'x'];
  for (const raw of cases) {
    assert.strictEqual(onValueOr(raw), inline(raw), `dflt-default for ${JSON.stringify(raw)}`);
    assert.strictEqual(onValueOr(raw, false), inline(raw, false), `dflt=false for ${JSON.stringify(raw)}`);
  }
});
