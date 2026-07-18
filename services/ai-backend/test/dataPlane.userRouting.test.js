/**
 * Stage 3 gate: the data plane routes a CC client request to the *owner's* own
 * upstream, with strict tenant isolation and zero regression for the global path.
 *
 * We assert at the enforceInbound() seam — the single decision point the proxy
 * calls before dispatch — so the test is deterministic and needs no live
 * upstream. The properties verified:
 *   1. A's khy_ token  -> ctx.source='user', A's endpoint + A's (decrypted) key.
 *   2. B's khy_ token  -> B's endpoint; never A's (no cross-talk).
 *   3. PROXY_AUTH_TOKEN -> ctx.source='global', NO per-user upstream (unchanged).
 *   4. A recognized-but-unconfigured token -> falls through (non-strict default).
 *   5. Same token under GATEWAY_USER_ISOLATION_STRICT -> 403 gateway_unconfigured.
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

// On-disk SQLite bound BEFORE any @khy/shared model is required.
const TMP_DB = path.join(os.tmpdir(), `khy-dataplane-routing-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-dataplane';
process.env.NODE_ENV = 'test';
// Start from a clean enforcement env; individual tests opt into knobs.
delete process.env.PROXY_AUTH_TOKEN;
delete process.env.GATEWAY_USER_ISOLATION_STRICT;

const { sequelize, User, ApiKey } = require('@khy/shared/models');
const { generateKey, hashApiKey, extractPrefix } = require('@khy/shared/utils/apiKeyHash');

const svc = require('../src/services/userGatewayConfigService');
const resolver = require('../src/services/gateway/userGatewayResolver');
const enforcer = require('../src/services/gateway/dataPlaneEnforcer');

// Issue an active CC token for a user, returning the plaintext bearer.
async function issueToken(uid, label) {
  await ApiKey.update({ isActive: false }, { where: { userId: uid, isActive: true } });
  const raw = generateKey();
  await ApiKey.create({
    userId: uid, keyHash: hashApiKey(raw), keyPrefix: extractPrefix(raw),
    label: label || 'default', isActive: true,
  });
  return raw;
}

const enforce = (bearer, model = '') =>
  enforcer.enforceInbound({ bearer, model, messages: [{ role: 'user', content: 'hi' }], traceId: 't' });

let userA, userB, userC;
let keyA, keyB, keyC;

beforeAll(async () => {
  await sequelize.sync({ force: true });

  userA = await User.create({ username: 'alice', email: 'a@test.local', password: 'pw-alice-123', status: 'active' });
  userB = await User.create({ username: 'bob', email: 'b@test.local', password: 'pw-bob-123', status: 'active' });
  userC = await User.create({ username: 'carol', email: 'c@test.local', password: 'pw-carol-123', status: 'active' });

  // A and B configure distinct upstreams; C stays unconfigured.
  await svc.saveRelayConfig(userA.id, { baseUrl: 'https://a.example.com', modelId: 'a-model', compatibility: 'openai', apiKey: 'sk-aaa-secret' });
  await svc.saveRelayConfig(userB.id, { baseUrl: 'https://b.example.com', modelId: 'b-model', compatibility: 'anthropic', apiKey: 'sk-bbb-secret' });

  keyA = await issueToken(userA.id, 'cc-a');
  keyB = await issueToken(userB.id, 'cc-b');
  keyC = await issueToken(userC.id, 'cc-c');

  resolver.invalidateAll();
});

afterAll(async () => {
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

describe('data plane — per-user upstream routing', () => {
  test("A's token routes to A's upstream with A's decrypted key", async () => {
    const v = await enforce(keyA);
    expect(v.ok).toBe(true);
    expect(v.ctx.source).toBe('user');
    expect(v.ctx.userId).toBe(userA.id);
    expect(v.ctx.upstream).toBeTruthy();
    expect(v.ctx.upstream.apiEndpoint).toBe('https://a.example.com');
    expect(v.ctx.upstream.apiKey).toBe('sk-aaa-secret'); // decrypted in-process
    expect(v.ctx.upstream.model).toBe('a-model');
    expect(v.ctx.upstream.apiFormat).toBe('openai');
  });

  test("B's token routes to B's upstream — never A's (no cross-talk)", async () => {
    const v = await enforce(keyB);
    expect(v.ok).toBe(true);
    expect(v.ctx.userId).toBe(userB.id);
    expect(v.ctx.upstream.apiEndpoint).toBe('https://b.example.com');
    expect(v.ctx.upstream.apiKey).toBe('sk-bbb-secret');
    expect(v.ctx.upstream.apiEndpoint).not.toBe('https://a.example.com');
    expect(v.ctx.upstream.apiKey).not.toBe('sk-aaa-secret');
    expect(v.ctx.upstream.apiFormat).toBe('anthropic');
  });
});

describe('data plane — global path unchanged (zero regression)', () => {
  test('PROXY_AUTH_TOKEN bearer short-circuits to source:global with no per-user upstream', async () => {
    process.env.PROXY_AUTH_TOKEN = 'global-secret-token';
    try {
      const v = await enforce('global-secret-token');
      expect(v.ok).toBe(true);
      expect(v.ctx.source).toBe('global');
      expect(v.ctx.upstream).toBeUndefined();
    } finally {
      delete process.env.PROXY_AUTH_TOKEN;
    }
  });
});

describe('data plane — recognized-but-unconfigured token', () => {
  test('non-strict (default): falls through to the legacy ladder, no per-user upstream', async () => {
    const v = await enforce(keyC);
    expect(v.ok).toBe(true);
    expect(v.ctx.source).not.toBe('user');
    expect(v.ctx.upstream).toBeUndefined();
  });

  test('strict isolation: same token is rejected 403 gateway_unconfigured', async () => {
    process.env.GATEWAY_USER_ISOLATION_STRICT = 'true';
    try {
      const v = await enforce(keyC);
      expect(v.ok).toBe(false);
      expect(v.httpStatus).toBe(403);
      expect(v.code).toBe('gateway_unconfigured');
    } finally {
      delete process.env.GATEWAY_USER_ISOLATION_STRICT;
    }
  });
});
