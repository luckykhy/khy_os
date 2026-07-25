'use strict';

/**
 * workflowRunWorker.quantum.test.js — Phase C-3 (§4.C), worker/DB side.
 *
 * The pure interpreter test (workflowExecutor.quantum.test.js) proves the yield
 * math. This proves the CROSS-PROCESS half: a quantum yield is persisted to the
 * `workflow_runs` row and a fresh worker invocation (a separate "process") picks
 * the run back up and continues from the durable checkpoint, eventually reaching
 * the SAME terminal state as an uninterrupted run — plus the ready-queue fairness
 * that makes preemption worthwhile (a yielded run yields its turn).
 *
 * Boots a throwaway SQLite DB bound to the shared sequelize singleton BEFORE
 * @khy/shared/models is required, exactly like workflowRunWorker.test.js.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-workflow-quantum-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.KHY_WORKFLOW_WORKER = '0'; // never auto-start the interval in tests

const { sequelize, User, UserWorkflow, WorkflowRun } = require('@khy/shared/models');
const worker = require('../src/services/workflow/workflowRunWorker');
const executor = require('../src/services/workflow/workflowExecutor');

let userId;
let workflowId;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  const u = await User.create({ username: 'q-alice', email: 'q-alice@test.local', password: 'pw-123', status: 'active' });
  userId = u.id;
  const wf = await UserWorkflow.create({ userId, name: 'Sliceable', version: 1, graphJson: { nodes: [], connections: [] } });
  workflowId = wf.id;
  jest.spyOn(executor, 'defaultPrimitives').mockReturnValue({
    async chat(prompt) { return `echo:${prompt}`; },
    async executeTool() { return 'tool-ok'; },
    async executeSkill() { return 'skill-ok'; },
    async runSubAgent() { return 'agent-ok'; },
    async runCode() { return 'code-ok'; },
    async http() { return { status: 200, data: 'ok' }; },
  });
});

afterEach(() => { delete process.env.KHY_WORKFLOW_QUANTUM_STEPS; });

afterAll(async () => {
  jest.restoreAllMocks();
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

function n(id, type, data = {}) {
  return { id, type, name: type, position: { x: 0, y: 0 }, data };
}
function e(id, from, to, fromPort = 'default') {
  return { id, from, to, fromPort, toPort: 'input' };
}

// start -> p1 -> ... -> p6 -> end  (8 nodes total).
function linearGraph(k) {
  const nodes = [n('s', 'start')];
  const conns = [];
  let prev = 's';
  for (let i = 1; i <= k; i++) {
    const id = `p${i}`;
    nodes.push(n(id, 'prompt', { prompt: `step ${i} {{ seed }}`, outputVar: `r${i}` }));
    conns.push(e(`c${i}`, prev, id));
    prev = id;
  }
  nodes.push(n('e', 'end'));
  conns.push(e('cend', prev, 'e'));
  return { nodes, connections: conns };
}

async function enqueue(graph, vars = {}) {
  const row = await WorkflowRun.create({
    userId, workflowId, status: 'queued', graphJson: graph, varsJson: vars, logJson: [],
  });
  return row.id;
}

describe('quantum preemption — cross-process resume', () => {
  test('a long run yields, persists a quantum checkpoint, and resumes to the same result', async () => {
    process.env.KHY_WORKFLOW_QUANTUM_STEPS = '2';
    const graph = linearGraph(6); // executed order: s, p1..p6, e
    const runId = await enqueue(graph, { seed: 'X' });

    // First tick: claim + run exactly 2 nodes (s, p1), yield, re-queue.
    await worker.tick();
    let row = await WorkflowRun.findByPk(runId);
    expect(row.status).toBe('queued'); // re-enqueued, NOT awaiting_input
    expect(row.pendingJson).toMatchObject({ kind: 'quantum', nodeId: 'p2' });
    expect(row.resumeJson).toBeNull();
    expect(row.finishedAt).toBeNull();
    // Partial log carried the two executed nodes (no awaiting_input placeholder).
    expect(row.logJson.map((l) => l.nodeId)).toEqual(['s', 'p1']);
    expect(row.logJson.some((l) => l.status === 'awaiting_input')).toBe(false);

    // Keep ticking — each tick is a fresh "process invocation" resuming the
    // durable checkpoint — until the run terminates. Bound to avoid a hang.
    let ticks = 1;
    for (; ticks < 50 && row.status !== 'succeeded'; ticks++) {
      // eslint-disable-next-line no-await-in-loop
      await worker.tick();
      // eslint-disable-next-line no-await-in-loop
      row = await WorkflowRun.findByPk(runId);
    }

    expect(row.status).toBe('succeeded');
    expect(row.pendingJson).toBeNull();
    expect(row.finishedAt).toBeTruthy();
    // Same outputs as an uninterrupted run, in the same node order, once each.
    expect(row.varsJson.r1).toBe('echo:step 1 X');
    expect(row.varsJson.r6).toBe('echo:step 6 X');
    expect(row.logJson.map((l) => l.nodeId)).toEqual(['s', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'e']);
    // 8 nodes at 2 per slice ⇒ it really did preempt several times.
    expect(ticks).toBeGreaterThanOrEqual(4);
  });

  test('matches the uninterrupted result exactly (transparency at the DB layer)', async () => {
    // Uninterrupted reference (quantum off).
    delete process.env.KHY_WORKFLOW_QUANTUM_STEPS;
    const graph = linearGraph(6);
    const refId = await enqueue(graph, { seed: 'Y' });
    await worker.tick();
    const ref = await WorkflowRun.findByPk(refId);
    expect(ref.status).toBe('succeeded');

    // Sliced run.
    process.env.KHY_WORKFLOW_QUANTUM_STEPS = '3';
    const slicedId = await enqueue(graph, { seed: 'Y' });
    let row;
    for (let i = 0; i < 50; i++) {
      // eslint-disable-next-line no-await-in-loop
      await worker.tick();
      // eslint-disable-next-line no-await-in-loop
      row = await WorkflowRun.findByPk(slicedId);
      if (row.status === 'succeeded') break;
    }
    expect(row.status).toBe('succeeded');
    expect(row.varsJson).toEqual(ref.varsJson);
    expect(row.logJson.map((l) => l.nodeId)).toEqual(ref.logJson.map((l) => l.nodeId));
  });
});

describe('ready-queue fairness — a yielded run yields its turn', () => {
  test('with quantum on, claim order follows updatedAt so a re-queued run goes to the back', async () => {
    await WorkflowRun.destroy({ where: {} }); // isolate from prior tests' rows
    process.env.KHY_WORKFLOW_QUANTUM_STEPS = '2';
    // A enqueued first (lower id), B second. Timestamps are written by Sequelize
    // (consistent format) so SQL ORDER BY updated_at is well-defined — never
    // hand-format dates here, or a lexical mismatch breaks the ordering.
    const aId = await enqueue(linearGraph(6), { seed: 'A' });
    const bId = await enqueue(linearGraph(1), { seed: 'B' });

    // Oldest updatedAt (A, enqueued first) is claimed first.
    const first = await worker.claimNext(WorkflowRun);
    expect(first.id).toBe(aId);
    // Simulate A yielding: re-queue via Sequelize (updatedAt bumped to now = newest).
    await first.update({ status: 'queued' });

    // Now the next claim must pick B — A yielded its turn despite the lower id.
    const second = await worker.claimNext(WorkflowRun);
    expect(second.id).toBe(bId);
  });

  test('with quantum off, claim order is strict FIFO-by-id (no behavior change)', async () => {
    await WorkflowRun.destroy({ where: {} }); // isolate from prior tests' rows
    delete process.env.KHY_WORKFLOW_QUANTUM_STEPS;
    // Insert two queued runs; give the LOWER id the NEWER updatedAt. FIFO-by-id
    // must still pick the lower id, proving the default ordering is unchanged.
    const loId = await enqueue(linearGraph(1), { seed: 'lo' });
    const hiId = await enqueue(linearGraph(1), { seed: 'hi' });
    const newer = new Date().toISOString();
    const older = new Date(Date.now() - 90000).toISOString();
    await sequelize.query('UPDATE workflow_runs SET updated_at = :ts WHERE id = :id', { replacements: { ts: newer, id: loId } });
    await sequelize.query('UPDATE workflow_runs SET updated_at = :ts WHERE id = :id', { replacements: { ts: older, id: hiId } });

    const claimed = await worker.claimNext(WorkflowRun);
    expect(claimed.id).toBe(loId); // lowest id wins regardless of updatedAt
  });
});
