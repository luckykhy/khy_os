/**
 * Stage 2 gate: per-user gateway routes are reachable by any authenticated
 * user (NO admin gate) and are strictly isolated by req.user.id.
 *
 * The core assertion is tenant isolation: user A cannot read or write user B's
 * relay config / providers / CC tokens, and vice versa.
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

// Use a throwaway on-disk SQLite DB BEFORE any @khy/shared model is required,
// so the shared sequelize singleton binds to it.
const TMP_DB = path.join(os.tmpdir(), `khy-usergw-routes-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-user-gateway';
process.env.NODE_ENV = 'test';

// Saving a relay/provider now best-effort auto-detects models; mock the upstream
// probe so these isolation tests stay offline + fast (detection is covered in
// userModelDetectionService.test.js).
jest.mock('../../backend/src/services/gateway/upstreamModelProbe', () => ({
  fetchUpstreamModels: jest.fn(async () => null),
}));

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

  userA = await User.create({ username: 'alice', email: 'alice@test.local', password: 'pw-alice-123', status: 'active' });
  userB = await User.create({ username: 'bob', email: 'bob@test.local', password: 'pw-bob-123', status: 'active' });

  app = express();
  app.use(express.json());
  app.use('/api/user-gateway', router);
});

afterAll(async () => {
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

const auth = (u) => ['Authorization', `Bearer ${tokenFor(u.id)}`];

describe('user-gateway routes — reachability (no admin gate)', () => {
  test('a normal user reaches GET /model-config and sees source:none initially', async () => {
    const res = await request(app).get('/api/user-gateway/model-config').set(...auth(userA));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.source).toBe('none');
  });

  test('unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/user-gateway/model-config');
    expect(res.status).toBeGreaterThanOrEqual(401);
  });
});

describe('user-gateway routes — relay isolation', () => {
  test('A saves relay config; A reads it back as source:user', async () => {
    const save = await request(app)
      .put('/api/user-gateway/model-config')
      .set(...auth(userA))
      .send({ baseUrl: 'https://a.example.com', modelId: 'a-model', compatibility: 'openai', apiKey: 'sk-aaa-secret' });
    expect(save.status).toBe(200);
    expect(save.body.data.source).toBe('user');
    expect(save.body.data.baseUrl).toBe('https://a.example.com');
    expect(save.body.data.hasApiKey).toBe(true);

    const read = await request(app).get('/api/user-gateway/model-config').set(...auth(userA));
    expect(read.body.data.baseUrl).toBe('https://a.example.com');
  });

  test("B never sees A's relay config (read isolation)", async () => {
    const read = await request(app).get('/api/user-gateway/model-config').set(...auth(userB));
    expect(read.status).toBe(200);
    expect(read.body.data.source).toBe('none');
    expect(read.body.data.baseUrl).toBe('');
  });

  test("B's save does not affect A (write isolation)", async () => {
    await request(app)
      .put('/api/user-gateway/model-config')
      .set(...auth(userB))
      .send({ baseUrl: 'https://b.example.com', modelId: 'b-model' });

    const aRead = await request(app).get('/api/user-gateway/model-config').set(...auth(userA));
    expect(aRead.body.data.baseUrl).toBe('https://a.example.com'); // unchanged
  });
});

describe('user-gateway routes — provider + CC token isolation', () => {
  test('A adds a provider; B does not see it; dup is 409', async () => {
    const add = await request(app)
      .post('/api/user-gateway/custom-providers')
      .set(...auth(userA))
      .send({ provider: 'acme', key: 'pk-acme-1', displayName: 'Acme' });
    expect(add.status).toBe(201);

    const dup = await request(app)
      .post('/api/user-gateway/custom-providers')
      .set(...auth(userA))
      .send({ provider: 'acme', key: 'pk-acme-1' });
    expect(dup.status).toBe(409);

    const bList = await request(app).get('/api/user-gateway/custom-providers').set(...auth(userB));
    expect(bList.body.data).toHaveLength(0);

    const aList = await request(app).get('/api/user-gateway/custom-providers').set(...auth(userA));
    expect(aList.body.data).toHaveLength(1);
    expect(aList.body.data[0].keyMasked).not.toContain('pk-acme-1'); // masked, never plaintext
  });

  test('PUT /custom-providers/:id replaces the key in place; 404 on unknown id', async () => {
    const add = await request(app)
      .post('/api/user-gateway/custom-providers')
      .set(...auth(userA))
      .send({ provider: 'beta', key: 'pk-beta-old', displayName: 'Beta' });
    expect(add.status).toBe(201);
    const id = add.body.data.id;

    const put = await request(app)
      .put(`/api/user-gateway/custom-providers/${id}`)
      .set(...auth(userA))
      .send({ key: 'pk-beta-new' });
    expect(put.status).toBe(200);
    expect(put.body.data.id).toBe(id);
    expect(put.body.data.provider).toBe('beta');
    expect(put.body.data.keyMasked).not.toContain('pk-beta-new'); // still masked

    // Still a single entry for this provider (replaced, not appended).
    const list = await request(app).get('/api/user-gateway/custom-providers').set(...auth(userA));
    const betaEntries = list.body.data.filter((e) => e.provider === 'beta');
    expect(betaEntries).toHaveLength(1);

    const missing = await request(app)
      .put('/api/user-gateway/custom-providers/999999')
      .set(...auth(userA))
      .send({ key: 'pk-x' });
    expect(missing.status).toBe(404);
  });

  test('A issues a CC token (plaintext once); B cannot list it', async () => {
    const issue = await request(app).post('/api/user-gateway/cc/tokens').set(...auth(userA)).send({ label: 'cc-a' });
    expect(issue.status).toBe(201);
    expect(issue.body.data.key).toMatch(/^khy_/);
    expect(issue.body.data.keyPrefix).toBe(issue.body.data.key.slice(0, 12));

    const aTokens = await request(app).get('/api/user-gateway/cc/tokens').set(...auth(userA));
    expect(aTokens.body.data.length).toBe(1);
    expect(aTokens.body.data[0]).not.toHaveProperty('key'); // list never returns plaintext

    const bTokens = await request(app).get('/api/user-gateway/cc/tokens').set(...auth(userB));
    expect(bTokens.body.data.length).toBe(0);
  });

  test('GET /cc/endpoint returns the unified proxy endpoint', async () => {
    const res = await request(app).get('/api/user-gateway/cc/endpoint').set(...auth(userA));
    expect(res.status).toBe(200);
    expect(res.body.data.endpoint).toMatch(/^https?:\/\//);
    expect(res.body.data.port).toBeGreaterThan(0);
  });
});

describe('user-gateway routes — image-config isolation', () => {
  test('GET /image-config defaults to auto when unset', async () => {
    const res = await request(app).get('/api/user-gateway/image-config').set(...auth(userB));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // auto = empty backend (no pin).
    expect(res.body.data.backend === '' || res.body.data.backend === 'auto').toBe(true);
  });

  test('A pins an image backend+model and reads it back', async () => {
    const save = await request(app)
      .put('/api/user-gateway/image-config')
      .set(...auth(userA))
      .send({ backend: 'agnes', model: 'agnes-image-2.0' });
    expect(save.status).toBe(200);
    expect(save.body.success).toBe(true);
    expect(save.body.data.backend).toBe('agnes');
    expect(save.body.data.model).toBe('agnes-image-2.0');

    const read = await request(app).get('/api/user-gateway/image-config').set(...auth(userA));
    expect(read.body.data.backend).toBe('agnes');
    expect(read.body.data.model).toBe('agnes-image-2.0');
  });

  test("B never sees A's image pin (read isolation)", async () => {
    const read = await request(app).get('/api/user-gateway/image-config').set(...auth(userB));
    expect(read.status).toBe(200);
    expect(read.body.data.backend === '' || read.body.data.backend === 'auto').toBe(true);
  });

  test('setting backend=auto clears the pin', async () => {
    const save = await request(app)
      .put('/api/user-gateway/image-config')
      .set(...auth(userA))
      .send({ backend: 'auto', model: '' });
    expect(save.status).toBe(200);
    expect(save.body.data.backend === '' || save.body.data.backend === 'auto').toBe(true);
    expect(save.body.data.model).toBe('');
  });

  test('an unknown backend is rejected', async () => {
    const res = await request(app)
      .put('/api/user-gateway/image-config')
      .set(...auth(userA))
      .send({ backend: 'not-a-backend', model: 'x' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
