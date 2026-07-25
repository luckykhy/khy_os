/**
 * Workflow run worker — the cross-process queue consumer (Phase 2).
 *
 * Lives in services/backend (the agent engine) so workflow nodes execute with
 * the REAL backend primitives (LLM chat, tool-use, sub-agents, skills) rather
 * than a degraded stand-in. ai-backend only ENQUEUES `queued` rows; this worker
 * polls, atomically claims one, runs the snapshotted graph natively via
 * {@link runGraph}, and writes status + per-node log back to the same row. The
 * two processes never call each other — `workflow_runs` is the only bridge.
 *
 * Safety (this poller shares a process with the live trading backend):
 *   - env guard KHY_WORKFLOW_WORKER (default on; set "0"/"false" to disable);
 *   - table-existence probe before the first claim (ai-backend may not have
 *     created `workflow_runs` yet) — silently idle until it exists;
 *   - ATOMIC claim: UPDATE status queued->running WHERE id=? AND status='queued',
 *     then check affected row count, so two ticks (or future workers) never
 *     double-execute the same run;
 *   - CRASH RECOVERY: on start(), re-queue `running` rows that have gone stale
 *     (no `updatedAt` heartbeat for KHY_WORKFLOW_STALE_MS). When the serving
 *     process is killed mid-run (e.g. the ai-manage daemon's idle auto-shutdown),
 *     the row is left `running` forever with no worker to finish it; this sweep
 *     re-queues such orphans so the next tick re-claims them. The staleness gate
 *     (vs. a blind reset) avoids clobbering a run actively executing in a
 *     concurrent worker, whose `updatedAt` is refreshed on every node log;
 *   - every tick fully wrapped in try/catch — a bad run can never crash backend;
 *   - one run per tick (serial), bounding CPU/LLM load on the shared process.
 *
 * @pattern Polling consumer (mirrors credentialWatcherService)
 */
'use strict';

const executor = require('./workflowExecutor');

// ── Configuration ────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = Number(process.env.KHY_WORKFLOW_POLL_MS || 2500);
// A `running` row whose updatedAt is older than this is treated as an orphan
// from a dead process and re-queued on start. Default 3 min — generous enough
// that a single slow node (LLM call) in a live worker is never misjudged.
const STALE_RUN_MS = Number(process.env.KHY_WORKFLOW_STALE_MS || 180000);

