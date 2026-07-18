/**
 * Coze import — end-to-end capability proof.
 *
 * Demonstrates that Khy can IMPORT and ACTUALLY RUN a coze-studio exported
 * workflow. Uses real fixtures decoded from the public "cozeworkflows-200+"
 * collection:
 *   - sample-table.json / .container — a 15-node workflow (start, end, selector,
 *     7 plugins, 2 comments, 2 text, 1 code) in both parsed-JSON and raw binary
 *     container form, exercising the byte-scan extractor.
 *   - sample-linear.zip — a real deflate Workflow-*.zip (start→code→3 plugins→end),
 *     used to prove the unzip path AND that the converted graph runs to completion
 *     on the native executor.
 *
 * Mirrors workflow.routes.test.js: a throwaway on-disk SQLite DB is bound to the
 * shared sequelize singleton BEFORE any @khy/shared model is required.
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-coze-import-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-coze';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { sequelize, User } = require('@khy/shared/models');
const { convertCozeWorkflow, extractCozeDoc } = require('@khy/shared/workflow/cozeImport');
const router = require('../src/routes/workflow');
const workflowService = require('../src/services/workflowService');
// The native executor lives in the trading backend; import it to prove the
// converted graph is genuinely runnable (not just structurally valid).
const { runGraph } = require(path.resolve(__dirname, '../../backend/src/services/workflow/workflowExecutor'));

const FX = path.join(__dirname, 'fixtures', 'coze');
const tableJson = fs.readFileSync(path.join(FX, 'sample-table.json'));
const tableContainer = fs.readFileSync(path.join(FX, 'sample-table.container'));
const linearZip = fs.readFileSync(path.join(FX, 'sample-linear.zip'));

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

// Fully-mocked primitives so the executor exercises control flow without booting
// the agent engine or hitting any external (Coze or Khy) service.
function mockPrimitives() {
  const stub = (kind) => async () => `stub:${kind}`;
  return {
    chat: stub('chat'),
    executeTool: stub('tool'),
    executeSkill: stub('skill'),
    runSubAgent: stub('agent'),
    runCode: stub('code'),
    http: stub('http'),
  };
}

let app;
let userA;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  userA = await User.create({ username: 'coze-alice', email: 'coze-alice@test.local', password: 'pw-alice-123', status: 'active' });
  app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/workflow', router);
});

afterAll(async () => {
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

const auth = (u) => ['Authorization', `Bearer ${tokenFor(u.id)}`];

describe('coze import — pure converter (@khy/shared)', () => {
  test('converts a 15-node Coze workflow into a strictly-valid Khy graph', () => {
    const { graph, report } = convertCozeWorkflow(tableJson);
    expect(() => workflowService.validateGraph(graph, { strict: true })).not.toThrow();
    expect(report.source).toBe('coze');
    // 15 Coze nodes − 2 comments = 13 Khy nodes.
    expect(report.droppedComments).toBe(2);
    expect(report.nodeCount).toBe(13);
    expect(report.typeCounts.start).toBe(1);
    expect(report.typeCounts.end).toBe(1);
    expect(report.typeCounts.ifElse).toBe(1);
    expect(report.typeCounts.toolCall).toBe(7);
  });

  test('selector (type 8) becomes an ifElse with a comparator expression', () => {
    const { graph } = convertCozeWorkflow(tableJson);
    const ifElse = graph.nodes.find((n) => n.type === 'ifElse');
    expect(ifElse).toBeTruthy();
    expect(ifElse.data.expression).toMatch(/==|!=|>=|<=|>|</);
  });

  test('comment nodes are dropped and no edge dangles to a removed node', () => {
    const { graph } = convertCozeWorkflow(tableJson);
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const c of graph.connections) {
      expect(ids.has(c.from)).toBe(true);
      expect(ids.has(c.to)).toBe(true);
    }
  });

  test('byte-scan extractor recovers the JSON from the raw binary container', () => {
    const doc = extractCozeDoc(tableContainer);
    expect(Array.isArray(doc.nodes)).toBe(true);
    const fromContainer = convertCozeWorkflow(tableContainer);
    const fromJson = convertCozeWorkflow(tableJson);
    expect(fromContainer.report.nodeCount).toBe(fromJson.report.nodeCount);
    expect(fromContainer.report.typeCounts).toEqual(fromJson.report.typeCounts);
  });

  test('rejects content with no Coze workflow JSON', () => {
    expect(() => convertCozeWorkflow(Buffer.from('not a coze export'))).toThrow();
  });
});

describe('coze import — converted graph runs on the native executor', () => {
  test('a linear Coze workflow (from a real .zip) runs to an end node', async () => {
    // The zip path is exercised through the route below; here convert the already
    // unzipped container to keep this unit focused on executor runnability.
    const StreamZip = require('node-stream-zip');
    const tmp = path.join(os.tmpdir(), `khy-coze-test-${process.pid}.zip`);
    fs.writeFileSync(tmp, linearZip);
    const zip = new StreamZip.async({ file: tmp });
    const entryName = Object.keys(await zip.entries())[0];
    const buf = await zip.entryData(entryName);
    await zip.close();
    fs.unlinkSync(tmp);

    const { graph } = convertCozeWorkflow(buf);
    expect(() => workflowService.validateGraph(graph, { strict: true })).not.toThrow();

    const res = await runGraph(graph, { primitives: mockPrimitives() });
    expect(res.status).toBe('completed');
    const last = res.log[res.log.length - 1];
    expect(last.type).toBe('end');
  });
});

describe('coze import — POST /api/workflow/import/coze', () => {
  test('imports from raw JSON content and persists a version-1 workflow', async () => {
    const res = await request(app)
      .post('/api/workflow/import/coze')
      .set(...auth(userA))
      .send({ content: tableJson.toString('utf8'), name: 'Imported Table' });
    expect(res.status).toBe(201);
    expect(res.body.data.version).toBe(1);
    expect(res.body.data.name).toBe('Imported Table');
    expect(res.body.data.graph.nodes.length).toBe(13);
    expect(res.body.data.report.source).toBe('coze');

    // Round-trips on reload.
    const reload = await request(app).get(`/api/workflow/${res.body.data.id}`).set(...auth(userA));
    expect(reload.status).toBe(200);
    expect(reload.body.data.graph.nodes.length).toBe(13);
  });

  test('imports from a real Workflow-*.zip (base64) and the result runs to completion', async () => {
    const res = await request(app)
      .post('/api/workflow/import/coze')
      .set(...auth(userA))
      .send({ contentBase64: linearZip.toString('base64'), name: 'Imported Linear' });
    expect(res.status).toBe(201);
    expect(res.body.data.graph.nodes.length).toBe(6);

    const out = await runGraph(res.body.data.graph, { primitives: mockPrimitives() });
    expect(out.status).toBe('completed');
  });

  test('requires authentication', async () => {
    const res = await request(app).post('/api/workflow/import/coze').send({ content: '{}' });
    expect(res.status).toBe(401);
  });

  test('rejects unparseable content with 400', async () => {
    const res = await request(app)
      .post('/api/workflow/import/coze')
      .set(...auth(userA))
      .send({ content: 'definitely not coze' });
    expect(res.status).toBe(400);
  });
});
