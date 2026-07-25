'use strict';

/**
 * orchestrationService.js — thin multi-agent orchestration layer.
 *
 * This is the UNIFIED ENTRY for expressing sequential / parallel / phase workflows.
 * It is deliberately a coordination shell over existing infrastructure and rewrites
 * nothing:
 *   - plan DAG            : services/orchestrator/orchestrationPlan.js (pure leaf)
 *   - task system         : coordinator/taskBoard.js (THE store — parent + children
 *                           with dependency edges; claim/complete/fail; getChildTasks)
 *   - sub-agent execution : tools/AgentTool.execute(params, ctx) → {success, output, error}
 *   - execution trajectory: services/orchestrator/orchestrationJournal.js (JSONL)
 *
 * Workflow ordering is enforced by taskBoard itself: claimTask() refuses a child
 * until (a) all its dependency tasks are 'done' and (b) its parent is 'running'/'done'.
 * We exploit (b) for pause: setting the parent to 'blocked' makes every child claim
 * fail, so the run stops accepting new work without killing in-flight steps.
 *
 * Gate: KHY_ORCHESTRATE (default ON). The CLI handler refuses to run when off; this
 * module exposes orchestrateEnabled() so the boundary check lives in one place.
 *
 * The run id IS the parent taskBoard id (no separate mapping table). The parent task
 * stores run metadata (mode/label/plan/idMap) in `description` and the run control
 * state ('running'|'paused'|'cancelled'|'done'|'failed'|'idle') in `result`.
 */

const plan = require('./orchestrationPlan');
const journal = require('./orchestrationJournal');

const DEFAULT_RESULT_CHARS = 2000;
const DEFAULT_STEP_MAX_RETRIES = 1; // fail → blocked immediately; `replay` is the explicit retry

function orchestrateEnabled(env = process.env) {
  const v = env.KHY_ORCHESTRATE;
  if (v === undefined || v === null || v === '') return true; // default ON
  return !(v === '0' || String(v).toLowerCase() === 'false' || String(v).toLowerCase() === 'off');
}

function _parseJson(str, fallback) {
  if (str == null) return fallback;
  if (typeof str === 'object') return str;
  try { return JSON.parse(str); } catch { return fallback; }
}

function _truncate(s, max = DEFAULT_RESULT_CHARS) {
  const str = s == null ? '' : String(s);
  return str.length <= max ? str : str.slice(0, max) + '… [truncated]';
}

function _now() { return Date.now(); }
function _iso(ms) { return new Date(ms).toISOString(); }

