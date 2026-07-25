'use strict';

/**
 * task-runner.js — the detached per-task executor for `khy tasks run`.
 *
 * Spawned (detached) by services/backgroundTaskLauncher.js as
 *   node scripts/task-runner.js <taskId>
 * so the work survives REPL/CLI exit. It drives ONE task through the durable
 * store's state machine: claim → start → (heartbeat) → spawn the child process
 * described by the task payload → tee stdout/stderr to the task's disk log →
 * mark succeeded (exit 0) or failed (non-zero / spawn error) on child close.
 *
 * Everything is best-effort / fail-soft: any failure still tries to record a
 * terminal state so the task never gets stuck "running" forever.
 */

const fs = require('fs');
const { spawn } = require('child_process');

const store = require('../src/tasks/largeTaskRuntimeStore');
const diskOutput = require('../src/tasks/diskOutput');
const { buildTaskSpec } = require('../src/services/backgroundTaskSpec');

const WORKER_ID = 'bg-task-runner';
const HEARTBEAT_MS = 15_000;

function _mergePayloadPid(taskId, patch) {
  try {
    const current = store.getTask(taskId);
    const payload = (current && current.payload_json && typeof current.payload_json === 'object')
      ? current.payload_json
      : {};
    store.updateTaskFields(taskId, { payload_json: { ...payload, ...patch } });
  } catch {
    /* fail-soft: pid tracking is best-effort */
  }
}

function _markFailed(taskId, type, message) {
  try {
    store.markFailed(taskId, WORKER_ID, { type, message: String(message || type) });
  } catch {
    /* already terminal or store unavailable */
  }
}

function main() {
  const taskId = String(process.argv[2] || '').trim();
  if (!taskId) {
    process.exit(2);
    return;
  }

  let task;
  try {
    task = store.getTask(taskId);
  } catch {
    process.exit(2);
    return;
  }
  if (!task) {
    process.exit(2);
    return;
  }

  // Claim + start the task. If it was already cancelled/claimed elsewhere, bail.
  try {
    if (task.status === 'queued') {
      store.claimTask(taskId, WORKER_ID);
    }
    store.startTask(taskId, WORKER_ID);
  } catch (err) {
    _markFailed(taskId, 'start_failed', err && err.message);
    process.exit(1);
    return;
  }

  _mergePayloadPid(taskId, { runner_pid: process.pid });

  // Rebuild the child argv from the payload (single source of truth).
  const spec = buildTaskSpec({
    kind: task.payload_json && task.payload_json.kind,
    command: task.payload_json && task.payload_json.command,
    prompt: task.payload_json && task.payload_json.prompt,
    cwd: task.payload_json && task.payload_json.cwd,
    platform: process.platform,
    nodeExec: process.execPath,
    khyEntry: require('path').resolve(__dirname, '../bin/khy.js'),
  });
  if (!spec.ok) {
    _markFailed(taskId, 'bad_spec', spec.error);
    process.exit(1);
    return;
  }

  // Prepare the output log and open it for append.
  let outFd = null;
  try {
    diskOutput.initTaskOutput(taskId);
    outFd = fs.openSync(diskOutput.getTaskOutputPath(taskId), 'a');
  } catch {
    outFd = 'ignore';
  }

  const cwd = (task.payload_json && task.payload_json.cwd) || process.cwd();
  let child;
  try {
    child = spawn(spec.argv.file, spec.argv.args, {
      cwd,
      env: process.env,
      stdio: ['ignore', outFd, outFd],
      windowsHide: true,
    });
  } catch (err) {
    _markFailed(taskId, 'spawn_failed', err && err.message);
    process.exit(1);
    return;
  }

  _mergePayloadPid(taskId, { runner_pid: process.pid, child_pid: child.pid });

  const heartbeat = setInterval(() => {
    try { store.heartbeatTask(taskId, WORKER_ID); } catch { /* best-effort */ }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  // Graceful stop: forward termination to the child before we exit.
  const onSignal = () => {
    try { if (child && child.pid) child.kill('SIGTERM'); } catch { /* ignore */ }
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  child.on('error', (err) => {
    clearInterval(heartbeat);
    _markFailed(taskId, 'child_error', err && err.message);
    process.exit(1);
  });

  child.on('close', (code, signal) => {
    clearInterval(heartbeat);
    // Our in-process store view never reloads from disk, so it can be stale
    // relative to a concurrent cancel from the launcher/control plane. Read the
    // latest state from a fresh instance before deciding the terminal status.
    let latest = null;
    try {
      const fresh = store.createLargeTaskRuntimeStore({ storePath: store.getStorePath() });
      latest = fresh.getTask(taskId);
    } catch { /* ignore */ }
    if (latest && (latest.status === 'cancelled' || latest.status === 'cancelling')) {
      process.exit(0);
      return;
    }
    if (signal) {
      // Terminated by a signal — in this design that means an external stop
      // (our own stop()/cancel), not a task failure. Reflect it as cancelled
      // rather than failed/dead_letter.
      try {
        const fresh = store.createLargeTaskRuntimeStore({ storePath: store.getStorePath() });
        fresh.cancelTask(taskId, `terminated by signal ${signal}`);
      } catch { /* already terminal */ }
      process.exit(0);
      return;
    }
    if (code === 0) {
      try {
        store.markSucceeded(taskId, WORKER_ID, { exit_code: 0 }, { progress_pct: 100 });
      } catch { /* already terminal */ }
      process.exit(0);
      return;
    }
    _markFailed(taskId, 'nonzero_exit', `exited with code ${code}`);
    process.exit(1);
  });
}

main();
