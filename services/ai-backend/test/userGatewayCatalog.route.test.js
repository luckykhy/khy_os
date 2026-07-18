/**
 * Route-level check for GET /api/user-gateway/catalog: it is reachable by an
 * authenticated user, scoped to req.user.id, and returns the flat edge list
 * shape the multi-pivot Web views consume. Confirms the route + import wiring
 * around userModelCatalogGraph (the graph's own logic is covered separately in
 * userModelCatalogGraph.test.js).
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-usergw-catalog-route-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-catalog-route';
process.env.NODE_ENV = 'test';

// Keep the catalog join deterministic + offline at the route layer: mock the
// live-merge sources (local Ollama + global/system graph) and the upstream
// probe. Their real behaviour is covered in their own suites.
jest.mock('../../backend/src/services/gateway/localOllamaProbe', () => ({
  fetchLocalModels: jest.fn(async () => ({ running: false, models: [], error: null })),
}));
jest.mock('../../backend/src/services/gateway/modelCatalogGraph', () => ({
  buildCatalogGraph: jest.fn(async () => ({ edges: [], generatedAt: 0, sources: {} })),
}));
jest.mock('../../backend/src/services/gateway/upstreamModelProbe', () => ({
  fetchUpstreamModels: jest.fn(async () => null),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { sequelize, User } = require('@khy/shared/models');
const svc = require('../src/services/userGatewayConfigService');
const router = require('../src/routes/userGateway');

const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });

let app;
let userA;
let userB;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  userA = await User.create({ username: 'rc-a', email: 'rc-a@test.local', password: 'pw-a-123456', status: 'active' });
  userB = await User.create({ username: 'rc-b', email: 'rc-b@test.local', password: 'pw-b-123456', status: 'active' });
  await svc.addProviderEntry(userA.id, { provider: 'deepseek', displayName: 'DeepSeek', key: 'sk-ds-route' });

  app = express();
  app.use(express.json());
  app.use('/api/user-gateway', router);
});

afterAll(async () => {
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

const auth = (u) => ['Authorization', `Bearer ${tokenFor(u.id)}`];

describe('GET /api/user-gateway/catalog', () => {
  test('authenticated user gets their own edges', async () => {
    const res = await request(app).get('/api/user-gateway/catalog').set(...auth(userA));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.edges)).toBe(true);
    const providers = res.body.data.edges.map(e => e.provider);
    expect(providers).toContain('deepseek');
    expect(res.body.data.sources).toBeDefined();
  });

  test('unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/user-gateway/catalog');
    expect(res.status).toBeGreaterThanOrEqual(401);
  });

  test("B does not see A's edges (tenant isolation)", async () => {
    const res = await request(app).get('/api/user-gateway/catalog').set(...auth(userB));
    expect(res.status).toBe(200);
    expect(res.body.data.edges).toHaveLength(0);
  });
});

describe('POST /api/user-gateway/detect', () => {
  test('runs a detection sweep and returns the enriched catalog + sources', async () => {
    const res = await request(app).post('/api/user-gateway/detect').set(...auth(userA)).send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.edges)).toBe(true);
    // detect path marks the sources block as live with a timestamp + summary.
    expect(res.body.data.sources.live).toBe(true);
    expect(typeof res.body.data.sources.detectedAt).toBe('number');
    expect(Array.isArray(res.body.data.sources.errors)).toBe(true);
  });

  test('unauthenticated detect is rejected', async () => {
    const res = await request(app).post('/api/user-gateway/detect').send({});
    expect(res.status).toBeGreaterThanOrEqual(401);
  });
});
