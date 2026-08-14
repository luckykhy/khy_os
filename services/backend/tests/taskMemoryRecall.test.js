'use strict';

/**
 * taskMemoryRecall.test.js — 回归守卫:任务记忆(Task Memory)的**主动召回**。
 *
 * 背景(goal 2026-07-03「永久/仓库/会话/任务记忆…没把握主动写入与主动调用的时机,
 * 感觉特别健忘」):任务是四类记忆里用户点名却**唯一没有召回机制**的一类——写侧完整
 * (TaskCreate/TaskUpdate 落进 largeTaskRuntimeStore·跨会话持久),但模型只有显式调
 * TaskList 才看得到,否则每轮都「忘」了还有哪些未完成任务。本刀补上读侧:
 *   - tools/taskMemorySection.getTaskMemorySection(env) 把当前未完成任务板产成系统提示段;
 *   - prompts.js dynamicSections 里以 uncached 段每轮注入(门控 KHY_TASK_MEMORY_RECALL 默认开)。
 *
 * 关键契约:①无未完成任务(空板 / 全部已完成)→ null 字节回退;②有未完成任务 → 注入
 * (in_progress 用 activeForm、pending 用 subject);③门控关(6 falsy)→ null;④绝不抛。
 *
 * 隔离:任务存储是落盘单例,测试**不碰真实存储**——用 require.cache 注入一个假的
 * `./_taskStore`,只暴露 list(),返回受控任务数组。taskBlockedBySuffix 是真纯叶子,放行。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const LEAF = path.join(__dirname, '..', 'src', 'tools', 'taskMemorySection.js');
const STORE = require.resolve('../src/tools/_taskStore');

// 用受控的 list() 装一个假 _taskStore 进 require.cache,require 叶子,跑完清理。
function withFakeStore(tasks, fn) {
  const savedLeaf = require.cache[require.resolve(LEAF)];
  const savedStore = require.cache[STORE];
  delete require.cache[require.resolve(LEAF)];
  const listImpl = typeof tasks === 'function' ? tasks : () => tasks;
  require.cache[STORE] = {
    id: STORE, filename: STORE, loaded: true, exports: { list: listImpl },
  };
  try {
    const leaf = require(LEAF);
    return fn(leaf);
  } finally {
    delete require.cache[require.resolve(LEAF)];
    if (savedLeaf) require.cache[require.resolve(LEAF)] = savedLeaf;
    if (savedStore) require.cache[STORE] = savedStore; else delete require.cache[STORE];
  }
}

const OPEN_TASKS = [
  { id: 'a1', subject: 'Refactor gateway', status: 'in_progress', activeForm: 'Refactoring gateway', createdAt: '2026-07-03T01:00:00Z' },
  { id: 'a2', subject: 'Add tests', status: 'pending', description: 'cover the new recall path', createdAt: '2026-07-03T02:00:00Z' },
  { id: 'a3', subject: 'Ship it', status: 'completed', createdAt: '2026-07-03T00:00:00Z' },
];

test('getTaskMemorySection: 有未完成任务 → 注入段(header + in_progress activeForm + pending subject)', () => {
  withFakeStore(OPEN_TASKS, (leaf) => {
    const out = leaf.getTaskMemorySection({});
    assert.ok(out, 'should return a section');
    assert.match(out, /任务记忆 \(Task Memory\)/);
    assert.match(out, /→ #a1 Refactoring gateway/); // in_progress → activeForm
    assert.match(out, /○ #a2 Add tests — cover the new recall path/); // pending → subject+desc
    assert.ok(!/#a3/.test(out), 'completed task must not appear in the open list');
    assert.match(out, /\(1 task\(s\) already completed\.\)/); // completed counted in footer
  });
});

test('getTaskMemorySection: 空板 → null(字节回退)', () => {
  withFakeStore([], (leaf) => {
    assert.strictEqual(leaf.getTaskMemorySection({}), null);
  });
});

test('getTaskMemorySection: 全部已完成 → null(无未完成任务不花上下文)', () => {
  const allDone = [
    { id: 'd1', subject: 'x', status: 'completed' },
    { id: 'd2', subject: 'y', status: 'completed' },
  ];
  withFakeStore(allDone, (leaf) => {
    assert.strictEqual(leaf.getTaskMemorySection({}), null);
  });
});

test('getTaskMemorySection: 门控 KHY_TASK_MEMORY_RECALL 关(6 falsy)→ null', () => {
  withFakeStore(OPEN_TASKS, (leaf) => {
    for (const v of ['0', 'false', 'off', 'no', 'disable', 'disabled']) {
      assert.strictEqual(leaf.getTaskMemorySection({ KHY_TASK_MEMORY_RECALL: v }), null, v);
      assert.strictEqual(leaf.isTaskRecallEnabled({ KHY_TASK_MEMORY_RECALL: v }), false, v);
    }
  });
});

test('getTaskMemorySection: 默认(无 env)召回开启', () => {
  withFakeStore(OPEN_TASKS, (leaf) => {
    assert.strictEqual(leaf.isTaskRecallEnabled({}), true);
    assert.ok(leaf.getTaskMemorySection({}), 'default on injects the board');
  });
});

test('getTaskMemorySection: in_progress 优先于 pending;各自 createdAt 最旧优先', () => {
  const mixed = [
    { id: 'p_new', subject: 'newer pending', status: 'pending', createdAt: '2026-07-03T09:00:00Z' },
    { id: 'r1', subject: 'running one', status: 'in_progress', createdAt: '2026-07-03T05:00:00Z' },
    { id: 'p_old', subject: 'older pending', status: 'pending', createdAt: '2026-07-03T03:00:00Z' },
  ];
  withFakeStore(mixed, (leaf) => {
    const out = leaf.getTaskMemorySection({});
    const iRunning = out.indexOf('#r1');
    const iOldPending = out.indexOf('#p_old');
    const iNewPending = out.indexOf('#p_new');
    assert.ok(iRunning >= 0 && iOldPending >= 0 && iNewPending >= 0);
    assert.ok(iRunning < iOldPending, 'in_progress before pending');
    assert.ok(iOldPending < iNewPending, 'older pending before newer pending');
  });
});

test('getTaskMemorySection: 超过 MAX_OPEN_LISTED 截断并汇总剩余', () => {
  withFakeStore(null, () => {}); // no-op to read MAX from a fresh require below
  const leaf0 = withFakeStore([], (leaf) => leaf); // grab exports
  const cap = leaf0.MAX_OPEN_LISTED;
  const many = [];
  for (let i = 0; i < cap + 5; i++) {
    many.push({ id: `m${i}`, subject: `task ${i}`, status: 'pending', createdAt: `2026-07-03T00:00:${String(i).padStart(2, '0')}Z` });
  }
  withFakeStore(many, (leaf) => {
    const out = leaf.getTaskMemorySection({});
    assert.match(out, /… \+5 more open task\(s\)/);
    // 只列出 cap 条(不含汇总行)。
    const listed = (out.match(/^[→○] #m\d+/gm) || []).length;
    assert.strictEqual(listed, cap);
  });
});

test('getTaskMemorySection: 绝不抛(list 抛异常 / 返回非数组 → null)', () => {
  withFakeStore(() => { throw new Error('store down'); }, (leaf) => {
    assert.doesNotThrow(() => leaf.getTaskMemorySection({}));
    assert.strictEqual(leaf.getTaskMemorySection({}), null);
  });
  withFakeStore(() => 'not-an-array', (leaf) => {
    assert.strictEqual(leaf.getTaskMemorySection({}), null);
  });
  withFakeStore([{ id: null }, null, undefined], (leaf) => {
    assert.doesNotThrow(() => leaf.getTaskMemorySection({}));
    // 无有效未完成任务 → null。
    assert.strictEqual(leaf.getTaskMemorySection({}), null);
  });
});
