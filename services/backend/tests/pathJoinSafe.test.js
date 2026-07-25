'use strict';

/**
 * pathJoinSafe.test.js — 锁 utils/pathJoinSafe 口径(收敛 4 处 `_join` 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const pathJoinSafe = require('../src/utils/pathJoinSafe');

test('正常拼接等价 path.join', () => {
  assert.strictEqual(pathJoinSafe('a', 'b', 'c'), path.join('a', 'b', 'c'));
  assert.strictEqual(pathJoinSafe('/root', '.claude', 'skills'), path.join('/root', '.claude', 'skills'));
});

test('任一段为 undefined/null/空串 → 返回空串(不拼半截路径)', () => {
  assert.strictEqual(pathJoinSafe('/root', undefined, 'x'), '');
  assert.strictEqual(pathJoinSafe('/root', null, 'x'), '');
  assert.strictEqual(pathJoinSafe('/root', '', 'x'), '');
  assert.strictEqual(pathJoinSafe(undefined), '');
});

test('非字符串段经 String 强转', () => {
  assert.strictEqual(pathJoinSafe('a', 1, 2), path.join('a', '1', '2'));
});

test('无参数 → path.join() = "."', () => {
  assert.strictEqual(pathJoinSafe(), path.join());
});
