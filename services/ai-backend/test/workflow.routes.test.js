/**
 * Workflow editor routes — per-user CRUD, graph round-trip, tenant isolation,
 * and the node-type catalog endpoint.
 *
 * Mirrors userGateway.routes.test.js: a throwaway on-disk SQLite DB is bound to
 * the shared sequelize singleton BEFORE any @khy/shared model is required.
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-workflow-routes-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-workflow';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { sequelize, User } = require('@khy/shared/models');
const { getTemplates } = require('@khy/shared/workflow/templates');
const router = require('../src/routes/workflow');
const workflowService = require('../src/services/workflowService');

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

let app;
let userA;
let userB;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  userA = await User.create({ username: 'wf-alice', email: 'wf-alice@test.local', password: 'pw-alice-123', status: 'active' });
  userB = await User.create({ username: 'wf-bob', email: 'wf-bob@test.local', password: 'pw-bob-123', status: 'active' });

  app = express();
  app.use(express.json());
  app.use('/api/workflow', router);
});

afterAll(async () => {
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

const auth = (u) => ['Authorization', `Bearer ${tokenFor(u.id)}`];

const SAMPLE_GRAPH = {
  nodes: [
    { id: 'n_start', type: 'start', name: 'Start', position: { x: 0, y: 0 }, data: { inputs: [] } },
    { id: 'n_prompt', type: 'prompt', name: 'Ask', position: { x: 200, y: 0 }, data: { prompt: 'hi', outputVar: 'r' } },
    { id: 'n_end', type: 'end', name: 'End', position: { x: 400, y: 0 }, data: { outputs: [] } },
  ],
  connections: [
    { id: 'e1', from: 'n_start', fromPort: 'default', to: 'n_prompt', toPort: 'input', condition: null },
    { id: 'e2', from: 'n_prompt', fromPort: 'default', to: 'n_end', toPort: 'input', condition: null },
  ],
};

describe('workflow routes — node-type catalog', () => {
  test('GET /node-types returns the shared catalog (4 categories, 11 nodes)', async () => {
    const res = await request(app).get('/api/workflow/node-types').set(...auth(userA));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.categories.map((c) => c.id).sort()).toEqual(['agent', 'control', 'data', 'human']);
    expect(res.body.data.nodes.length).toBe(11);
  });

  test('node-types requires auth', async () => {
    const res = await request(app).get('/api/workflow/node-types');
    expect(res.status).toBe(401);
  });
});

describe('workflow routes — CRUD + graph round-trip', () => {
  let id;

  test('create returns 201 with an empty graph', async () => {
    const res = await request(app)
      .post('/api/workflow')
      .set(...auth(userA))
      .send({ name: 'My Flow', description: 'demo' });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('My Flow');
    expect(res.body.data.version).toBe(1);
    expect(res.body.data.graph).toEqual({ nodes: [], connections: [] });
    id = res.body.data.id;
  });

  test('invalid name is rejected with 400', async () => {
    const res = await request(app)
      .post('/api/workflow')
      .set(...auth(userA))
      .send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  test('save persists the canvas graph and bumps version', async () => {
    const res = await request(app)
      .put(`/api/workflow/${id}`)
      .set(...auth(userA))
      .send({ graph: SAMPLE_GRAPH });
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.graph.nodes.length).toBe(3);
  });

  test('reload round-trips the exact graph', async () => {
    const res = await request(app).get(`/api/workflow/${id}`).set(...auth(userA));
    expect(res.status).toBe(200);
    expect(res.body.data.graph).toEqual(SAMPLE_GRAPH);
  });

  test('list shows the workflow as a summary (no graph payload)', async () => {
    const res = await request(app).get('/api/workflow').set(...auth(userA));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0]).not.toHaveProperty('graph');
  });

  test('delete removes it', async () => {
    const del = await request(app).delete(`/api/workflow/${id}`).set(...auth(userA));
    expect(del.status).toBe(200);
    const after = await request(app).get(`/api/workflow/${id}`).set(...auth(userA));
    expect(after.status).toBe(404);
  });
});

describe('workflow routes — graph validation', () => {
  let id;

  beforeAll(async () => {
    const res = await request(app).post('/api/workflow').set(...auth(userA)).send({ name: 'Validate Me' });
    id = res.body.data.id;
  });

  test('rejects a connection to an unknown node (400)', async () => {
    const bad = {
      nodes: [{ id: 'n1', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} }],
      connections: [{ id: 'e1', from: 'n1', fromPort: 'default', to: 'ghost', toPort: 'input' }],
    };
    const res = await request(app).put(`/api/workflow/${id}`).set(...auth(userA)).send({ graph: bad });
    expect(res.status).toBe(400);
  });

  test('rejects an invalid source port (400)', async () => {
    const bad = {
      nodes: [
        { id: 'n1', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
        { id: 'n2', type: 'end', name: 'E', position: { x: 100, y: 0 }, data: {} },
      ],
      connections: [{ id: 'e1', from: 'n1', fromPort: 'branch-true', to: 'n2', toPort: 'input' }],
    };
    const res = await request(app).put(`/api/workflow/${id}`).set(...auth(userA)).send({ graph: bad });
    expect(res.status).toBe(400);
  });

  test('rejects duplicate node ids (400)', async () => {
    const bad = {
      nodes: [
        { id: 'dup', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
        { id: 'dup', type: 'end', name: 'E', position: { x: 100, y: 0 }, data: {} },
      ],
      connections: [],
    };
    const res = await request(app).put(`/api/workflow/${id}`).set(...auth(userA)).send({ graph: bad });
    expect(res.status).toBe(400);
  });

  test('rejects an unknown node type (400)', async () => {
    const bad = {
      nodes: [{ id: 'n1', type: 'bogus', name: 'X', position: { x: 0, y: 0 }, data: {} }],
      connections: [],
    };
    const res = await request(app).put(`/api/workflow/${id}`).set(...auth(userA)).send({ graph: bad });
    expect(res.status).toBe(400);
  });

  test('accepts a partial work-in-progress graph (no start/end required to save)', async () => {
    const partial = {
      nodes: [{ id: 'n1', type: 'prompt', name: 'P', position: { x: 0, y: 0 }, data: { prompt: 'hi' } }],
      connections: [],
    };
    const res = await request(app).put(`/api/workflow/${id}`).set(...auth(userA)).send({ graph: partial });
    expect(res.status).toBe(200);
  });
});

describe('validateGraph — strict completeness (export gate)', () => {
  const { validateGraph } = workflowService;

  test('a complete start->prompt->end graph passes strict', () => {
    expect(() => validateGraph(SAMPLE_GRAPH, { strict: true })).not.toThrow();
  });

  test('strict requires exactly one start', () => {
    const noStart = { nodes: [{ id: 'e', type: 'end', name: 'E', position: { x: 0, y: 0 }, data: {} }], connections: [] };
    expect(() => validateGraph(noStart, { strict: true })).toThrow(/start/);
  });

  test('strict requires at least one end', () => {
    const noEnd = { nodes: [{ id: 's', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} }], connections: [] };
    expect(() => validateGraph(noEnd, { strict: true })).toThrow(/end/);
  });

  test('strict rejects an inbound edge into start', () => {
    const g = {
      nodes: [
        { id: 's', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
        { id: 'e', type: 'end', name: 'E', position: { x: 100, y: 0 }, data: {} },
      ],
      connections: [{ id: 'x', from: 'e', fromPort: 'default', to: 's', toPort: 'input' }],
    };
    // 'end' has no outputs, so this also fails the port check — either way it must throw.
    expect(() => validateGraph(g, { strict: true })).toThrow();
  });
});

describe('workflow routes — tenant isolation', () => {
  let aId;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/workflow')
      .set(...auth(userA))
      .send({ name: 'Alice Only' });
    aId = res.body.data.id;
  });

  test('user B cannot read user A workflow', async () => {
    const res = await request(app).get(`/api/workflow/${aId}`).set(...auth(userB));
    expect(res.status).toBe(404);
  });

  test('user B cannot save into user A workflow', async () => {
    const res = await request(app)
      .put(`/api/workflow/${aId}`)
      .set(...auth(userB))
      .send({ graph: SAMPLE_GRAPH });
    expect(res.status).toBe(404);
  });

  test("user B's list does not include user A workflow", async () => {
    const res = await request(app).get('/api/workflow').set(...auth(userB));
    expect(res.status).toBe(200);
    expect(res.body.data.find((w) => w.id === aId)).toBeUndefined();
  });
});

describe('workflow routes — optimistic lock (expectedVersion)', () => {
  let id;

  beforeAll(async () => {
    const res = await request(app).post('/api/workflow').set(...auth(userA)).send({ name: 'Locked Flow' });
    id = res.body.data.id; // version 1
  });

  test('matching expectedVersion succeeds and bumps version', async () => {
    const res = await request(app)
      .put(`/api/workflow/${id}`)
      .set(...auth(userA))
      .send({ graph: SAMPLE_GRAPH, expectedVersion: 1 });
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
  });

  test('stale expectedVersion is rejected with 409', async () => {
    const res = await request(app)
      .put(`/api/workflow/${id}`)
      .set(...auth(userA))
      .send({ graph: SAMPLE_GRAPH, expectedVersion: 1 }); // row is now at 2
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/conflict/i);
  });

  test('non-integer expectedVersion is rejected with 400', async () => {
    const res = await request(app)
      .put(`/api/workflow/${id}`)
      .set(...auth(userA))
      .send({ graph: SAMPLE_GRAPH, expectedVersion: 'two' });
    expect(res.status).toBe(400);
  });

  test('omitting expectedVersion preserves last-write-wins', async () => {
    const res = await request(app)
      .put(`/api/workflow/${id}`)
      .set(...auth(userA))
      .send({ graph: SAMPLE_GRAPH }); // no expectedVersion → always allowed
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(3);
  });
});

describe('workflow routes — built-in templates', () => {
  test('every built-in template passes strict completeness validation', () => {
    const { validateGraph } = workflowService;
    const templates = getTemplates();
    expect(templates.length).toBeGreaterThan(0);
    for (const tpl of templates) {
      expect(() => validateGraph(tpl.graph, { strict: true })).not.toThrow();
    }
  });

  test('GET /templates lists summaries (id/name/description/nodeCount, no graph)', async () => {
    const res = await request(app).get('/api/workflow/templates').set(...auth(userA));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    const t = res.body.data[0];
    expect(t).toHaveProperty('id');
    expect(t).toHaveProperty('name');
    expect(t).toHaveProperty('description');
    expect(typeof t.nodeCount).toBe('number');
    expect(t).not.toHaveProperty('graph');
  });

  test('GET /templates requires auth', async () => {
    const res = await request(app).get('/api/workflow/templates');
    expect(res.status).toBe(401);
  });

  test('POST /templates/:id instantiates a new workflow at version 1 with the template graph', async () => {
    const [tpl] = getTemplates();
    const res = await request(app).post(`/api/workflow/templates/${tpl.id}`).set(...auth(userA)).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.version).toBe(1);
    expect(res.body.data.name).toBe(tpl.name);
    expect(res.body.data.graph.nodes.length).toBe(tpl.graph.nodes.length);

    // The instantiated copy round-trips and is owned by the creator.
    const reload = await request(app).get(`/api/workflow/${res.body.data.id}`).set(...auth(userA));
    expect(reload.status).toBe(200);
    expect(reload.body.data.graph.nodes.length).toBe(tpl.graph.nodes.length);
  });

  test('POST /templates/:id honors a name override', async () => {
    const [tpl] = getTemplates();
    const res = await request(app)
      .post(`/api/workflow/templates/${tpl.id}`)
      .set(...auth(userA))
      .send({ name: 'My Copy' });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('My Copy');
  });

  test('POST /templates/:id with an unknown id returns 404', async () => {
    const res = await request(app).post('/api/workflow/templates/does-not-exist').set(...auth(userA)).send({});
    expect(res.status).toBe(404);
  });
});
