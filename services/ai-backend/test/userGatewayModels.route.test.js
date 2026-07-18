/**
 * My-model-list CRUD routes (/api/user-gateway/models) — per-user, no admin gate.
 *
 * Covers: add (201) → list → patch capability / rename / toggle active → delete,
 * the 409 on a duplicate add, the 404/409 on an invalid patch, and tenant
 * isolation (user B can never see or mutate user A's models).
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-usergw-models-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-user-gateway-models';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { sequelize, User } = require('@khy/shared/models');
const router = require('../src/routes/userGateway');

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

let app;
let userA;
let userB;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  userA = await User.create({ username: 'mona', email: 'mona@test.local', password: 'pw-mona-123', status: 'active' });
  userB = await User.create({ username: 'nico', email: 'nico@test.local', password: 'pw-nico-123', status: 'active' });
  app = express();
  app.use(express.json());
  app.use('/api/user-gateway', router);
});

afterAll(async () => {
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

const auth = (u) => ['Authorization', `Bearer ${tokenFor(u.id)}`];

describe('user-gateway /models — CRUD', () => {
  let createdId;

  test('unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/user-gateway/models');
    expect(res.status).toBeGreaterThanOrEqual(401);
  });

  test('list is empty initially', async () => {
    const res = await request(app).get('/api/user-gateway/models').set(...auth(userA));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  test('POST adds a model as source:manual (201)', async () => {
    const res = await request(app)
      .post('/api/user-gateway/models')
      .set(...auth(userA))
      .send({ provider: 'deepseek', model: 'deepseek-chat' });
    expect(res.status).toBe(201);
    expect(res.body.data.provider).toBe('deepseek');
    expect(res.body.data.model).toBe('deepseek-chat');
    expect(res.body.data.source).toBe('manual');
    expect(res.body.data.capability).toBe('text'); // auto-classified
    expect(res.body.data.isActive).toBe(true);
    createdId = res.body.data.id;
  });

  test('capability is auto-classified for an image model', async () => {
    const res = await request(app)
      .post('/api/user-gateway/models')
      .set(...auth(userA))
      .send({ provider: 'openai', model: 'dall-e-3' });
    expect(res.status).toBe(201);
    expect(res.body.data.capability).toBe('image');
  });

  test('duplicate add returns 409', async () => {
    const res = await request(app)
      .post('/api/user-gateway/models')
      .set(...auth(userA))
      .send({ provider: 'deepseek', model: 'deepseek-chat' });
    expect(res.status).toBe(409);
  });

  test('an invalid capability is rejected (400)', async () => {
    const res = await request(app)
      .post('/api/user-gateway/models')
      .set(...auth(userA))
      .send({ provider: 'deepseek', model: 'foo', capability: 'telepathy' });
    expect(res.status).toBe(400);
  });

  test('PATCH edits capability + toggles active', async () => {
    const res = await request(app)
      .patch(`/api/user-gateway/models/${createdId}`)
      .set(...auth(userA))
      .send({ capability: 'audio', isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data.capability).toBe('audio');
    expect(res.body.data.isActive).toBe(false);
  });

  test('PATCH rename guards the unique index (409 on collision)', async () => {
    // 'dall-e-3' already exists under openai; renaming a new openai row onto it clashes.
    const add = await request(app)
      .post('/api/user-gateway/models')
      .set(...auth(userA))
      .send({ provider: 'openai', model: 'gpt-4o-mini' });
    const id = add.body.data.id;
    const res = await request(app)
      .patch(`/api/user-gateway/models/${id}`)
      .set(...auth(userA))
      .send({ model: 'dall-e-3' });
    expect(res.status).toBe(409);
  });

  test('PATCH on a non-owned / missing row is 404', async () => {
    const res = await request(app)
      .patch(`/api/user-gateway/models/${createdId}`)
      .set(...auth(userB))
      .send({ capability: 'text' });
    expect(res.status).toBe(404);
  });

  test('list can be scoped by provider', async () => {
    const res = await request(app)
      .get('/api/user-gateway/models?provider=deepseek')
      .set(...auth(userA));
    expect(res.status).toBe(200);
    expect(res.body.data.every((m) => m.provider === 'deepseek')).toBe(true);
  });

  test('DELETE removes the model', async () => {
    const res = await request(app)
      .delete(`/api/user-gateway/models/${createdId}`)
      .set(...auth(userA));
    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(true);
  });
});

describe('user-gateway /models — tenant isolation', () => {
  test("B never sees A's models", async () => {
    const res = await request(app).get('/api/user-gateway/models').set(...auth(userB));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]); // A's rows are invisible to B
  });
});
