'use strict';

/**
 * taskCleanupPolicy.test.js — 纯叶子:启动任务清理判定(确定性)。
 *
 * 锁定 selectStaleTaskIds:
 *   ① 7 天前更新的 pending/in_progress → 入清理集;
 *   ② 今天的 pending → 不清;
 *   ③ completed/error 超期 → 清;
 *   ④ 时间戳缺失/不可解析 → 保守不清;
 *   ⑤ 门控关(KHY_TASK_CLEANUP=off) → 空集;
 *   ⑥ KHY_TASK_CLEANUP_DAYS 覆盖生效;
 *   ⑦ 坏输入(tasks 非数组 / now 非数) → 空集不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const policy = require('../../src/services/taskCleanupPolicy');

const DAY = 86400000;
const NOW = 1_700_000_000_000; // 固定 now(叶子零时钟,壳注入)

function iso(msAgo) {
  return new Date(NOW - msAgo).toISOString();
}

test('7 天前更新的 pending/in_progress → 入清理集', () => {
  const tasks = [
    { id: 'a', status: 'pending', updatedAt: iso(8 * DAY) },
    { id: 'b', status: 'in_progress', updatedAt: iso(30 * DAY) },
  ];
  const ids = policy.selectStaleTaskIds({ tasks, now: NOW, env: {} });
  assert.deepStrictEqual(ids.sort(), ['a', 'b']);
});

test('今天的 pending → 不清', () => {
  const tasks = [{ id: 'fresh', status: 'pending', updatedAt: iso(1 * DAY) }];
  const ids = policy.selectStaleTaskIds({ tasks, now: NOW, env: {} });
  assert.deepStrictEqual(ids, []);
});

test('completed/error 超期 → 清', () => {
  const tasks = [
    { id: 'c', status: 'completed', updatedAt: iso(10 * DAY) },
    { id: 'e', status: 'error', updatedAt: iso(10 * DAY) },
  ];
  const ids = policy.selectStaleTaskIds({ tasks, now: NOW, env: {} });
  assert.deepStrictEqual(ids.sort(), ['c', 'e']);
});

test('时间戳缺失/不可解析 → 保守不清', () => {
  const tasks = [
    { id: 'no-stamp', status: 'pending' },
    { id: 'bad-stamp', status: 'pending', updatedAt: 'not-a-date' },
    { id: 'null-stamp', status: 'pending', updatedAt: null, createdAt: null },
  ];
  const ids = policy.selectStaleTaskIds({ tasks, now: NOW, env: {} });
  assert.deepStrictEqual(ids, []);
});

test('回退 createdAt(updatedAt 缺失时)', () => {
  const tasks = [{ id: 'byCreated', status: 'pending', createdAt: iso(9 * DAY) }];
  const ids = policy.selectStaleTaskIds({ tasks, now: NOW, env: {} });
  assert.deepStrictEqual(ids, ['byCreated']);
});

test('门控关(KHY_TASK_CLEANUP=off) → 空集', () => {
  const tasks = [{ id: 'a', status: 'pending', updatedAt: iso(30 * DAY) }];
  for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
    const ids = policy.selectStaleTaskIds({ tasks, now: NOW, env: { KHY_TASK_CLEANUP: off } });
    assert.deepStrictEqual(ids, [], `gate=${off} 应回空`);
  }
});

test('KHY_TASK_CLEANUP_DAYS 覆盖:=1 时 2 天前的任务也清', () => {
  const tasks = [{ id: 'x', status: 'pending', updatedAt: iso(2 * DAY) }];
  // 默认 7 天不清
  assert.deepStrictEqual(policy.selectStaleTaskIds({ tasks, now: NOW, env: {} }), []);
  // 覆盖为 1 天则清
  assert.deepStrictEqual(
    policy.selectStaleTaskIds({ tasks, now: NOW, env: { KHY_TASK_CLEANUP_DAYS: '1' } }),
    ['x'],
  );
});

test('resolveRetentionDays:非法值回退默认 7', () => {
  assert.strictEqual(policy.resolveRetentionDays({ KHY_TASK_CLEANUP_DAYS: '0' }), 7);
  assert.strictEqual(policy.resolveRetentionDays({ KHY_TASK_CLEANUP_DAYS: '-3' }), 7);
  assert.strictEqual(policy.resolveRetentionDays({ KHY_TASK_CLEANUP_DAYS: 'abc' }), 7);
  assert.strictEqual(policy.resolveRetentionDays({ KHY_TASK_CLEANUP_DAYS: '2.5' }), 7);
  assert.strictEqual(policy.resolveRetentionDays({}), 7);
  assert.strictEqual(policy.resolveRetentionDays({ KHY_TASK_CLEANUP_DAYS: '30' }), 30);
});

test('坏输入(tasks 非数组 / now 非数)→ 空集不抛', () => {
  assert.deepStrictEqual(policy.selectStaleTaskIds({ tasks: null, now: NOW, env: {} }), []);
  assert.deepStrictEqual(policy.selectStaleTaskIds({ tasks: 'x', now: NOW, env: {} }), []);
  assert.deepStrictEqual(policy.selectStaleTaskIds({ tasks: [{ id: 'a', status: 'pending', updatedAt: iso(30 * DAY) }], now: NaN, env: {} }), []);
  assert.deepStrictEqual(policy.selectStaleTaskIds({}), []);
});

test('无 id / 空 id 的条目被跳过', () => {
  const tasks = [
    { status: 'pending', updatedAt: iso(30 * DAY) },
    { id: '', status: 'pending', updatedAt: iso(30 * DAY) },
    { id: 'ok', status: 'pending', updatedAt: iso(30 * DAY) },
  ];
  const ids = policy.selectStaleTaskIds({ tasks, now: NOW, env: {} });
  assert.deepStrictEqual(ids, ['ok']);
});

test('isEnabled 默认开', () => {
  assert.strictEqual(policy.isEnabled({}), true);
  assert.strictEqual(policy.isEnabled({ KHY_TASK_CLEANUP: 'off' }), false);
});