// Mirror AgentTool's fan-out policy without importing it (same env seams).
function _fanoutLimit(env = process.env) {
  if (env.KHY_ENABLE_MULTI_AGENT === 'false') return 1;
  const n = parseInt(env.KHY_MAX_SUBAGENTS, 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

async function _runLimited(items, limit, worker) {
  const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : (items.length || 1);
  let i = 0;
  async function next() {
    const idx = i;
    i += 1;
    if (idx >= items.length) return;
    await worker(items[idx], idx);
    return next();
  }
  const runners = [];
  for (let k = 0; k < Math.min(lim, items.length); k++) runners.push(next());
  await Promise.all(runners);
}

function _taskBoard(opts) {
  return opts.taskBoard || require('../../coordinator/taskBoard');
}

async function _defaultAgentRunner(step, opts) {
  const AgentTool = require('../../tools/AgentTool');
  const params = { prompt: step.prompt, role: step.role };
  if (step.subagentType) params.subagent_type = step.subagentType;
  if (step.model) params.model = step.model;
  if (opts.timeout) params.timeout = opts.timeout;
  const res = await AgentTool.execute(params, opts.agentContext || {});
  return {
    success: !!(res && res.success),
    output: res && res.output != null ? String(res.output) : (res && res.message) || '',
    error: res && res.error ? String(res.error) : (res && res.success ? null : 'sub-agent reported failure'),
  };
}

function _agentRunner(opts) {
  return typeof opts.agentRunner === 'function' ? opts.agentRunner : _defaultAgentRunner;
}

function _nextSeq(runId, opts) {
  const records = journal.readJournal(runId, opts.env);
  let max = -1;
  for (const r of records) { if (typeof r.seq === 'number' && r.seq > max) max = r.seq; }
  return max + 1;
}

function _appendJournal(runId, type, fields, ctx) {
  const record = { seq: ctx.seq, at: _iso(_now()), type, ...fields };
  ctx.seq += 1;
  journal.appendJournal(runId, record, ctx.opts.env);
}

function _readControl(parentTask) {
  const meta = _parseJson(parentTask && parentTask.result, {});
  return (meta && meta.control) || 'running';
}

function _writeControl(runId, control, parentStatus, opts) {
  const tb = _taskBoard(opts);
  const parent = tb.getTask(runId);
  if (!parent) throw new Error(`orchestration run not found: ${runId}`);
  const prev = _parseJson(parent.result, {});
  const updates = { result: JSON.stringify({ ...prev, control }) };
  if (parentStatus) updates.status = parentStatus;
  if (control === 'done') updates.completedAt = _now();
  tb.updateTask(runId, updates);
  return parent;
}

function _reverseStepIndex(meta) {
  // childTaskId -> step
  const idx = {};
  const idMap = (meta && meta.idMap) || {};
  const steps = (meta && meta.plan && meta.plan.steps) || [];
  const byStepId = {};
  for (const s of steps) byStepId[s.id] = s;
  for (const stepId of Object.keys(idMap)) idx[idMap[stepId]] = byStepId[stepId];
  return idx;
}

/**
 * Create a run: build the plan, persist parent + children to taskBoard.
 * @returns {{runId:string, plan:object}}
 */
function createRun(spec, opts = {}) {
  const builtPlan = plan.buildOrchestrationPlan(spec);
  const tb = _taskBoard(opts);
  const STATUS = tb.STATUS || {};
  const maxRetries = Number.isFinite(opts.maxRetries) && opts.maxRetries > 0
    ? Math.floor(opts.maxRetries) : DEFAULT_STEP_MAX_RETRIES;

  // Parent task = the run. Created READY then moved to RUNNING so children are claimable.
  const parent = tb.createTask({
    title: builtPlan.label,
    description: JSON.stringify({ kind: 'orchestration-run', mode: builtPlan.mode, label: builtPlan.label, plan: builtPlan }),
    priority: opts.priority || 'medium',
    status: STATUS.READY || 'ready',
  });
  const runId = parent.id;

  const idMap = {};
  for (const step of builtPlan.steps) {
    const depTaskIds = (step.dependsOn || []).map((d) => idMap[d]).filter(Boolean);
    const child = tb.createTask({
      title: `${step.id} · ${step.role}`,
      description: step.prompt,
      parentId: runId,
      dependencies: depTaskIds,
      priority: opts.priority || 'medium',
      status: STATUS.READY || 'ready',
      maxRetries,
    });
    idMap[step.id] = child.id;
  }

  // Persist idMap alongside the plan, and open the run as running.
  tb.updateTask(runId, {
    description: JSON.stringify({ kind: 'orchestration-run', mode: builtPlan.mode, label: builtPlan.label, plan: builtPlan, idMap }),
    status: STATUS.RUNNING || 'running',
    result: JSON.stringify({ control: 'running' }),
  });

  const ctx = { seq: 0, opts: { ...opts, env: opts.env || process.env } };
  _appendJournal(runId, 'run_created', { mode: builtPlan.mode, label: builtPlan.label, stepCount: builtPlan.stepCount }, ctx);

  return { runId, plan: builtPlan, idMap };
}

/**
 * Drive the run loop until no further progress is possible or control flips to
 * paused/cancelled. Steps already 'done' are skipped (idempotent — this is what
 * makes resume/replay safe). Returns a status summary.
 */
async function executeRun(runId, opts = {}) {
  const env = opts.env || process.env;
  const tb = _taskBoard(opts);
  const STATUS = tb.STATUS || {};
  const parent = tb.getTask(runId);
  if (!parent) throw new Error(`orchestration run not found: ${runId}`);
  const meta = _parseJson(parent.description, {});
  const stepByChild = _reverseStepIndex(meta);
  const runner = _agentRunner(opts);
  const fanout = Number.isFinite(opts.fanout) ? opts.fanout : _fanoutLimit(env);
  const ctx = { seq: _nextSeq(runId, opts), opts: { ...opts, env } };

  let control = _readControl(parent);
  if (control === 'paused' || control === 'cancelled') {
    return getRunStatus(runId, opts);
  }

  // Ensure parent is RUNNING so children are claimable.
  tb.updateTask(runId, { status: STATUS.RUNNING || 'running' });
  const workerId = `orch-${runId}`;
  const stepCount = (meta.plan && meta.plan.steps && meta.plan.steps.length) || 0;
  const iterationCap = stepCount * 2 + 5;
  let executed = 0;
  let iterations = 0;

  while (iterations < iterationCap) {
    iterations += 1;
    // Re-read control each iteration so a concurrent pause/cancel is honored.
    control = _readControl(tb.getTask(runId));
    if (control === 'paused' || control === 'cancelled') break;

    const children = tb.getChildTasks(runId) || [];
    const claimable = children.filter((c) => (c.status === (STATUS.READY || 'ready')) && !c.claimLock);
    const claimed = [];
    for (const c of claimable) {
      // claimTask enforces dependency + parent gating internally.
      if (tb.claimTask(c.id, workerId)) claimed.push(c);
    }
    if (claimed.length === 0) break; // nothing progressable right now

    await _runLimited(claimed, fanout, async (child) => {
      const step = stepByChild[child.id] || { prompt: child.description, role: 'general' };
      _appendJournal(runId, 'step_start', { stepId: step.id, childId: child.id, role: step.role }, ctx);
      let res;
      try {
        res = await runner(step, { ...opts, env });
      } catch (e) {
        res = { success: false, error: (e && e.message) || 'sub-agent threw' };
      }
      if (res && res.success) {
        tb.completeTask(child.id, _truncate(res.output));
        executed += 1;
        _appendJournal(runId, 'step_done', { stepId: step.id, childId: child.id, resultPreview: _truncate(res.output, 200) }, ctx);
      } else {
        const reason = String((res && res.error) || 'sub-agent failed');
        tb.failTask(child.id, reason);
        _appendJournal(runId, 'step_failed', { stepId: step.id, childId: child.id, error: reason }, ctx);
      }
    });
  }

  // Finalize run state (unless paused/cancelled mid-flight).
  if (control !== 'paused' && control !== 'cancelled') {
    const children = tb.getChildTasks(runId) || [];
    const allDone = children.length > 0 && children.every((c) => c.status === (STATUS.DONE || 'done'));
    const anyBlocked = children.some((c) => c.status === (STATUS.BLOCKED || 'blocked'));
    if (allDone) {
      _writeControl(runId, 'done', STATUS.DONE || 'done', opts);
      control = 'done';
    } else if (anyBlocked) {
      _writeControl(runId, 'failed', STATUS.BLOCKED || 'blocked', opts);
      control = 'failed';
    } else {
      _writeControl(runId, 'idle', STATUS.RUNNING || 'running', opts);
      control = 'idle';
    }
  }
  _appendJournal(runId, 'run_end', { control, executed, iterations }, ctx);

  const status = getRunStatus(runId, opts);
  status.executed = executed;
  return status;
}

/** Create a run and execute it to completion (or until it blocks). */
async function runOrchestration(spec, opts = {}) {
  const { runId } = createRun(spec, opts);
  return executeRun(runId, opts);
}

function pauseRun(runId, opts = {}) {
  const tb = _taskBoard(opts);
  const STATUS = tb.STATUS || {};
  _writeControl(runId, 'paused', STATUS.BLOCKED || 'blocked', opts);
  const ctx = { seq: _nextSeq(runId, opts), opts: { ...opts, env: opts.env || process.env } };
  _appendJournal(runId, 'control', { control: 'paused' }, ctx);
  return getRunStatus(runId, opts);
}

function cancelRun(runId, opts = {}) {
  const tb = _taskBoard(opts);
  const STATUS = tb.STATUS || {};
  _writeControl(runId, 'cancelled', STATUS.BLOCKED || 'blocked', opts);
  const ctx = { seq: _nextSeq(runId, opts), opts: { ...opts, env: opts.env || process.env } };
  _appendJournal(runId, 'control', { control: 'cancelled' }, ctx);
  return getRunStatus(runId, opts);
}

async function resumeRun(runId, opts = {}) {
  const tb = _taskBoard(opts);
  const STATUS = tb.STATUS || {};
  _writeControl(runId, 'running', STATUS.RUNNING || 'running', opts);
  const ctx = { seq: _nextSeq(runId, opts), opts: { ...opts, env: opts.env || process.env } };
  _appendJournal(runId, 'control', { control: 'running', action: 'resume' }, ctx);
  return executeRun(runId, opts);
}

/**
 * Replay: reset blocked/failed steps to READY (idempotently keeping done steps),
 * then re-execute. taskBoard's 'done' status is the checkpoint — no new snapshot store.
 */
async function replayRun(runId, opts = {}) {
  const tb = _taskBoard(opts);
  const STATUS = tb.STATUS || {};
  const children = tb.getChildTasks(runId) || [];
  let reset = 0;
  for (const c of children) {
    if (c.status === (STATUS.BLOCKED || 'blocked')) {
      tb.updateTask(c.id, {
        status: STATUS.READY || 'ready',
        consecutiveFailures: 0,
        claimLock: null,
        claimExpires: null,
        result: null,
      });
      reset += 1;
    }
  }
  _writeControl(runId, 'running', STATUS.RUNNING || 'running', opts);
  const ctx = { seq: _nextSeq(runId, opts), opts: { ...opts, env: opts.env || process.env } };
  _appendJournal(runId, 'control', { control: 'running', action: 'replay', reset }, ctx);
  return executeRun(runId, opts);
}

/**
 * Unified monitoring view for one run: parent control + per-step status/result/failure.
 * @returns {{runId, mode, label, control, progress, steps:Array}|null}
 */
function getRunStatus(runId, opts = {}) {
  const tb = _taskBoard(opts);
  const parent = tb.getTask(runId);
  if (!parent) return null;
  const meta = _parseJson(parent.description, {});
  const builtPlan = meta.plan || { steps: [] };
  const stepByChild = _reverseStepIndex(meta);
  const children = tb.getChildTasks(runId) || [];

  const statusById = {};
  const steps = children.map((c) => {
    const step = stepByChild[c.id] || {};
    if (step.id) statusById[step.id] = c.status;
    const failed = c.status === (tb.STATUS && tb.STATUS.BLOCKED || 'blocked');
    return {
      stepId: step.id || c.id,
      childId: c.id,
      role: step.role || '',
      status: c.status,
      dependsOn: step.dependsOn || [],
      result: failed ? null : (c.result != null ? _truncate(c.result, 200) : null),
      error: failed ? (c.result != null ? _truncate(c.result, 200) : 'blocked') : null,
    };
  });

  return {
    runId,
    mode: meta.mode || builtPlan.mode || '',
    label: meta.label || parent.title || '',
    control: _readControl(parent),
    progress: plan.summarizePlanProgress(builtPlan, statusById),
    steps,
  };
}

/**
 * List known runs (best-effort, journal-backed). Returns lightweight summaries.
 * @returns {Array<{runId, mode, label, control, progress}>}
 */
function listRuns(opts = {}) {
  const ids = journal.listJournalRunIds(opts.env);
  const out = [];
  for (const runId of ids) {
    const st = getRunStatus(runId, opts);
    if (st) out.push({ runId: st.runId, mode: st.mode, label: st.label, control: st.control, progress: st.progress });
  }
  return out;
}

module.exports = {
  orchestrateEnabled,
  createRun,
  executeRun,
  runOrchestration,
  pauseRun,
  resumeRun,
  replayRun,
  cancelRun,
  getRunStatus,
  listRuns,
  DEFAULT_STEP_MAX_RETRIES,
};
