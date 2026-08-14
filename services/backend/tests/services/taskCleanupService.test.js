'use strict';

/**
 * taskCleanupService.test.js — 薄壳:启动任务清理执行(注入 fake _taskStore)。
 *
 * 锁定 cleanupStaleTasks:
 *   ① 老任务被 remove、新任务留存、removed/ids 正确;
 *   ② removed>0 时 log 被调用一次;
 *   ③ 门控关 → {ran:false} 不读不删;
 *   ④ store.list 抛 → fail-soft {ran:true, removed:0};
 *   ⑤ 单条 remove 抛 → 吞掉、如实少删;
 *   ⑥ now 缺省用 Date.now()(此处显式注入固定 now 保确定性)。
 */

const test = require('node:test');
const assert = require('node:assert');

const service = require('../../src/services/taskCleanupService');

const DAY = 86400000;
const NOW = 1_700_000_000_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function fakeStore(tasks) {
  const removed = [];
  return {
    removed,
    list: () => tasks.slice(),
    remove: (id) => {
      const before = tasks.length;
      const kept = tasks.filter((t) => t.id !== id);
      tasks.length = 0;
      tasks.push(...kept);
      if (kept.length < before) { removed.push(id); return true; }
      return false;
    },
  };
}

test('老任务被 remove、新任务留存、removed/ids 正确', () => {
  const tasks = [
    { id: 'old1', status: 'pending', updatedAt: iso(30 * DAY) },
    { id: 'fresh', status: 'pending', updatedAt: iso(1 * DAY) },
    { id: 'old2', status: 'completed', updatedAt: iso(10 * DAY) },
  ];
  const store = fakeStore(tasks);
  const logs = [];
  const res = service.cleanupStaleTasks({ now: NOW, env: {}, store, log: (l) => logs.push(l) });

  assert.strictEqual(res.ran, true);
  assert.strictEqual(res.removed, 2);
  assert.deepStrictEqual(res.ids.sort(), ['old1', 'old2']);
  assert.deepStrictEqual(store.removed.sort(), ['old1', 'old2']);
  assert.deepStrictEqual(tasks.map((t) => t.id), ['fresh']);
  assert.strictEqual(logs.length, 1);
  assert.ok(/2 条陈旧任务/.test(logs[0]), 'log 应含清理数量');
});

test('无陈旧任务 → removed 0、不打 log', () => {
  const tasks = [{ id: 'fresh', status: 'pending', updatedAt: iso(1 * DAY) }];
  const store = fakeStore(tasks);
  const logs = [];
  const res = service.cleanupStaleTasks({ now: NOW, env: {}, store, log: (l) => logs.push(l) });
  assert.deepStrictEqual(res, { ran: true, removed: 0, ids: [] });
  assert.strictEqual(logs.length, 0);
});

test('门控关 → {ran:false} 不读不删', () => {
  let listed = false;
  const store = { list: () => { listed = true; return []; }, remove: () => true };
  const res = service.cleanupStaleTasks({ now: NOW, env: { KHY_TASK_CLEANUP: 'off' }, store });
  assert.deepStrictEqual(res, { ran: false, removed: 0, ids: [] });
  assert.strictEqual(listed, false, '门控关不应调 list');
});

test('store.list 抛 → fail-soft', () => {
  const store = { list: () => { throw new Error('boom'); }, remove: () => true };
  const res = service.cleanupStaleTasks({ now: NOW, env: {}, store });
  assert.deepStrictEqual(res, { ran: true, removed: 0, ids: [] });
});

test('list 返回非数组 → fail-soft', () => {
  const store = { list: () => null, remove: () => true };
  const res = service.cleanupStaleTasks({ now: NOW, env: {}, store });
  assert.deepStrictEqual(res, { ran: true, removed: 0, ids: [] });
});

test('单条 remove 抛 → 吞掉、如实少删', () => {
  const tasks = [
    { id: 'boom', status: 'pending', updatedAt: iso(30 * DAY) },
    { id: 'ok', status: 'pending', updatedAt: iso(30 * DAY) },
  ];
  const store = {
    list: () => tasks.slice(),
    remove: (id) => {
      if (id === 'boom') throw new Error('remove failed');
      return true;
    },
  };
  const res = service.cleanupStaleTasks({ now: NOW, env: {}, store });
  assert.strictEqual(res.ran, true);
  assert.deepStrictEqual(res.ids, ['ok']);
  assert.strictEqual(res.removed, 1);
});

test('KHY_TASK_CLEANUP_DAYS 覆盖透传到叶子', () => {
  const tasks = [{ id: 'x', status: 'pending', updatedAt: iso(2 * DAY) }];
  const store = fakeStore(tasks);
  const res = service.cleanupStaleTasks({ now: NOW, env: { KHY_TASK_CLEANUP_DAYS: '1' }, store });
  assert.deepStrictEqual(res.ids, ['x']);
});

test('_noticeLine 含数量与天数', () => {
  const line = service._noticeLine(3, 7);
  assert.ok(line.includes('3'));
  assert.ok(line.includes('7'));
});
