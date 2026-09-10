'use strict';

const express = require('express');

describe('routes/daemon', () => {
  let mockLifecycle;
  let router;

  beforeEach(() => {
    jest.resetModules();
    mockLifecycle = {
      snapshot: jest.fn(() => ({ state: 'running' })),
      ensureStarted: jest.fn(async () => ({ state: 'running' })),
      requestShutdown: jest.fn(async () => ({ ok: true })),
    };
    jest.mock('../services/aiManageDaemonLifecycle', () => mockLifecycle);
    router = require('./daemon');
  });

  it('should export an express router', () => {
    expect(typeof router).toBe('function');
    expect(router.stack).toBeDefined();
  });

  it('GET /status returns snapshot as JSON', async () => {
    const req = {};
    const res = {
      json: jest.fn(),
      status: jest.fn(function () { return this; }),
    };
    const route = router.stack.find((l) => l.route && l.route.path === '/status' && l.route.methods.get);
    expect(route).toBeDefined();
    await route.route.stack[0].handle(req, res, () => {});
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { state: 'running' } });
  });

  it('GET /ensure returns 200 when running', async () => {
    mockLifecycle.ensureStarted.mockResolvedValue({ state: 'running' });
    const req = {};
    const res = {
      json: jest.fn(),
      status: jest.fn(function () { return this; }),
    };
    const route = router.stack.find((l) => l.route && l.route.path === '/ensure' && l.route.methods.get);
    await route.route.stack[0].handle(req, res, () => {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('GET /ensure returns 200 when skipped', async () => {
    mockLifecycle.ensureStarted.mockResolvedValue({ state: 'skipped' });
    const req = {};
    const res = {
      json: jest.fn(),
      status: jest.fn(function () { return this; }),
    };
    const route = router.stack.find((l) => l.route && l.route.path === '/ensure' && l.route.methods.get);
    await route.route.stack[0].handle(req, res, () => {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('GET /ensure returns 503 when failed', async () => {
    mockLifecycle.ensureStarted.mockResolvedValue({ state: 'failed' });
    const req = {};
    const res = {
      json: jest.fn(),
      status: jest.fn(function () { return this; }),
    };
    const route = router.stack.find((l) => l.route && l.route.path === '/ensure' && l.route.methods.get);
    await route.route.stack[0].handle(req, res, () => {});
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('POST /ensure behaves like GET /ensure', async () => {
    mockLifecycle.ensureStarted.mockResolvedValue({ state: 'running' });
    const req = {};
    const res = {
      json: jest.fn(),
      status: jest.fn(function () { return this; }),
    };
    const route = router.stack.find((l) => l.route && l.route.path === '/ensure' && l.route.methods.post);
    await route.route.stack[0].handle(req, res, () => {});
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('POST /shutdown returns result', async () => {
    mockLifecycle.requestShutdown.mockResolvedValue({ ok: true });
    const req = {};
    const res = {
      json: jest.fn(),
      status: jest.fn(function () { return this; }),
    };
    const route = router.stack.find((l) => l.route && l.route.path === '/shutdown' && l.route.methods.post);
    await route.route.stack[0].handle(req, res, () => {});
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ok: true } });
  });
});

