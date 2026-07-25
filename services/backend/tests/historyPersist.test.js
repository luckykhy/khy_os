'use strict';

/**
 * historyPersist.test.js —— 纯叶子 cli/tui/hooks/historyPersist 的确定性判定。
 * 覆盖 isPersistEnabled 门控(默认开/0/false/off/no/大小写)+ mergeHistory
 * 合并顺序、去空白、截顶、fail-soft。零 IO,node:test。
 */

const test = require('node:test');
const assert = require('node:assert');

const { isPersistEnabled, mergeHistory } = require('../src/cli/tui/hooks/historyPersist');

// ── isPersistEnabled ──────────────────────────────────────────────────────────

test('isPersistEnabled: 默认(undefined/null)开', () => {
  assert.equal(isPersistEnabled(undefined), true);
  assert.equal(isPersistEnabled(null), true);
});

test('isPersistEnabled: 仅 0/false/off/no(大小写无关)关', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'False']) {
    assert.equal(isPersistEnabled(v), false, `期望 ${JSON.stringify(v)} 关`);
  }
});

test('isPersistEnabled: 其它任意值开', () => {
  for (const v of ['1', 'on', 'yes', 'true', '']) {
    assert.equal(isPersistEnabled(v), true, `期望 ${JSON.stringify(v)} 开`);
  }
});

// ── mergeHistory ────────────────────────────────────────────────────────────

test('mergeHistory: 持久在前会话在后,保旧→新顺序', () => {
  assert.deepEqual(
    mergeHistory(['a', 'b'], ['c', 'd']),
    ['a', 'b', 'c', 'd'],
  );
});

test('mergeHistory: 去空白/非字符串项', () => {
  assert.deepEqual(
    mergeHistory(['a', '', '  ', null, 'b'], ['', 'c', 42]),
    ['a', 'b', 'c'],
  );
});

test('mergeHistory: 截到最近 max 条(保留尾部 = 最近)', () => {
  assert.deepEqual(
    mergeHistory(['a', 'b', 'c'], ['d', 'e'], 3),
    ['c', 'd', 'e'],
  );
});

test('mergeHistory: max 省略/非法 → 不截断', () => {
  assert.deepEqual(mergeHistory(['a'], ['b']), ['a', 'b']);
  assert.deepEqual(mergeHistory(['a'], ['b'], 0), ['a', 'b']);
  assert.deepEqual(mergeHistory(['a'], ['b'], -1), ['a', 'b']);
  assert.deepEqual(mergeHistory(['a'], ['b'], NaN), ['a', 'b']);
});

test('mergeHistory: 非数组入参 → fail-soft', () => {
  assert.deepEqual(mergeHistory(null, undefined), []);
  assert.deepEqual(mergeHistory('nope', ['b']), ['b']);
});
