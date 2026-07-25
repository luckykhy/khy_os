/**
 * Workflow RUN routes — enqueue (snapshot + strict-validate), run-status read,
 * per-workflow run listing, and tenant isolation.
 *
 * Mirrors workflow.routes.test.js: throwaway on-disk SQLite bound to the shared
 * sequelize singleton BEFORE any @khy/shared model is required, then
 * sync({force}) so workflow_runs exists. Execution itself is NOT exercised here
 * (that is services/backend's worker, unit-tested separately) — this asserts the
 * ai-backend producer half: a queued row is created and read back tenant-scoped.
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-workflow-runs-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-workflow-runs';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { sequelize, User, WorkflowRun } = require('@khy/shared/models');
const router = require('../src/routes/workflow');

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

let app;
let userA;
let userB;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  userA = await User.create({ username: 'run-alice', email: 'run-alice@test.local', password: 'pw-alice-123', status: 'active' });
  userB = await User.create({ username: 'run-bob', email: 'run-bob@test.local', password: 'pw-bob-123', status: 'active' });

  app = express();
  app.use(express.json());
  app.use('/api/workflow', router);
});

afterAll(async () => {
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

const auth = (u) => ['Authorization', `Bearer ${tokenFor(u.id)}`];

const COMPLETE_GRAPH = {
  nodes: [
    { id: 'n_start', type: 'start', name: 'Start', position: { x: 0, y: 0 }, data: {} },
    { id: 'n_prompt', type: 'prompt', name: 'Ask', position: { x: 200, y: 0 }, data: { prompt: 'hi', outputVar: 'r' } },
    { id: 'n_end', type: 'end', name: 'End', position: { x: 400, y: 0 }, data: {} },
  ],
  connections: [
    { id: 'e1', from: 'n_start', fromPort: 'default', to: 'n_prompt', toPort: 'input', condition: null },
    { id: 'e2', from: 'n_prompt', fromPort: 'default', to: 'n_end', toPort: 'input', condition: null },
  ],
};

// A saveable-but-not-runnable graph: a lone prompt, no start/end.
const INCOMPLETE_GRAPH = {
  nodes: [
    { id: 'n_only', type: 'prompt', name: 'Lonely', position: { x: 0, y: 0 }, data: { prompt: 'x' } },
  ],
  connections: [],
};

async function createWorkflow(user, graph) {
  const res = await request(app).post('/api/workflow').set(...auth(user)).send({ name: 'Runnable' });
  const id = res.body.data.id;
  if (graph) {
    await request(app).put(`/api/workflow/${id}`).set(...auth(user)).send({ graph });
  }
  return id;
}

describe('workflow run routes — enqueue', () => {
  test('POST /:id/run enqueues a queued run with snapshot', async () => {
    const id = await createWorkflow(userA, COMPLETE_GRAPH);
    const res = await request(app).post(`/api/workflow/${id}/run`).set(...auth(userA)).send({});
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('queued');
    expect(res.body.data.workflowId).toBe(id);
    expect(Array.isArray(res.body.data.log)).toBe(true);
  });

  test('POST /:id/run accepts initial vars', async () => {
    const id = await createWorkflow(userA, COMPLETE_GRAPH);
    const res = await request(app).post(`/api/workflow/${id}/run`).set(...auth(userA)).send({ vars: { topic: 'AI' } });
    expect(res.status).toBe(201);
    expect(res.body.data.vars).toEqual({ topic: 'AI' });
  });

  test('POST /:id/run rejects an incomplete (non-runnable) graph with 400', async () => {
    const id = await createWorkflow(userA, INCOMPLETE_GRAPH);
    const res = await request(app).post(`/api/workflow/${id}/run`).set(...auth(userA)).send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('POST /:id/run on another user\'s workflow returns 404', async () => {
    const id = await createWorkflow(userA, COMPLETE_GRAPH);
    const res = await request(app).post(`/api/workflow/${id}/run`).set(...auth(userB)).send({});
    expect(res.status).toBe(404);
  });

  test('run requires auth', async () => {
    const id = await createWorkflow(userA, COMPLETE_GRAPH);
    const res = await request(app).post(`/api/workflow/${id}/run`).send({});
    expect(res.status).toBe(401);
  });
});

describe('workflow run routes — read + list', () => {
  test('GET /runs/:runId returns the run for its owner', async () => {
    const id = await createWorkflow(userA, COMPLETE_GRAPH);
    const enq = await request(app).post(`/api/workflow/${id}/run`).set(...auth(userA)).send({});
    const runId = enq.body.data.id;

    const res = await request(app).get(`/api/workflow/runs/${runId}`).set(...auth(userA));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(runId);
    expect(res.body.data.status).toBe('queued');
  });

  test('GET /runs/:runId is tenant-scoped (404 for another user)', async () => {
    const id = await createWorkflow(userA, COMPLETE_GRAPH);
    const enq = await request(app).post(`/api/workflow/${id}/run`).set(...auth(userA)).send({});
    const runId = enq.body.data.id;

    const res = await request(app).get(`/api/workflow/runs/${runId}`).set(...auth(userB));
    expect(res.status).toBe(404);
  });

  test('GET /:id/runs lists this workflow\'s runs newest-first', async () => {
    const id = await createWorkflow(userA, COMPLETE_GRAPH);
    await request(app).post(`/api/workflow/${id}/run`).set(...auth(userA)).send({});
    await request(app).post(`/api/workflow/${id}/run`).set(...auth(userA)).send({});

    const res = await request(app).get(`/api/workflow/${id}/runs`).set(...auth(userA));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.data[0].id).toBeGreaterThan(res.body.data[1].id);
  });
});

describe('workflow run routes — answer (human-in-the-loop resume)', () => {
  // Seed an awaiting_input run directly (the worker would normally park it).
  async function parkRun(owner, pending = { nodeId: 'q', question: 'Pick?', options: ['A', 'B'], answerVar: 'choice', loopState: {} }) {
    const id = await createWorkflow(owner, COMPLETE_GRAPH);
    const row = await WorkflowRun.create({
      userId: owner.id, workflowId: id, status: 'awaiting_input',
      graphJson: COMPLETE_GRAPH, varsJson: {}, logJson: [], pendingJson: pending,
    });
    return row.id;
  }

  test('POST /runs/:runId/answer re-enqueues the run with the answer recorded', async () => {
    const runId = await parkRun(userA);
    const res = await request(app).post(`/api/workflow/runs/${runId}/answer`).set(...auth(userA)).send({ answer: 'B' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('queued');

    const row = await WorkflowRun.findByPk(runId);
    expect(row.status).toBe('queued');
    expect(row.resumeJson).toEqual({ answer: 'B' });
  });

  test('answer for an option not in the list is rejected with 400', async () => {
    const runId = await parkRun(userA);
    const res = await request(app).post(`/api/workflow/runs/${runId}/answer`).set(...auth(userA)).send({ answer: 'Z' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('answering a run that is not awaiting input is rejected with 409', async () => {
    const id = await createWorkflow(userA, COMPLETE_GRAPH);
    const enq = await request(app).post(`/api/workflow/${id}/run`).set(...auth(userA)).send({});
    const runId = enq.body.data.id; // status: queued, not awaiting_input

    const res = await request(app).post(`/api/workflow/runs/${runId}/answer`).set(...auth(userA)).send({ answer: 'A' });
    expect(res.status).toBe(409);
  });

  test('answer is tenant-scoped (404 for another user)', async () => {
    const runId = await parkRun(userA);
    const res = await request(app).post(`/api/workflow/runs/${runId}/answer`).set(...auth(userB)).send({ answer: 'A' });
    expect(res.status).toBe(404);
  });

  test('free-text answer (no options) is accepted', async () => {
    const runId = await parkRun(userA, { nodeId: 'q', question: 'Why?', options: [], answerVar: 'reason', loopState: {} });
    const res = await request(app).post(`/api/workflow/runs/${runId}/answer`).set(...auth(userA)).send({ answer: 'because' });
    expect(res.status).toBe(200);
    const row = await WorkflowRun.findByPk(runId);
    expect(row.resumeJson).toEqual({ answer: 'because' });
  });
});

describe('workflow run routes — SSE events stream', () => {
  // Seed a run in a fixed terminal/parked state so the stream emits one snapshot
  // and closes immediately (no hanging connection to assert against).
  async function seedRun(owner, status, extra = {}) {
    const id = await createWorkflow(owner, COMPLETE_GRAPH);
    const row = await WorkflowRun.create({
      userId: owner.id, workflowId: id, status,
      graphJson: COMPLETE_GRAPH, varsJson: {}, logJson: [{ nodeId: 'a', label: 'start', status: 'succeeded' }],
      ...extra,
    });
    return row.id;
  }

  test('GET /runs/:runId/events streams a snapshot then a done event for a terminal run', async () => {
    const runId = await seedRun(userA, 'succeeded');
    const res = await request(app).get(`/api/workflow/runs/${runId}/events`).set(...auth(userA));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    // Initial snapshot frame carries the run view as JSON.
    expect(res.text).toMatch(/data: \{/);
    const dataLine = res.text.split('\n').find((l) => l.startsWith('data: {'));
    const view = JSON.parse(dataLine.slice('data: '.length));
    expect(view.id).toBe(runId);
    expect(view.status).toBe('succeeded');
    // Terminal run closes the stream with an explicit done event.
    expect(res.text).toMatch(/event: done/);
  });

  test('a parked (awaiting_input) run also emits one snapshot then closes', async () => {
    const runId = await seedRun(userA, 'awaiting_input', {
      pendingJson: { nodeId: 'q', question: 'Pick?', options: ['A'], answerVar: 'c', loopState: {} },
    });
    const res = await request(app).get(`/api/workflow/runs/${runId}/events`).set(...auth(userA));
    expect(res.status).toBe(200);
    const dataLine = res.text.split('\n').find((l) => l.startsWith('data: {'));
    expect(JSON.parse(dataLine.slice('data: '.length)).status).toBe('awaiting_input');
    expect(res.text).toMatch(/event: done/);
  });

  test('events stream is tenant-scoped (404 for another user, no stream)', async () => {
    const runId = await seedRun(userA, 'succeeded');
    const res = await request(app).get(`/api/workflow/runs/${runId}/events`).set(...auth(userB));
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).not.toMatch(/text\/event-stream/);
  });
});
