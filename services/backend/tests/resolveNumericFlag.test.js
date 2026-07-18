'use strict';

/**
 * resolveNumericFlag.test.js — 锁 utils/resolveNumericFlag 口径
 *   (收敛 2 处 catalog `_resolveNumeric(name, env, fallback, lo, hi)` 的护栏)。
 *
 * 用未注册的 flag 名,使 flagRegistry.resolveNumeric 落空 → 走 env 直读 + clamp/fallback 分支,
 *   从而确定性验证收敛体行为(不依赖具体已注册门的值)。
 */

const test = require('node:test');
const assert = require('node:assert');

const resolveNumericFlag = require('../src/utils/resolveNumericFlag');

const UNREG = 'KHY_TEST_UNREGISTERED_NUMERIC_XYZ';

test('env 缺失 → fallback', () => {
  assert.strictEqual(resolveNumericFlag(UNREG, {}, 42, 1, 100), 42);
});

test('env 有效正整数 → clamp 到 [lo, hi]', () => {
  assert.strictEqual(resolveNumericFlag(UNREG, { [UNREG]: '50' }, 42, 1, 100), 50);
  assert.strictEqual(resolveNumericFlag(UNREG, { [UNREG]: '9999' }, 42, 1, 100), 100); // clamp hi
  assert.strictEqual(resolveNumericFlag(UNREG, { [UNREG]: '0' }, 42, 1, 100), 42); // 0 非正 → fallback
});

test('env 非数字 → fallback', () => {
  assert.strictEqual(resolveNumericFlag(UNREG, { [UNREG]: 'abc' }, 7, 1, 100), 7);
});

test('lo 下限 clamp', () => {
  assert.strictEqual(resolveNumericFlag(UNREG, { [UNREG]: '3' }, 42, 10, 100), 10);
});

test('逐输入等价原体(未注册门·仅 env 分支)', () => {
  const ref = (name, env, fallback, lo, hi) => {
    const e = env || {};
    const raw = Number.parseInt((e && e[name]) || '', 10);
    if (Number.isFinite(raw) && raw > 0) return Math.min(hi, Math.max(lo, raw));
    return fallback;
  };
  for (const v of [undefined, '', '0', '5', '500', 'x', '  20  ']) {
    const env = v === undefined ? {} : { [UNREG]: v };
    assert.strictEqual(
      resolveNumericFlag(UNREG, env, 42, 1, 100),
      ref(UNREG, env, 42, 1, 100)
    );
  }
});
