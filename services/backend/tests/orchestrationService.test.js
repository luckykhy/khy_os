'use strict';

/**
 * orchestrationService.test.js — hermetic end-to-end coverage of the orchestration
 * executor. Both seams the service exposes are injected:
 *   - opts.taskBoard   : an in-memory stand-in faithfully replicating taskBoard's
 *                        claim gating (deps must be 'done' AND parent 'running'/'done'),
 *                        completeTask, and failTask (consecutive_failures → BLOCKED).
 *   - opts.agentRunner : a stub runner so no real sub-agent is ever spawned.
 *
 * The journal is a thin IO shell that is NOT injectable, so we point KHY_DATA_HOME
 * at a throwaway temp dir before the service touches it. This keeps the run trace
 * real (we assert on it) without polluting the user's data home.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// Redirect the data home BEFORE the service (→ journal → dataHome) resolves it.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-orch-test-'));
process.env.KHY_DATA_HOME = TMP_HOME;

const test = require('node:test');
const assert = require('node:assert');

const svc = require('../src/services/orchestrator/orchestrationService');
const journal = require('../src/services/orchestrator/orchestrationJournal');

// Globally unique id counter — real taskBoard never reuses ids across runs, so
// each run gets its own journal file (run-<id>.jsonl). A per-instance counter
// would reuse 't1' and make distinct runs collide on one journal file.
let GLOBAL_TASK_ID = 0;

// ── In-memory taskBoard faithful to the canonical SQLite interface ──────────────
function makeTaskBoard() {
  const STATUS = {
    TRIAGE: 'triage', TODO: 'todo', READY: 'ready', RUNNING: 'running',
    BLOCKED: 'blocked', DONE: 'done', ARCHIVED: 'archived',
  };
  const tasks = new Map();

  function createTask(input = {}) {
    GLOBAL_TASK_ID += 1;
    const id = `t${GLOBAL_TASK_ID}`;
    const task = {
      id,
      title: input.title || '',
      description: input.description || '',
      parentId: input.parentId || null,
      dependencies: Array.isArray(input.dependencies) ? input.dependencies.slice() : [],
      priority: input.priority || 'medium',
      status: input.status || STATUS.TRIAGE,
      maxRetries: Number.isFinite(input.maxRetries) ? input.maxRetries : 1,
      consecutiveFailures: 0,
      claimLock: null,
      claimExpires: null,
      result: null,
      completedAt: null,
    };
    tasks.set(id, task);
    return { ...task };
  }
  function getTask(id) {
    const t = tasks.get(id);
    return t ? { ...t } : null;
  }
  function updateTask(id, updates = {}) {
    const t = tasks.get(id);
    if (!t) return null;
    Object.assign(t, updates);
    return { ...t };
  }
  function getChildTasks(parentId) {
    return [...tasks.values()].filter((t) => t.parentId === parentId).map((t) => ({ ...t }));
  }
  function claimTask(id, workerId) {
    const t = tasks.get(id);
    if (!t) return false;
    if (t.status !== STATUS.READY || t.claimLock) return false;
    // dependency gating: every dependency must be 'done'
    for (const depId of t.dependencies) {
      const dep = tasks.get(depId);
      if (!dep || dep.status !== STATUS.DONE) return false;
    }
    // parent gating: parent must be 'running' or 'done'
    if (t.parentId) {
      const p = tasks.get(t.parentId);
      if (!p || (p.status !== STATUS.RUNNING && p.status !== STATUS.DONE)) return false;
    }
    t.status = STATUS.RUNNING;
    t.claimLock = workerId;
    return true;
  }
  function completeTask(id, result) {
    const t = tasks.get(id);
    if (!t) return false;
    t.status = STATUS.DONE;
    t.result = result;
    t.claimLock = null;
    t.completedAt = 1;
    return true;
  }
  function failTask(id, reason) {
    const t = tasks.get(id);
    if (!t) return false;
    t.consecutiveFailures += 1;
    t.result = reason;
    t.claimLock = null;
    // BLOCKED once the failure budget (maxRetries) is exhausted.
    t.status = t.consecutiveFailures >= (t.maxRetries || 1) ? STATUS.BLOCKED : STATUS.READY;
    return true;
  }
  return {
    STATUS, createTask, getTask, updateTask, getChildTasks,
    claimTask, completeTask, failTask, _dump: () => [...tasks.values()],
  };
}

// Records every step the runner is asked to execute; outcome is keyed by prompt.
function makeRunner(failPrompts = new Set()) {
  const calls = [];
  const runner = async (step) => {
    calls.push(step.prompt);
    if (failPrompts.has(step.prompt)) {
      return { success: false, error: `boom:${step.prompt}` };
    }
    return { success: true, output: `done:${step.prompt}` };
  };
  return { runner, calls };
}

test('sequential run executes steps strictly in dependency order and finishes done', async () => {
  const tb = makeTaskBoard();
  const { runner, calls } = makeRunner();
  const status = await svc.runOrchestration(
    { mode: 'sequential', steps: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] },
    { taskBoard: tb, agentRunner: runner },
  );
  assert.strictEqual(status.control, 'done');
  assert.strictEqual(status.progress.total, 3);
  assert.strictEqual(status.progress.done, 3);
  assert.strictEqual(status.progress.failed, 0);
  // sequential ⇒ exactly this order
  assert.deepStrictEqual(calls, ['a', 'b', 'c']);
  assert.ok(status.steps.every((s) => s.status === 'done'));
  assert.strictEqual(status.steps[0].result, 'done:a');
});

test('parallel run claims all independent steps and finishes done', async () => {
  const tb = makeTaskBoard();
  const { runner, calls } = makeRunner();
  const status = await svc.runOrchestration(
    { mode: 'parallel', steps: [{ prompt: 'x' }, { prompt: 'y' }, { prompt: 'z' }] },
    { taskBoard: tb, agentRunner: runner },
  );
  assert.strictEqual(status.control, 'done');
  assert.strictEqual(status.progress.done, 3);
  assert.deepStrictEqual(calls.slice().sort(), ['x', 'y', 'z']);
});

test('phase run runs a later phase only after the previous phase fully completes', async () => {
  const tb = makeTaskBoard();
  const order = [];
  const runner = async (step) => { order.push(step.prompt); return { success: true, output: 'ok' }; };
  const status = await svc.runOrchestration(
    {
      mode: 'phase',
      phases: [
        { name: 'research', steps: [{ prompt: 'r1' }, { prompt: 'r2' }] },
        { name: 'build', steps: [{ prompt: 'b1' }] },
      ],
    },
    { taskBoard: tb, agentRunner: runner },
  );
  assert.strictEqual(status.control, 'done');
  assert.strictEqual(status.progress.done, 3);
  // b1 must come strictly after both r1 and r2
  assert.ok(order.indexOf('b1') > order.indexOf('r1'));
  assert.ok(order.indexOf('b1') > order.indexOf('r2'));
});

test('a failing step blocks the run, propagates to dependents, and surfaces the error', async () => {
  const tb = makeTaskBoard();
  const { runner, calls } = makeRunner(new Set(['b']));
  const status = await svc.runOrchestration(
    { mode: 'sequential', steps: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] },
    { taskBoard: tb, agentRunner: runner },
  );
  assert.strictEqual(status.control, 'failed');
  assert.strictEqual(status.progress.done, 1);   // only 'a'
  assert.ok(status.progress.failed >= 1);
  // 'c' depends on 'b' which blocked → never claimed → never run
  assert.deepStrictEqual(calls, ['a', 'b']);
  const failed = status.steps.find((s) => s.status === 'blocked');
  assert.ok(failed, 'a blocked step is reported');
  assert.match(String(failed.error), /boom:b/);
});

test('pause stops new work; resume drives the run to completion', async () => {
  const tb = makeTaskBoard();
  const { runner, calls } = makeRunner();
  const opts = { taskBoard: tb, agentRunner: runner };
  const { runId } = svc.createRun(
    { mode: 'sequential', steps: [{ prompt: 'p1' }, { prompt: 'p2' }] }, opts,
  );
  // Pause before any execution.
  const paused = svc.pauseRun(runId, opts);
  assert.strictEqual(paused.control, 'paused');
  // executeRun while paused must be a no-op.
  const stillPaused = await svc.executeRun(runId, opts);
  assert.strictEqual(stillPaused.control, 'paused');
  assert.strictEqual(calls.length, 0);
  // Resume → runs to done.
  const resumed = await svc.resumeRun(runId, opts);
  assert.strictEqual(resumed.control, 'done');
  assert.deepStrictEqual(calls, ['p1', 'p2']);
});

test('replay resets blocked steps and re-runs them while skipping already-done steps', async () => {
  const tb = makeTaskBoard();
  // Fail 'b' on the first pass only.
  const failPrompts = new Set(['b']);
  const calls = [];
  const runner = async (step) => {
    calls.push(step.prompt);
    if (failPrompts.has(step.prompt)) return { success: false, error: 'transient' };
    return { success: true, output: `ok:${step.prompt}` };
  };
  const opts = { taskBoard: tb, agentRunner: runner };
  const first = await svc.runOrchestration(
    { mode: 'sequential', steps: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] }, opts,
  );
  assert.strictEqual(first.control, 'failed');
  assert.deepStrictEqual(calls, ['a', 'b']);

  // The transient failure clears; replay should re-run b (and then c), NOT a.
  failPrompts.clear();
  const replayed = await svc.replayRun(first.runId, opts);
  assert.strictEqual(replayed.control, 'done');
  assert.strictEqual(replayed.progress.done, 3);
  // 'a' ran once (skipped on replay because it was already done); 'b' ran twice.
  assert.strictEqual(calls.filter((c) => c === 'a').length, 1);
  assert.strictEqual(calls.filter((c) => c === 'b').length, 2);
  assert.strictEqual(calls.filter((c) => c === 'c').length, 1);
});

test('cancel marks the run cancelled and stops execution', async () => {
  const tb = makeTaskBoard();
  const { runner, calls } = makeRunner();
  const opts = { taskBoard: tb, agentRunner: runner };
  const { runId } = svc.createRun(
    { mode: 'parallel', steps: [{ prompt: 'q1' }, { prompt: 'q2' }] }, opts,
  );
  const cancelled = svc.cancelRun(runId, opts);
  assert.strictEqual(cancelled.control, 'cancelled');
  const after = await svc.executeRun(runId, opts);
  assert.strictEqual(after.control, 'cancelled');
  assert.strictEqual(calls.length, 0);
});

test('journal records the run trajectory and listRuns surfaces it', async () => {
  const tb = makeTaskBoard();
  const { runner } = makeRunner();
  const status = await svc.runOrchestration(
    { mode: 'parallel', steps: [{ prompt: 'j1' }] },
    { taskBoard: tb, agentRunner: runner },
  );
  const records = journal.readJournal(status.runId, process.env);
  const types = records.map((r) => r.type);
  assert.ok(types.includes('run_created'));
  assert.ok(types.includes('step_start'));
  assert.ok(types.includes('step_done'));
  assert.ok(types.includes('run_end'));
  // monotonic seq
  for (let i = 1; i < records.length; i++) {
    assert.ok(records[i].seq > records[i - 1].seq, 'journal seq is monotonic');
  }
  const runs = svc.listRuns({ taskBoard: tb });
  assert.ok(runs.some((r) => r.runId === status.runId));
});

test.after(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
});
