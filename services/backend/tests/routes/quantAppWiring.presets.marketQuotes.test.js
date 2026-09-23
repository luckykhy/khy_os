/**
 * Frontend↔backend wiring contract for the two quant-app routers that the
 * trading monolith mounts under /api/strategies and /api/comprehensive-data:
 *
 *   - GET /presets       — consumed by khyquant frontend
 *     intelligentStrategyService.getParameterPresets() (expects the standard
 *     { success, data } envelope; the interceptor returns the body and the
 *     caller destructures `data`).
 *   - GET /market-quotes  — consumed by khyquant frontend
 *     api/marketData.getMarketQuotes() tier-2 (expects
 *     { success, data: { quotes: [...] } } envelope).
 *
 * These routes were implemented downstream (controller getMarketQuotes exists)
 * but never registered in the routers, so the frontend calls 404 today. This
 * suite locks the registration + envelope shape so the wiring stays fixed.
 *
 * Env setup mirrors tests/ai-backend/test/userGatewayCatalog.route.test.js:
 * sqlite tmp DB for the Sequelize models that load at module scope.
 */
'use strict';

const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `khy-quantapp-wiring-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-quantapp-wiring';
process.env.NODE_ENV = 'test';

// The auth middleware resolves tokens through authSessionService (session
// store). Route-level wiring does not depend on session internals — stub it so
// every request authenticates as the same synthetic user.
jest.mock('../../src/middleware/auth', () => {
  const attach = (req, res, next) => {
    req.user = { id: 1, userId: 1, username: 'wiring-test', role: 'user' };
    req.auth = { method: 'jwt', legacy: false, sessionId: null };
    next();
  };
  return {
    authMiddleware: attach,
    adminMiddleware: attach,
    flexibleAuth: attach,
    authenticateToken: attach,
    requireAdmin: attach,
  };
});

const express = require('express');

// market-quotes fetches live quotes per popular symbol; the wiring contract
// only cares about route registration + envelope shape, not quote values. Stub
// the data service so the handler completes deterministically and offline.
jest.mock(
  '../../../../software/khyquant/services/comprehensiveDataService',
  () => ({
    getComprehensiveData: jest.fn(async () => ({
      source: 'test-source',
      kline: [
        { time: '2026-09-10', open: 10, close: 11, high: 12, low: 9, volume: 100 },
        { time: '2026-09-11', open: 11, close: 12, high: 13, low: 10, volume: 110 },
      ],
    })),
  }),
  { virtual: true }
);

const supertest = require('supertest');

// Require the shims exactly as the monolith does (server.js mounts these
// modules via mountOptional, [DESIGN-TOOL-002] §4.1).
const strategyRouter = require('../../src/routes/strategy');
const comprehensiveRouter = require('../../src/routes/comprehensiveData');

describe('quant-app 前后端接线：/presets 与 /market-quotes 路由契约', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/strategies', strategyRouter);
    app.use('/api/comprehensive-data', comprehensiveRouter);
  });

  it('strategy 路由注册了 GET /presets', () => {
    const routes = registeredPaths(strategyRouter);
    expect(routes).toContain('GET /presets');
  });

  it('comprehensiveData 路由注册了 GET /market-quotes', () => {
    const routes = registeredPaths(comprehensiveRouter);
    expect(routes).toContain('GET /market-quotes');
  });

  it('GET /api/strategies/presets 返回 { success, data } 信封（前端解构 data）', async () => {
    const res = await supertest(app)
      .get('/api/strategies/presets')
      .query({ type: 'trend', complexity: 'medium' })
      .set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The frontend destructures `data` off the body — it must be an object
    // with at least the requested type's preset.
    expect(res.body.data).toBeTruthy();
    expect(typeof res.body.data).toBe('object');
  });

  it('GET /api/comprehensive-data/market-quotes 返回 { success, data:{quotes} } 信封', async () => {
    const res = await supertest(app)
      .get('/api/comprehensive-data/market-quotes')
      .set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.quotes)).toBe(true);
    // Every quote row must carry the symbol field the frontend maps over.
    for (const q of res.body.data.quotes) {
      expect(typeof q.symbol).toBe('string');
    }
  });
});

/** Flatten a router stack into readable "METHOD path" lines. */
function registeredPaths(router) {
  return (router.stack || [])
    .map((layer) => {
      const route = layer && layer.route;
      if (!route) return null;
      const methods = Object.keys(route.methods || {})
        .map((m) => m.toUpperCase())
        .join(',');
      return `${methods} ${route.path}`;
    })
    .filter(Boolean);
}
