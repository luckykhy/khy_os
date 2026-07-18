/**
 * GET /api/user-gateway/provider-presets — built-in common-provider presets
 * for the MyGateway relay + custom-provider dropdowns.
 *
 * Asserts: an authenticated user reaches it and gets a non-empty array of
 * key-less presets; the env-extensibility (KHY_PROVIDER_PRESETS) surfaces; and
 * an unauthenticated request is rejected.
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-usergw-presets-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-presets-route';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { sequelize, User } = require('@khy/shared/models');
const router = require('../src/routes/userGateway');

const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });

let app;
let userA;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  userA = await User.create({ username: 'pre-a', email: 'pre-a@test.local', password: 'pw-a-123456', status: 'active' });
  app = express();
  app.use(express.json());
  app.use('/api/user-gateway', router);
});

afterAll(async () => {
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

afterEach(() => { delete process.env.KHY_PROVIDER_PRESETS; });

const auth = (u) => ['Authorization', `Bearer ${tokenFor(u.id)}`];

describe('GET /api/user-gateway/provider-presets', () => {
  test('authenticated user gets a non-empty, key-less preset list', async () => {
    const res = await request(app).get('/api/user-gateway/provider-presets').set(...auth(userA));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);

    const ids = res.body.data.map((p) => p.id);
    expect(ids).toContain('deepseek');
    expect(ids).toContain('agnes');

    for (const p of res.body.data) {
      expect(p).toHaveProperty('baseUrl');
      expect(p).toHaveProperty('apiFormat');
      // No credential ever ships in a preset payload.
      expect(p).not.toHaveProperty('key');
      expect(p).not.toHaveProperty('apiKey');
    }
  });

  test('env KHY_PROVIDER_PRESETS extensions surface', async () => {
    process.env.KHY_PROVIDER_PRESETS = JSON.stringify([
      { id: 'acme', label: 'Acme', baseUrl: 'https://acme.example/v1', apiFormat: 'openai' },
    ]);
    const res = await request(app).get('/api/user-gateway/provider-presets').set(...auth(userA));
    expect(res.status).toBe(200);
    expect(res.body.data.find((p) => p.id === 'acme')).toBeDefined();
  });

  test('unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/user-gateway/provider-presets');
    expect(res.status).toBeGreaterThanOrEqual(401);
  });
});
