'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const launcher = require('../src/services/backgroundTaskLauncher');
const runtime = require('../src/tasks/largeTaskRuntimeStore');
const diskOutput = require('../src/tasks/diskOutput');

// The default store fixes its path at module load, and the detached runner is a
// separate process — so launcher (in-process) and runner (child) must share the
// real default store/output dir. We therefore run against the default store and
// clean up every task we create. The in-process singleton never re-reads disk,
// so to observe the child's cross-process writes we read via a fresh instance.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function freshGetTask(taskId) {
  const storePath = typeof runtime.getStorePath === 'function' ? runtime.getStorePath() : null;
  const store = runtime.createLargeTaskRuntimeStore(storePath ? { storePath } : {});
  return store.getTask(taskId);
}

function waitForStatus(taskId, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = freshGetTask(taskId);
    if (task && predicate(task)) return task;
    sleep(150);
  }
  return freshGetTask(taskId);
}

function cleanup(taskId) {
  const storePath = typeof runtime.getStorePath === 'function' ? runtime.getStorePath() : null;
  try {
    const store = runtime.createLargeTaskRuntimeStore(storePath ? { storePath } : {});
    store.deleteTask(taskId);
  } catch { /* ignore */ }
  try { diskOutput.cleanupTaskOutput(taskId); } catch { /* ignore */ }
}

test('isEnabled reflects KHY_BG_TASKS gate', () => {
  const prev = process.env.KHY_BG_TASKS;
  try {
    delete process.env.KHY_BG_TASKS;
    assert.strictEqual(launcher.isEnabled(), true);
    process.env.KHY_BG_TASKS = 'off';
    assert.strictEqual(launcher.isEnabled(), false);
    process.env.KHY_BG_TASKS = '1';
    assert.strictEqual(launcher.isEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.KHY_BG_TASKS;
    else process.env.KHY_BG_TASKS = prev;
  }
});

test('launch rejects invalid spec', () => {
  const r = launcher.launch({ kind: 'shell', command: '   ' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /shell/);
});

test('launch → detached shell task runs to completion, writes log', () => {
  if (process.platform === 'win32') return; // uses /bin/sh
  const r = launcher.launch({ kind: 'shell', command: 'echo hello-bg-task' });
  assert.strictEqual(r.ok, true, r.error);
  const taskId = r.task.id;
  try {
    assert.strictEqual(r.task.payload_json.source, 'bg_task');
    assert.strictEqual(r.task.status, 'queued');

    const done = waitForStatus(taskId, (t) => ['succeeded', 'failed', 'dead_letter'].includes(t.status));
    assert.strictEqual(done.status, 'succeeded', `expected succeeded, got ${done && done.status}`);

    assert.match(diskOutput.tailTaskOutput(taskId).content, /hello-bg-task/);
    assert.match(launcher.tailLogs(taskId), /hello-bg-task/);
  } finally {
    cleanup(taskId);
  }
});

test('launch → stop cancels a long-running task', () => {
  if (process.platform === 'win32') return;
  const r = launcher.launch({ kind: 'shell', command: 'sleep 30' });
  assert.strictEqual(r.ok, true, r.error);
  const taskId = r.task.id;
  let childPid = null;
  try {
    const running = waitForStatus(
      taskId,
      (t) => t.status === 'running' && t.payload_json && t.payload_json.runner_pid
    );
    assert.strictEqual(running.status, 'running');
    childPid = running.payload_json.child_pid;

    const stopped = launcher.stop(taskId);
    assert.strictEqual(stopped.ok, true);

    assert.strictEqual(freshGetTask(taskId).status, 'cancelled');

    // the child process should be gone shortly after the tree kill
    sleep(500);
    if (childPid) {
      let alive = true;
      try { process.kill(childPid, 0); } catch { alive = false; }
      assert.strictEqual(alive, false, `child ${childPid} should be dead`);
    }
  } finally {
    cleanup(taskId);
  }
});

test('stop on unknown task → ok:false', () => {
  const r = launcher.stop('does-not-exist-xyz');
  assert.strictEqual(r.ok, false);
});
