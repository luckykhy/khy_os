/**
 * Workflow run WORKER — atomic claim + native execution + status write-back.
 *
 * Boots a throwaway SQLite DB bound to the shared sequelize singleton BEFORE
 * @khy/shared/models is required (so the worker resolves the same instances),
 * inserts queued runs directly, and drives the worker's tick()/claimNext()
 * against MOCKED primitives (no LLM / tools). Verifies:
 *   - a queued run is claimed and executed to `succeeded`, vars/log written back;
 *   - a graph whose node throws lands `failed` with an error message;
 *   - claimNext() is atomic — a second claim returns null (no double-execute).
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-workflow-worker-${process.pid}.db`);
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
  const u = await User.create({ username: 'wk-alice', email: 'wk-alice@test.local', password: 'pw-123', status: 'active' });
  userId = u.id;
  const wf = await UserWorkflow.create({ userId, name: 'Runnable', version: 1, graphJson: { nodes: [], connections: [] } });
  workflowId = wf.id;
  // Force the interpreter to use mock primitives instead of the real backend infra.
  jest.spyOn(executor, 'defaultPrimitives').mockReturnValue({
    async chat(prompt) { return `echo:${prompt}`; },
    async executeTool() { return 'tool-ok'; },
    async executeSkill() { return 'skill-ok'; },
    async runSubAgent() { return 'agent-ok'; },
    async runCode() { return 'code-ok'; },
    async http() { return { status: 200, data: 'ok' }; },
  });
});

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

const OK_GRAPH = {
  nodes: [n('s', 'start'), n('p', 'prompt', { prompt: 'hi {{ topic }}', outputVar: 'r' }), n('e', 'end')],
  connections: [e('c1', 's', 'p'), e('c2', 'p', 'e')],
};

async function enqueue(graph, vars = {}) {
  const row = await WorkflowRun.create({
    userId, workflowId, status: 'queued', graphJson: graph, varsJson: vars, logJson: [],
  });
  return row.id;
}

describe('workflowRunWorker', () => {
  test('tick() claims a queued run and executes it to succeeded', async () => {
    const runId = await enqueue(OK_GRAPH, { topic: 'AI' });
    await worker.tick();

    const row = await WorkflowRun.findByPk(runId);
    expect(row.status).toBe('succeeded');
    expect(row.varsJson.r).toBe('echo:hi AI');
    expect(row.error).toBeNull();
    expect(row.finishedAt).toBeTruthy();
    expect(row.logJson.map((l) => l.type)).toEqual(['start', 'prompt', 'end']);
  });

  test('a failing node marks the run failed with an error', async () => {
    executor.defaultPrimitives.mockReturnValueOnce({
      async chat() { throw new Error('LLM exploded'); },
    });
    const runId = await enqueue(OK_GRAPH);
    await worker.tick();

    const row = await WorkflowRun.findByPk(runId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/LLM exploded/);
    expect(row.finishedAt).toBeTruthy();
  });

  test('claimNext is atomic — second claim of the same queued set returns the next or null', async () => {
    // Single queued run: first claim wins, second finds nothing queued.
    const runId = await enqueue(OK_GRAPH);
    const first = await worker.claimNext(WorkflowRun);
    expect(first).not.toBeNull();
    expect(first.id).toBe(runId);
    expect(first.status).toBe('running');

    const second = await worker.claimNext(WorkflowRun);
    expect(second).toBeNull();
  });

  test('askUserQuestion run parks at awaiting_input, then resumes to succeeded on re-tick', async () => {
    // start -> ask -> prompt(uses answer) -> end
    const ASK_GRAPH = {
      nodes: [
        n('s', 'start'),
        n('q', 'askUserQuestion', { question: 'Pick?', options: ['A', 'B'], answerVar: 'choice' }),
        n('p', 'prompt', { prompt: 'picked {{ choice }}', outputVar: 'echoed' }),
        n('e', 'end'),
      ],
      connections: [e('c0', 's', 'q'), e('c1', 'q', 'p'), e('c2', 'p', 'e')],
    };
    const runId = await enqueue(ASK_GRAPH);

    // First tick: claims, executes up to the ask, parks the run.
    await worker.tick();
    let row = await WorkflowRun.findByPk(runId);
    expect(row.status).toBe('awaiting_input');
    expect(row.pendingJson).toMatchObject({ nodeId: 'q', question: 'Pick?', options: ['A', 'B'], answerVar: 'choice' });
    expect(row.finishedAt).toBeNull();
    // Log ends with the parked ask placeholder.
    expect(row.logJson[row.logJson.length - 1]).toMatchObject({ nodeId: 'q', status: 'awaiting_input' });

    // ai-backend's answer() does this: write the answer + re-enqueue (status -> queued).
    await row.update({ status: 'queued', resumeJson: { answer: 'B' } });

    // Second tick: re-claims, resumes from the checkpoint, injects 'B', finishes.
    await worker.tick();
    row = await WorkflowRun.findByPk(runId);
    expect(row.status).toBe('succeeded');
    expect(row.varsJson.choice).toBe('B');
    expect(row.varsJson.echoed).toBe('echo:picked B');
    expect(row.pendingJson).toBeNull();
    expect(row.resumeJson).toBeNull();
    expect(row.finishedAt).toBeTruthy();
    // The resumed ask node is now logged as succeeded (no leftover awaiting_input).
    const askEntries = row.logJson.filter((l) => l.nodeId === 'q');
    expect(askEntries[askEntries.length - 1].status).toBe('succeeded');
    expect(row.logJson.filter((l) => l.status === 'awaiting_input')).toHaveLength(0);
    expect(row.logJson.map((l) => l.type)).toEqual(['start', 'askUserQuestion', 'prompt', 'end']);
  });

  test('recoverStale re-queues orphaned running runs but spares fresh ones', async () => {
    // Orphan: status running, updatedAt far in the past (process died mid-run).
    const orphanId = await enqueue(OK_GRAPH);
    const past = new Date(Date.now() - 600000);
    const orphan0 = await WorkflowRun.findByPk(orphanId);
    await orphan0.update({ status: 'running', startedAt: past });
    // Backdate the heartbeat directly — the ORM always bumps updated_at to now.
    await sequelize.query('UPDATE workflow_runs SET updated_at = :ts WHERE id = :id', {
      replacements: { ts: past.toISOString(), id: orphanId },
    });
    // Live: status running with a fresh heartbeat (a concurrent worker owns it).
    const liveId = await enqueue(OK_GRAPH);
    await WorkflowRun.update(
      { status: 'running', startedAt: new Date() },
      { where: { id: liveId } },
    );

    const recovered = await worker.recoverStale(WorkflowRun);
    expect(recovered).toBe(1);

    const orphan = await WorkflowRun.findByPk(orphanId);
    expect(orphan.status).toBe('queued');
    expect(orphan.startedAt).toBeNull();
    expect(orphan.logJson[orphan.logJson.length - 1]).toMatchObject({ type: 'system', status: 'recovered' });

    const live = await WorkflowRun.findByPk(liveId);
    expect(live.status).toBe('running'); // untouched — heartbeat was fresh
  });
});
