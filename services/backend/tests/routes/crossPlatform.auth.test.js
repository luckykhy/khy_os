'use strict';

/**
 * crossPlatform.auth.test.js — every /api/cross-platform route is auth-gated.
 *
 * The two POST /start-* endpoints spawn child processes, so an unauthenticated
 * hit was remote command execution rather than a read-only leak. These tests
 * pin the gate, the per-user scoping of device/notification calls, and the
 * admin-only global broadcast.
 */

const express = require('express');
const request = require('supertest');

// The real middleware runs here; only token verification is stubbed, so
// authMiddleware/adminMiddleware behavior stays under test too.
jest.mock('../../src/services/authSessionService', () => ({
  authenticateAccessToken: jest.fn(),
}));

const { authenticateAccessToken } = require('../../src/services/authSessionService');

// The hub is the state that leaks across accounts; stub it to observe scoping.
const mockHub = {
  listDevices: jest.fn(() => []),
  registerDevice: jest.fn((info) => ({ deviceId: info.deviceId, ...info })),
  unregisterDevice: jest.fn(() => true),
  getSession: jest.fn(() => null),
  getStatus: jest.fn(() => ({ connectedDevices: 0 })),
  _sessions: new Map(),
};

jest.mock('../../src/services/crossPlatform/crossPlatformHub', () => ({ hub: mockHub }));

const mockServer = {
  getStatus: jest.fn(() => ({ uptime: 0 })),
  notifyUser: jest.fn(() => 1),
  broadcast: jest.fn(() => 0),
};

jest.mock('../../src/services/crossPlatform/ws/syncServer', () => mockServer);

const mockLauncher = {
  startPlatform: jest.fn(async () => ({ success: true, pid: 1 })),
  startMultiple: jest.fn(async () => [{ platform: 'backend', success: true, pid: 1 }]),
  getPlatformStatus: jest.fn(async () => ({})),
};

jest.mock('../../src/services/crossPlatform/crossLauncher', () => mockLauncher);

const BASE = '/api/cross-platform';

const app = express();
app.use(express.json());
app.use(BASE, require('../../src/routes/crossPlatform'));

function target(path) {
  return BASE + path;
}

// authMiddleware sets req.user from authResult.user; adminMiddleware reads req.user.role.
function actAs(user) {
  authenticateAccessToken.mockResolvedValue({
    ok: true,
    user,
    session: { id: 'sess-1' },
  });
}

const USER = { id: 42, role: 'user' };
const ADMIN = { id: 7, role: 'admin' };
const TOKEN = { Authorization: 'Bearer test-token' };

const ROUTES = [
  ['get', '/status'],
  ['get', '/devices'],
  ['post', '/devices/register'],
  ['delete', '/devices/abc'],
  ['get', '/sessions'],
  ['get', '/sessions/s1'],
  ['post', '/notify'],
  ['post', '/broadcast'],
  ['post', '/start-platform'],
  ['post', '/start-all'],
  ['get', '/status-all'],
];

describe('routes/crossPlatform authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(ROUTES)('%s %s rejects a request with no token (401)', async (method, path) => {
    const res = await request(app)[method](target(path));
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(authenticateAccessToken).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s %s rejects a token the session service rejects (401)', async (method, path) => {
    authenticateAccessToken.mockResolvedValue({ ok: false, code: 'token_expired' });
    const res = await request(app)[method](target(path)).set(TOKEN);
    expect(res.status).toBe(401);
  });

  it('GET /devices scopes the device listing to the authenticated user', async () => {
    actAs(USER);
    const res = await request(app).get(target('/devices')).set(TOKEN);
    expect(res.status).toBe(200);
    expect(mockHub.listDevices).toHaveBeenCalledWith({ userId: '42', connectedOnly: true });
  });

  it('POST /devices/register binds the device to the authenticated user id', async () => {
    actAs(USER);
    const res = await request(app)
      .post(target('/devices/register'))
      .set(TOKEN)
      .send({ deviceId: 'd1', platform: 'web' });
    expect(res.status).toBe(200);
    expect(mockHub.registerDevice).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'd1', platform: 'web', userId: '42' })
    );
  });

  it('POST /notify targets the caller, ignoring a userId in the body', async () => {
    actAs(USER);
    const res = await request(app)
      .post(target('/notify'))
      .set(TOKEN)
      .send({ userId: '999', title: 'hi' });
    expect(res.status).toBe(200);
    expect(mockServer.notifyUser).toHaveBeenCalledWith('42', 'hi', undefined, {});
  });

  it('POST /notify still requires a title', async () => {
    actAs(USER);
    const res = await request(app).post(target('/notify')).set(TOKEN).send({ userId: '999' });
    expect(res.status).toBe(400);
  });

  it('POST /broadcast is admin-only: a regular user gets 403', async () => {
    actAs(USER);
    const res = await request(app).post(target('/broadcast')).set(TOKEN).send({ type: 'ping' });
    expect(res.status).toBe(403);
    expect(mockServer.broadcast).not.toHaveBeenCalled();
  });

  it('POST /broadcast delivers for an admin and reaches every device', async () => {
    actAs(ADMIN);
    const res = await request(app).post(target('/broadcast')).set(TOKEN).send({ type: 'ping' });
    expect(res.status).toBe(200);
    expect(mockServer.broadcast).toHaveBeenCalledWith({ type: 'ping' });
  });

  it('POST /start-platform spawns only when authenticated', async () => {
    actAs(USER);
    const res = await request(app).post(target('/start-platform')).set(TOKEN).send({ platform: 'web' });
    expect(res.status).toBe(200);
    expect(mockLauncher.startPlatform).toHaveBeenCalledWith('web');
    expect(res.body.data).toEqual(expect.objectContaining({ pid: 1 }));
  });

  it('POST /start-platform rejects a missing platform instead of spawning', async () => {
    actAs(USER);
    const res = await request(app).post(target('/start-platform')).set(TOKEN).send({});
    expect(res.status).toBe(400);
    expect(mockLauncher.startPlatform).not.toHaveBeenCalled();
  });

  it('POST /start-all passes through per-platform failures unchanged', async () => {
    mockLauncher.startMultiple.mockResolvedValueOnce([
      { platform: 'backend', success: true, pid: 1 },
      { platform: 'web', success: false, error: 'Directory not found' },
    ]);
    actAs(USER);
    const res = await request(app).post(target('/start-all')).set(TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'web', success: false }),
    ]));
  });
});
