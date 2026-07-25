'use strict';

/**
 * backgroundTaskLauncher — thin IO shell for user-launched background tasks.
 *
 * Wraps the pure decisions in backgroundTaskSpec with the actual side effects:
 * create the durable task record, spawn the detached scripts/task-runner.js
 * process (which survives REPL/CLI exit), stop a running task by killing its
 * process tree, and tail its disk log. All methods are fail-soft.
 *
 * The gate KHY_BG_TASKS (default-on) governs the create path; inspecting and
 * cancelling existing tasks is never gated.
 */

const path = require('path');
const { spawn } = require('child_process');

const runtime = require('../tasks/largeTaskRuntimeStore');
const diskOutput = require('../tasks/diskOutput');
const { buildTaskSpec, buildStopPlan } = require('./backgroundTaskSpec');

const RUNNER_PATH = path.resolve(__dirname, '../../scripts/task-runner.js');

/**
 * A store instance that reads the latest on-disk state.
 *
 * The default in-process store loads once and never re-reads disk, so it stays
 * stale relative to the detached runner (which writes runner_pid/child_pid and
 * status transitions to disk in a separate process). For stop/inspect we must
 * see those child-written fields, so we spin up a fresh instance bound to the
 * same store path. Falls back to the default singleton if anything goes wrong.
 */
function _freshStore() {
  try {
    const storePath = typeof runtime.getStorePath === 'function' ? runtime.getStorePath() : null;
    return runtime.createLargeTaskRuntimeStore(storePath ? { storePath } : {});
  } catch {
    return runtime;
  }
}

/** Whether the background-task create path is enabled (default-on). */
function isEnabled(env = process.env) {
  const raw = String((env && env.KHY_BG_TASKS) ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * Enqueue a background task and spawn its detached runner.
 *
 * @param {object} input { kind:'shell'|'agent', command?, prompt?, cwd? }
 * @returns {{ok:true, task:object} | {ok:false, error:string}}
 */
function launch(input = {}) {
  if (!isEnabled()) {
    return { ok: false, error: '后台任务已禁用(KHY_BG_TASKS=off)。' };
  }

  const spec = buildTaskSpec({
    kind: input.kind,
    command: input.command,
    prompt: input.prompt,
    cwd: input.cwd,
    platform: process.platform,
    nodeExec: process.execPath,
    khyEntry: path.resolve(__dirname, '../../bin/khy.js'),
  });
  if (!spec.ok) {
    return { ok: false, error: spec.error };
  }

  let task;
  try {
    task = runtime.createTask({
      type: spec.type,
      payload_json: spec.payload_json,
      max_attempts: 1,
    });
  } catch (err) {
    return { ok: false, error: `创建任务失败: ${err && err.message ? err.message : err}` };
  }

  try {
    const child = spawn(process.execPath, [RUNNER_PATH, task.id], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  } catch (err) {
    try { runtime.markFailed(task.id, 'bg-task-launcher', { type: 'spawn_failed', message: String(err && err.message || err) }); } catch { /* ignore */ }
    return { ok: false, error: `启动后台进程失败: ${err && err.message ? err.message : err}` };
  }

  return { ok: true, task };
}

/**
 * Kill a background task's process tree and mark it cancelled.
 *
 * @param {string} taskId
 * @returns {{ok:true, task:object, killed:boolean} | {ok:false, error:string}}
 */
function stop(taskId) {
  const id = String(taskId || '').trim();
  if (!id) return { ok: false, error: 'taskId 为必填项。' };

  // Read fresh from disk so we see the runner_pid/child_pid the detached child
  // wrote — the default in-process singleton never reloads and would be stale.
  const store = _freshStore();
  let task = null;
  try { task = store.getTask(id); } catch { /* ignore */ }
  if (!task) return { ok: false, error: `未找到任务 ${id}。` };

  const { pid } = buildStopPlan(task);
  let killed = false;
  if (Number.isInteger(pid) && pid > 0) {
    killed = _killProcessTree(pid);
  }

  let latest = task;
  try { latest = store.cancelTask(id, 'cancelled by tasks command') || task; } catch { /* already terminal */ }
  return { ok: true, task: latest, killed };
}

/** Best-effort cross-platform process-tree kill. */
function _killProcessTree(pid) {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }
  // Unix: the detached runner is a process-group leader; kill the whole group.
  try {
    process.kill(-pid, 'SIGTERM');
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Tail a background task's disk log.
 *
 * @param {string} taskId
 * @param {number} [maxBytes]
 * @returns {string}
 */
function tailLogs(taskId, maxBytes) {
  const id = String(taskId || '').trim();
  if (!id) return '';
  try {
    const result = diskOutput.tailTaskOutput(id, maxBytes);
    if (typeof result === 'string') return result;
    if (result && typeof result.content === 'string') return result.content;
    return '';
  } catch {
    return '';
  }
}

module.exports = { isEnabled, launch, stop, tailLogs, RUNNER_PATH };
