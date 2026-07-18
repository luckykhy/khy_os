'use strict';

/**
 * historyReverseSearch.test.js — Ctrl+R 反向历史搜索纯叶子。
 *
 * 锁死:
 *   - 门控 default-on / 0·false·off·no 关;
 *   - search 大小写不敏感子串、结果新→旧序、from clamp、空 query/空 history/无匹配;
 *   - nextMatch 前进到更旧一条、到底停住不回绕;
 *   - 绝不抛(非数组 / null / 含非字符串项)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { isEnabled, search, nextMatch } = require('../../src/services/keybindings/historyReverseSearch');

const HIST = ['git status', 'npm test', 'git commit -m x', 'node --test foo', 'git push']; // 旧→新

test('gate default-on / off', () => {
  assert.strictEqual(isEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(isEnabled({ KHY_HISTORY_REVERSE_SEARCH: v }), false, v);
  }
});

test('empty query → no match, awaits input', () => {
  const r = search(HIST, '');
  assert.deepStrictEqual(r.matches, []);
  assert.strictEqual(r.index, -1);
  assert.strictEqual(r.current, '');
});

test('substring match ordered newest→oldest, selects newest first', () => {
  const r = search(HIST, 'git');
  // 命中 index 0,2,4;新→旧 = [4,2,0]。
  assert.deepStrictEqual(r.matches, [4, 2, 0]);
  assert.strictEqual(r.index, 0);
  assert.strictEqual(r.current, 'git push'); // 最新命中
});

test('case-insensitive', () => {
  assert.strictEqual(search(HIST, 'GIT').current, 'git push');
  assert.strictEqual(search(HIST, 'Test').matches.length, 2); // npm test + node --test foo
});

test('from clamps into range', () => {
  assert.strictEqual(search(HIST, 'git', { from: 1 }).current, 'git commit -m x');
  assert.strictEqual(search(HIST, 'git', { from: 99 }).current, 'git status'); // clamp 到最旧
  assert.strictEqual(search(HIST, 'git', { from: -5 }).index, 0);
});

test('no match → empty', () => {
  const r = search(HIST, 'zzz');
  assert.deepStrictEqual(r.matches, []);
  assert.strictEqual(r.current, '');
});

test('nextMatch advances to older, stops at oldest (no wrap)', () => {
  let s = search(HIST, 'git');            // index 0 → git push
  s = nextMatch(HIST, s);                 // index 1 → git commit -m x
  assert.strictEqual(s.index, 1);
  assert.strictEqual(s.current, 'git commit -m x');
  s = nextMatch(HIST, s);                 // index 2 → git status
  assert.strictEqual(s.current, 'git status');
  s = nextMatch(HIST, s);                 // 到底停住
  assert.strictEqual(s.index, 2);
  assert.strictEqual(s.current, 'git status');
});

test('never throws on junk input', () => {
  assert.doesNotThrow(() => search(null, 'x'));
  assert.doesNotThrow(() => search(HIST, null));
  assert.doesNotThrow(() => search([1, 2, undefined, 'git x'], 'git'));
  assert.doesNotThrow(() => nextMatch(null, {}));
  assert.doesNotThrow(() => nextMatch(HIST, { matches: null }));
  assert.strictEqual(search([1, 2, 'git x'], 'git').current, 'git x'); // 跳过非字符串项
});
