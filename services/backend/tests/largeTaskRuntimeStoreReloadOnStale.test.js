'use strict';

// 「不同入口唯一数据」回归:验证 largeTaskRuntimeStore 的 in-memory `state`
// 会在磁盘 SSOT 被另一进程/实例改写后重新对齐(门 KHY_TASK_STORE_RELOAD_ON_STALE
// 默认开),关闭时逐字节回退到旧行为(loaded 后永不重读)。
// 用两个独立 store 实例(同一 storePath)模拟 TUI 与 web 两个入口。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createLargeTaskRuntimeStore,
} = require('../src/tasks/largeTaskRuntimeStore');

function withStoreEnv(value, fn) {
  const key = 'KHY_TASK_STORE_RELOAD_ON_STALE';
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (!had) delete process.env[key];
    else process.env[key] = prev;
  }
}

function mkStorePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-reload-stale-'));
  return { dir, storePath: path.join(dir, 'runtime.json') };
}

function bumpMtimeForward(storePath) {
  // Force the on-disk mtime strictly forward so the staleness comparison is
  // deterministic regardless of filesystem timestamp resolution.
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(storePath, future, future);
}

test('gate-on: a loaded store re-aligns to another entry point\'s on-disk write', () => {
  const { dir, storePath } = mkStorePath();
  try {
    withStoreEnv('1', () => {
      const entryA = createLargeTaskRuntimeStore({ storePath });
      const entryB = createLargeTaskRuntimeStore({ storePath });

      // A loads first (empty), caching in-memory state + mtime.
      assert.deepStrictEqual(entryA.listTasks(), []);

      // B (a separate entry point) writes a task to the shared SSOT.
      const task = entryB.createTask({ type: 'cross-entry' });
      bumpMtimeForward(storePath);

      // A must now observe B's task without being re-instantiated.
      const seen = entryA.getTask(task.id);
      assert.ok(seen, 'entry A should re-read the shared store and see B\'s task');
      assert.strictEqual(seen.id, task.id);
      assert.strictEqual(entryA.listTasks().length, 1);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gate-off: byte-revert — a loaded store never re-reads disk', () => {
  const { dir, storePath } = mkStorePath();
  try {
    withStoreEnv('off', () => {
      const entryA = createLargeTaskRuntimeStore({ storePath });
      const entryB = createLargeTaskRuntimeStore({ storePath });

      assert.deepStrictEqual(entryA.listTasks(), []);

      const task = entryB.createTask({ type: 'cross-entry' });
      bumpMtimeForward(storePath);

      // With the gate off, A keeps its cached empty state (legacy behavior).
      assert.strictEqual(entryA.getTask(task.id), null);
      assert.strictEqual(entryA.listTasks().length, 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gate-on: fail-soft when the store file vanishes after load', () => {
  const { dir, storePath } = mkStorePath();
  try {
    withStoreEnv('true', () => {
      const entryA = createLargeTaskRuntimeStore({ storePath });
      entryA.createTask({ type: 'local' });
      assert.strictEqual(entryA.listTasks().length, 1);

      // File deleted out from under us → stale-check must not throw; keep the
      // in-memory copy rather than losing data.
      fs.rmSync(storePath, { force: true });
      assert.doesNotThrow(() => entryA.listTasks());
      assert.strictEqual(entryA.listTasks().length, 1);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default (env unset) is enabled: re-aligns to on-disk write', () => {
  const { dir, storePath } = mkStorePath();
  try {
    withStoreEnv(undefined, () => {
      const entryA = createLargeTaskRuntimeStore({ storePath });
      const entryB = createLargeTaskRuntimeStore({ storePath });

      assert.deepStrictEqual(entryA.listTasks(), []);
      const task = entryB.createTask({ type: 'cross-entry' });
      bumpMtimeForward(storePath);

      assert.ok(entryA.getTask(task.id), 'default-on should re-read the shared store');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