// Quantum preemption: when > 0, a run yields after this many node-steps and is
// re-queued so other ready runs get a turn (fairness on the shared poller).
// Default 0 = disabled (strict FIFO-by-id, one run runs to completion per claim).
// Read dynamically so operators/tests can toggle without re-requiring the module.
function quantumSteps() {
  const n = Number(process.env.KHY_WORKFLOW_QUANTUM_STEPS || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function isEnabled() {
  const v = String(process.env.KHY_WORKFLOW_WORKER ?? '1').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

// ── State ────────────────────────────────────────────────────────────────────
let _started = false;
let _timer = null;
let _ticking = false;
let _tableReady = false;
let _stats = { ticks: 0, claimed: 0, succeeded: 0, failed: 0, paused: 0, preempted: 0, recovered: 0, errors: 0, lastTickAt: null };

// Lazily resolve the model so this module can be required before models load.
function getModel() {
  // eslint-disable-next-line global-require
  const { WorkflowRun, sequelize } = require('@khy/shared/models');
  return { WorkflowRun, sequelize };
}

// Probe table existence once; ai-backend creates it lazily on first enqueue.
async function ensureTable(WorkflowRun) {
  if (_tableReady) return true;
  try {
    const qi = WorkflowRun.sequelize.getQueryInterface();
    const tables = await qi.showAllTables();
    const names = (Array.isArray(tables) ? tables : []).map((t) =>
      (typeof t === 'string' ? t : t && (t.tableName || t.name)) || '');
    if (names.includes('workflow_runs')) {
      _tableReady = true;
    }
  } catch {
    // Probe failed (DB not ready) — stay not-ready, retry next tick.
  }
  return _tableReady;
}

/**
 * Crash recovery: re-queue `running` rows orphaned by a dead process.
 *
 * A row is an orphan when its status is `running` but `updatedAt` has not moved
 * for STALE_RUN_MS — the owning process died (crash, kill, idle auto-shutdown)
 * before writing a terminal status. We flip it back to `queued` (clearing
 * startedAt) under an atomic guard so the next tick re-claims it. A run actively
 * executing in a concurrent worker is skipped because its `updatedAt` is fresh
 * (every node log streams an update). Returns the number recovered.
 */
async function recoverStale(WorkflowRun) {
  const cutoff = Date.now() - STALE_RUN_MS;
  const rows = await WorkflowRun.findAll({ where: { status: 'running' } });
  let recovered = 0;
  for (const row of rows) {
    const updatedAtMs = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
    // Skip rows whose heartbeat is recent — they belong to a live worker.
    if (updatedAtMs && updatedAtMs > cutoff) continue;
    const log = Array.isArray(row.logJson) ? row.logJson.slice() : [];
    const staleSec = updatedAtMs ? Math.round((Date.now() - updatedAtMs) / 1000) : null;
    log.push({
      type: 'system',
      status: 'recovered',
      message: `Re-queued after worker restart (orphaned ${staleSec == null ? 'unknown' : `${staleSec}s`} stale)`,
    });
    // eslint-disable-next-line no-await-in-loop
    const [affected] = await WorkflowRun.update(
      { status: 'queued', startedAt: null, logJson: log },
      { where: { id: row.id, status: 'running' } }, // atomic: only if still running
    );
    if (affected) recovered += 1;
  }
  return recovered;
}

/**
 * Atomically claim the oldest queued run. Returns the claimed WorkflowRun
 * instance, or null if none was available / the claim lost a race.
 */
async function claimNext(WorkflowRun) {
  // Ready-queue ordering. With quantum preemption on, a yielded run is re-queued
  // with a fresh updatedAt; ordering by updatedAt sends it to the BACK so other
  // ready runs take their turn (round-robin fairness). With quantum off, keep
  // strict FIFO-by-id (a fresh enqueue's updatedAt≈createdAt, so this is a
  // no-op-equivalent default — zero behavior change).
  const order = quantumSteps() > 0
    ? [['updatedAt', 'ASC'], ['id', 'ASC']]
    : [['id', 'ASC']];
  const candidate = await WorkflowRun.findOne({
    where: { status: 'queued' },
    order,
  });
  if (!candidate) return null;

  const [affected] = await WorkflowRun.update(
    { status: 'running', startedAt: new Date() },
    { where: { id: candidate.id, status: 'queued' } },
  );
  if (!affected) return null; // lost the race to another tick/worker

  // Re-read so callers see the claimed state (and decoded JSON getters).
  return WorkflowRun.findByPk(candidate.id);
}

async function executeRun(run) {
  const graph = run.graphJson || {};
  const initialVars = run.varsJson || {};

  // Resume? A re-enqueued run carries a pending checkpoint (pendingJson). Two
  // kinds: an awaiting_input park (askUserQuestion) also carries the user's
  // answer (resumeJson); a quantum yield carries no answer and just continues.
  const pending = run.pendingJson || null;
  const answerPayload = run.resumeJson || null;
  const priorLog = Array.isArray(run.logJson) ? run.logJson : [];
  const isQuantumResume = !!(pending && pending.kind === 'quantum' && pending.nodeId);
  const isAnswerResume = !!(pending && pending.nodeId && answerPayload && !isQuantumResume);
  // On an answer resume, drop the trailing awaiting_input placeholder — the
  // resumed ask node re-logs itself as succeeded. A quantum yield parked no
  // placeholder (the next node had not run yet), so keep the prior log intact.
  const baseLog = isAnswerResume
    ? priorLog.filter((el, i) => !(i === priorLog.length - 1 && el.status === 'awaiting_input'))
    : (isQuantumResume ? priorLog.slice() : []);
  const liveLog = baseLog.slice();

  const resume = isAnswerResume
    ? { nodeId: pending.nodeId, answer: answerPayload.answer, loopState: pending.loopState || {} }
    : (isQuantumResume
      ? { nodeId: pending.nodeId, kind: 'quantum', loopState: pending.loopState || {} }
      : null);

  try {
    const result = await executor.runGraph(graph, {
      // Thread the run owner so per-user plugin tools (`plugin__<slug>__<op>`)
      // resolve against THIS user's installed plugins + auth config.
      primitives: executor.defaultPrimitives({ userId: run.userId }),
      vars: initialVars,
      pauseOnAsk: true,
      quantum: quantumSteps(),
      resume,
      onLog: (entry) => {
        liveLog.push(entry);
        // Best-effort streaming write so the UI can poll partial progress.
        run.update({ logJson: liveLog.slice() }).catch(() => {});
      },
    });

    const fullLog = baseLog.concat(result.log);

    if (result.status === 'paused') {
      const isQuantumYield = !!(result.pause && result.pause.kind === 'quantum');
      if (isQuantumYield) {
        // Time-slice yield: re-queue immediately (no human input). The fresh
        // updatedAt sends it to the back of the ready-queue so other runs
        // interleave; the next claim resumes it from the quantum checkpoint.
        await run.update({
          status: 'queued',
          varsJson: result.vars,
          logJson: fullLog,
          pendingJson: result.pause,
          resumeJson: null,
          error: null,
        });
        _stats.preempted = (_stats.preempted || 0) + 1;
        return;
      }
      // Park the run: persist the question + checkpoint, clear the consumed answer.
      await run.update({
        status: 'awaiting_input',
        varsJson: result.vars,
        logJson: fullLog,
        pendingJson: result.pause,
        resumeJson: null,
        error: null,
      });
      _stats.paused += 1;
      return;
    }

    await run.update({
      status: 'succeeded',
      varsJson: result.vars,
      logJson: fullLog,
      pendingJson: null,
      resumeJson: null,
      error: null,
      finishedAt: new Date(),
    });
    _stats.succeeded += 1;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const errLog = err && Array.isArray(err.log) ? baseLog.concat(err.log) : liveLog;
    await run.update({
      status: 'failed',
      varsJson: err && err.vars ? err.vars : initialVars,
      logJson: errLog,
      pendingJson: null,
      resumeJson: null,
      error: message,
      finishedAt: new Date(),
    });
    _stats.failed += 1;
  }
}

async function tick() {
  if (_ticking) return; // never overlap ticks
  _ticking = true;
  _stats.ticks += 1;
  _stats.lastTickAt = new Date().toISOString();
  try {
    const { WorkflowRun } = getModel();
    if (!(await ensureTable(WorkflowRun))) return;

    const run = await claimNext(WorkflowRun);
    if (!run) return;
    _stats.claimed += 1;
    await executeRun(run);
  } catch (err) {
    _stats.errors += 1;
    // Swallow — a worker fault must never take down the trading backend.
  } finally {
    _ticking = false;
  }
}

function start() {
  if (_started) return;
  if (!isEnabled()) {
    console.log('[workflow-worker] disabled via KHY_WORKFLOW_WORKER');
    return;
  }
  _started = true;
  // Recover orphaned runs from a prior crash/shutdown before polling resumes.
  // Fire-and-forget: a recovery failure must never block the worker from starting.
  (async () => {
    try {
      const { WorkflowRun } = getModel();
      if (!(await ensureTable(WorkflowRun))) return;
      const recovered = await recoverStale(WorkflowRun);
      if (recovered) {
        _stats.recovered += recovered;
        console.log(`[workflow-worker] recovered ${recovered} orphaned run(s) -> queued`);
      }
    } catch {
      // swallow — recovery is best-effort
    }
  })();
  _timer = setInterval(() => { tick().catch(() => {}); }, POLL_INTERVAL_MS);
  if (_timer.unref) _timer.unref(); // do not keep the process alive for polling
  console.log(`[workflow-worker] started (poll ${POLL_INTERVAL_MS}ms)`);
}

function stop() {
  if (!_started) return;
  _started = false;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

function getStatus() {
  return { started: _started, enabled: isEnabled(), tableReady: _tableReady, ..._stats };
}

module.exports = {
  start,
  stop,
  getStatus,
  // exposed for tests
  tick,
  claimNext,
  recoverStale,
  executeRun,
};
