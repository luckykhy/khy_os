'use strict';

const { RELOAD_PATH, STATUS_PATH, createModelAdaptationHttpHandler, defaultSendJson } = require('../../src/services/modelAdaptationHttp');

describe('modelAdaptationHttp', () => {
  test('exports STATUS_PATH and RELOAD_PATH', () => {
    expect(STATUS_PATH).toBe('/api/model-adaptation/status');
    expect(RELOAD_PATH).toBe('/api/model-adaptation/reload');
  });

  describe('createModelAdaptationHttpHandler', () => {
    test('returns false for unknown routes', async () => {
      const handler = createModelAdaptationHttpHandler();
      const req = { method: 'GET', baseUrl: '', path: '/unknown' };
      const res = {};
      const result = await handler(req, res, '/unknown');
      expect(result).toBe(false);
    });

    test('returns 401 when authentication fails', async () => {
      const handler = createModelAdaptationHttpHandler({
        authenticate: () => false
      });
      const req = { method: 'GET', baseUrl: '', path: STATUS_PATH };
      let statusCode;
      const res = {
        writeHead: (code) => { statusCode = code; },
        end: () => {}
      };
      const result = await handler(req, res, STATUS_PATH);
      expect(statusCode).toBe(401);
      expect(result).toBe(true);
    });

    test('returns 405 for wrong method on STATUS_PATH', async () => {
      const handler = createModelAdaptationHttpHandler({
        authenticate: () => true
      });
      const req = { method: 'POST', baseUrl: '', path: STATUS_PATH };
      let statusCode;
      const res = {
        writeHead: (code) => { statusCode = code; },
        end: () => {}
      };
      const result = await handler(req, res, STATUS_PATH);
      expect(statusCode).toBe(405);
      expect(result).toBe(true);
    });

    test('handles GET /api/model-adaptation/status', async () => {
      const registry = { getStatus: () => ({ models: [] }) };
      const handler = createModelAdaptationHttpHandler({
        authenticate: () => true,
        registry
      });
      const req = { method: 'GET', baseUrl: '', path: STATUS_PATH };
      let statusCode;
      const res = {
        writeHead: (code) => { statusCode = code; },
        end: () => {}
      };
      const result = await handler(req, res, STATUS_PATH);
      expect(statusCode).toBe(200);
      expect(result).toBe(true);
    });

    test('handles POST /api/model-adaptation/reload', async () => {
      const registry = { reload: () => ({ reloaded: true }) };
      const handler = createModelAdaptationHttpHandler({
        authenticate: () => true,
        registry
      });
      const req = { method: 'POST', baseUrl: '', path: RELOAD_PATH };
      let statusCode;
      const res = {
        writeHead: (code) => { statusCode = code; },
        end: () => {}
      };
      const result = await handler(req, res, RELOAD_PATH);
      expect(statusCode).toBe(200);
      expect(result).toBe(true);
    });
  });

  describe('defaultSendJson', () => {
    test('sends JSON response', () => {
      let written = false;
      const res = {
        writeHead: () => {},
        end: (body) => { written = true; expect(body).toContain('test'); }
      };
      defaultSendJson(res, 200, { data: 'test' });
      expect(written).toBe(true);
    });
  });
});

