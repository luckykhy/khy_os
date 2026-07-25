/**
 * Per-user workflow RUN service (multi-tenant) — the enqueue/read half of the
 * cross-process execution queue.
 *
 * Responsibilities (all tenant-scoped by `userId`):
 *   - enqueue(userId, workflowId): snapshot the workflow's current graph, strict-
 *     validate it (a half-built graph cannot run), and INSERT a `queued` row into
 *     `workflow_runs`. services/backend's worker picks it up and executes it.
 *   - getRun / listRuns: read run status + per-node log for the UI to poll.
 *
 * This service never executes anything itself — execution lives in the agent
 * engine (services/backend) where the real primitives are. The DB row is the
 * only bridge. The graph is snapshotted at enqueue so later edits to the source
 * workflow never mutate an in-flight or historical run.
 *
 * Table bootstrap mirrors workflowService: ai-backend does not run the global
 * sequelize.sync, so we lazily `WorkflowRun.sync()` once (model-scoped — touches
 * only `workflow_runs`).
 *
 * @pattern Repository (work-queue producer)
 */
'use strict';

const { WorkflowRun } = require('@khy/shared/models');
const workflowService = require('./workflowService');

const { httpError, validateGraph } = workflowService;

// ── Table bootstrap (idempotent, model-scoped) ──────────────────────────────

let tableReady = null;
async function ensureTable() {
  if (!tableReady) {
    tableReady = WorkflowRun.sync().catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

// ── Serialization ────────────────────────────────────────────────────────────

function toRunView(row, { includeGraph = false } = {}) {
  if (!row) return null;
  const view = {
    id: row.id,
    workflowId: row.workflowId,
    status: row.status,
    vars: row.varsJson || {},
    log: row.logJson || [],
    error: row.error || null,
    pending: row.pendingJson || null,
    startedAt: row.startedAt || null,
    finishedAt: row.finishedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
  if (includeGraph) view.graph = row.graphJson || { nodes: [], connections: [] };
  return view;
}

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Snapshot the workflow graph and enqueue a run.
 * @throws httpError(404) if the workflow is not owned by the user
 * @throws httpError(400) if the graph is not strictly valid (runnable)
 */
async function enqueue(userId, workflowId, { vars } = {}) {
  await ensureTable();
  // get() is tenant-scoped — throws 404 if not the user's workflow.
  const wf = await workflowService.get(userId, workflowId);
  const graph = wf.graph || { nodes: [], connections: [] };
  // Runnable graphs must be complete (1 start / >=1 end) — strict mode.
  validateGraph(graph, { strict: true });

  const row = await WorkflowRun.create({
    userId,
    workflowId: wf.id,
    status: 'queued',
    graphJson: graph,
    varsJson: vars && typeof vars === 'object' ? vars : {},
    logJson: [],
  });
  return toRunView(row);
}

async function getRun(userId, runId) {
  await ensureTable();
  const row = await WorkflowRun.findOne({ where: { userId, id: runId } });
  if (!row) throw httpError(404, 'Run not found');
  return toRunView(row);
}

async function listRuns(userId, workflowId) {
  await ensureTable();
  const where = { userId };
  if (workflowId != null) where.workflowId = workflowId;
  const rows = await WorkflowRun.findAll({
    where,
    order: [['id', 'DESC']],
    limit: 100,
  });
  return rows.map((r) => toRunView(r));
}

/**
 * Answer a run parked at an askUserQuestion node. Writes the answer into
 * `resume_json` and flips the row back to `queued`, so the worker re-claims it
 * and resumes from the durable checkpoint (`pending_json`).
 *
 * @throws httpError(404) if the run is not the user's
 * @throws httpError(409) if the run is not awaiting input
 */
async function answer(userId, runId, payload = {}) {
  await ensureTable();
  const row = await WorkflowRun.findOne({ where: { userId, id: runId } });
  if (!row) throw httpError(404, 'Run not found');
  if (row.status !== 'awaiting_input') {
    throw httpError(409, `Run is not awaiting input (status: ${row.status})`);
  }
  const pending = row.pendingJson || {};
  const value = payload.answer;
  // Constrain to a declared option when options were provided.
  if (Array.isArray(pending.options) && pending.options.length
      && !pending.options.includes(value)) {
    throw httpError(400, `answer must be one of: ${pending.options.join(', ')}`);
  }
  await row.update({
    status: 'queued',
    resumeJson: { answer: value == null ? '' : value },
  });
  return toRunView(await WorkflowRun.findByPk(row.id));
}

module.exports = {
  enqueue,
  getRun,
  listRuns,
  answer,
  toRunView,
};
