'use strict';

/**
 * Route Auth Regression Tests — verify protected endpoints reject unauthenticated requests.
 */

const express = require('express');
const request = require('supertest');

// Mock auth middleware to simulate real behavior
jest.mock('../src/middleware/auth', () => {
  const { flexibleAuth, authMiddleware, adminMiddleware } = jest.requireActual('../src/middleware/auth');
  return { flexibleAuth, authMiddleware, adminMiddleware };
});

// Mock models to avoid DB dependency
jest.mock('../src/models', () => ({
  User: { findByPk: jest.fn() },
  ApiKey: { findOne: jest.fn() },
  sequelize: {
    getQueryInterface: () => ({ describeTable: jest.fn().mockResolvedValue({}) }),
    query: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../src/config/database', () => ({
  sequelize: {
    getQueryInterface: () => ({ describeTable: jest.fn().mockResolvedValue({}) }),
    query: jest.fn().mockResolvedValue([]),
    authenticate: jest.fn(),
  },
}));

// Mock controllers to avoid side effects
jest.mock('../src/controllers/comprehensiveDataController', () => ({
  getKlineData: (req, res) => res.json({ ok: true }),
  getComprehensiveData: (req, res) => res.json({ ok: true }),
  getDataRange: (req, res) => res.json({ ok: true }),
  getBatchData: (req, res) => res.json({ ok: true }),
  getSupportedInstruments: (req, res) => res.json({ ok: true }),
  searchInstruments: (req, res) => res.json({ ok: true }),
  getMarketInfo: (req, res) => res.json({ ok: true }),
  getDataSourceStatus: (req, res) => res.json({ ok: true }),
  testDataSource: (req, res) => res.json({ ok: true }),
  testAllDataSources: (req, res) => res.json({ ok: true }),
  testSingleSource: (req, res) => res.json({ ok: true }),
  getDataSourceConfig: (req, res) => res.json({ ok: true }),
  updateDataSourceConfig: (req, res) => res.json({ ok: true }),
  getEnabledDataSources: (req, res) => res.json({ ok: true }),
  clearCache: (req, res) => res.json({ ok: true }),
  switchDataSource: (req, res) => res.json({ ok: true }),
}));

describe('Route Auth Regression - comprehensiveData', () => {
  let app;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-for-auth-regression';
    app = express();
    app.use(express.json());
    app.use('/api/comprehensive', require('../src/routes/comprehensiveData'));
  });

  const protectedGetEndpoints = [
    '/api/comprehensive/kline',
    '/api/comprehensive/data/AAPL',
    '/api/comprehensive/range/AAPL',
    '/api/comprehensive/instruments',
    '/api/comprehensive/instruments/search',
    '/api/comprehensive/markets',
    '/api/comprehensive/sources/status',
    '/api/comprehensive/sources/enabled',
  ];

  test.each(protectedGetEndpoints)('GET %s returns 401 without auth', async (endpoint) => {
    const res = await request(app).get(endpoint);
    expect(res.status).toBe(401);
  });

  test('POST /api/comprehensive/batch returns 401 without auth', async () => {
    const res = await request(app).post('/api/comprehensive/batch').send({});
    expect(res.status).toBe(401);
  });
});
