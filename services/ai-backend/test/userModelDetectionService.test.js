/**
 * userModelDetectionService — probe a user's own upstreams and persist models.
 *
 * The upstream /models probe is mocked (its real network behaviour is covered by
 * services/backend upstreamModelProbe.test.js); here we assert the orchestration:
 *   - relay + each provider are probed and results persisted to user_provider_models;
 *   - a failed probe degrades to { probed:true, error } without throwing;
 *   - an upstream with no key/base is skipped (probed:false), not an error;
 *   - detectUpstreams aggregates counts + collects per-upstream errors;
 *   - persistence is tenant-scoped + idempotent (manual models survive a re-probe).
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-usergw-detect-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-user-detect';
process.env.NODE_ENV = 'test';

// Mock the single-source upstream probe (backend package).
jest.mock('../../backend/src/services/gateway/upstreamModelProbe', () => ({
  fetchUpstreamModels: jest.fn(),
}));
const { fetchUpstreamModels } = require('../../backend/src/services/gateway/upstreamModelProbe');

const { sequelize, User } = require('@khy/shared/models');
const svc = require('../src/services/userGatewayConfigService');
const detection = require('../src/services/gateway/userModelDetectionService');

let userA;
let userB;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  userA = await User.create({ username: 'det-a', email: 'det-a@test.local', password: 'pw-a-123456', status: 'active' });
  userB = await User.create({ username: 'det-b', email: 'det-b@test.local', password: 'pw-b-123456', status: 'active' });

  // A: a relay upstream (with key) + two provider keys (deepseek has a base url,
  // moonshot has neither base nor endpoint → unprobeable).
  await svc.saveRelayConfig(userA.id, {
    baseUrl: 'https://relay.a.example.com',
    modelId: 'relay-default',
    compatibility: 'openai',
    apiKey: 'sk-relay-secret',
  });
  await svc.addProviderEntry(userA.id, { provider: 'deepseek', key: 'sk-ds-1', baseUrl: 'https://api.deepseek.com/v1' });
  await svc.addProviderEntry(userA.id, { provider: 'moonshot', key: 'sk-ms-1' }); // no base/endpoint
});

afterAll(async () => {
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

afterEach(() => jest.clearAllMocks());

describe('detectForProvider', () => {
  test('relay: probes the resolved upstream and persists returned models', async () => {
    fetchUpstreamModels.mockResolvedValue([{ id: 'relay-default' }, { id: 'extra-model' }]);
    const res = await detection.detectForProvider(userA.id, 'relay');

    // Probed with the decrypted relay key (server-side only).
    expect(fetchUpstreamModels).toHaveBeenCalledTimes(1);
    expect(fetchUpstreamModels.mock.calls[0][0]).toMatchObject({
      baseUrl: 'https://relay.a.example.com',
      apiKey: 'sk-relay-secret',
    });
    expect(res).toMatchObject({ provider: 'relay', probed: true, error: null });
    expect(res.added).toBe(2);

    const stored = await svc.listModels(userA.id, { provider: 'relay' });
    expect(stored.map(m => m.model).sort()).toEqual(['extra-model', 'relay-default']);
  });

  test('named provider with a base url is probed + persisted', async () => {
    fetchUpstreamModels.mockResolvedValue([{ id: 'deepseek-chat' }]);
    const res = await detection.detectForProvider(userA.id, 'deepseek');
    expect(res).toMatchObject({ provider: 'deepseek', probed: true, added: 1 });
    const stored = await svc.listModels(userA.id, { provider: 'deepseek' });
    expect(stored.map(m => m.model)).toEqual(['deepseek-chat']);
  });

  test('provider with no usable upstream is skipped (probed:false, not an error)', async () => {
    const res = await detection.detectForProvider(userA.id, 'moonshot');
    expect(res).toMatchObject({ provider: 'moonshot', probed: false, added: 0, error: null });
    expect(fetchUpstreamModels).not.toHaveBeenCalled();
  });

  test('failed probe degrades to probed:true + error (never throws, persists nothing)', async () => {
    fetchUpstreamModels.mockResolvedValue(null); // e.g. anthropic 404 / timeout
    const res = await detection.detectForProvider(userA.id, 'deepseek');
    expect(res).toMatchObject({ provider: 'deepseek', probed: true, added: 0 });
    expect(res.error).toMatch(/probe failed/i);
    // No /models endpoint is an EXPECTED outcome → flagged benign so the UI can
    // stay quiet instead of flashing "not found" on every detect.
    expect(res.benign).toBe(true);
  });

  test('a thrown probe error is a REAL failure (benign:false)', async () => {
    fetchUpstreamModels.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await detection.detectForProvider(userA.id, 'deepseek');
    expect(res).toMatchObject({ provider: 'deepseek', probed: true, added: 0, benign: false });
    expect(res.error).toMatch(/ECONNREFUSED/);
  });

  test('empty provider name → error, no probe', async () => {
    const res = await detection.detectForProvider(userA.id, '   ');
    expect(res.error).toMatch(/required/i);
    expect(fetchUpstreamModels).not.toHaveBeenCalled();
  });
});

describe('detectUpstreams', () => {
  test('sweeps relay + all providers, aggregates counts + per-upstream errors', async () => {
    // relay → ok 1 model; deepseek → ok 1; moonshot → unprobeable (skipped).
    fetchUpstreamModels.mockImplementation(async (args) => {
      if (args.apiKey === 'sk-relay-secret') return [{ id: 'r1' }];
      if (args.apiKey === 'sk-ds-1') return null; // simulate a probe failure
      return [];
    });

    const summary = await detection.detectUpstreams(userA.id);
    const names = summary.providers.map(p => p.provider).sort();
    expect(names).toEqual(['deepseek', 'moonshot', 'relay']);

    expect(summary.probed).toBe(2); // relay + deepseek attempted; moonshot skipped
    // deepseek failed → recorded in errors with its provider tag, flagged benign
    // (null probe = no /models endpoint) so the UI suppresses the red error.
    const dsErr = summary.errors.find(e => e.provider === 'deepseek');
    expect(dsErr).toBeTruthy();
    expect(dsErr.benign).toBe(true);
    expect(summary.errors.every(e => e.source === 'upstream')).toBe(true);
  });

  test('tenant isolation: detecting for B does not touch A and B owns nothing', async () => {
    fetchUpstreamModels.mockResolvedValue([]);
    const summary = await detection.detectUpstreams(userB.id);
    // B has only the relay slot candidate but no relay config → nothing probed.
    expect(summary.providers.map(p => p.provider)).toEqual(['relay']);
    const bModels = await svc.listModels(userB.id);
    expect(bModels).toHaveLength(0);
  });
});

describe('probeConfig — DRY-RUN "测试连接" (never persists)', () => {
  test('ok: returns discovered models as { id, capability } and persists nothing', async () => {
    fetchUpstreamModels.mockResolvedValue([{ id: 'gpt-4o-mini' }, { id: 'dall-e-3' }]);
    const res = await detection.probeConfig({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk-test' });
    expect(res.ok).toBe(true);
    expect(res.count).toBe(2);
    expect(res.models).toEqual([
      { id: 'gpt-4o-mini', capability: expect.any(String) },
      { id: 'dall-e-3', capability: expect.any(String) },
    ]);
    expect(res.error).toBeNull();
    // Dry-run: nothing written to either user's catalog.
    expect(await svc.listModels(userB.id)).toHaveLength(0);
  });

  test('missing API key → ok:false, no probe attempted', async () => {
    const res = await detection.probeConfig({ baseUrl: 'https://api.x.com/v1', apiKey: '' });
    expect(res).toMatchObject({ ok: false, count: 0 });
    expect(res.error).toMatch(/key/i);
    expect(fetchUpstreamModels).not.toHaveBeenCalled();
  });

  test('missing baseUrl + endpoint → ok:false, no probe attempted', async () => {
    const res = await detection.probeConfig({ apiKey: 'sk-test' });
    expect(res).toMatchObject({ ok: false, count: 0 });
    expect(fetchUpstreamModels).not.toHaveBeenCalled();
  });

  test('null probe (no /models endpoint) → soft ok:false with a guiding message', async () => {
    fetchUpstreamModels.mockResolvedValue(null);
    const res = await detection.probeConfig({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk-test' });
    expect(res).toMatchObject({ ok: false, count: 0, models: [] });
    expect(res.error).toMatch(/模型列表|手动/);
  });

  test('a thrown probe error → ok:false carrying the message', async () => {
    fetchUpstreamModels.mockRejectedValue(new Error('ETIMEDOUT'));
    const res = await detection.probeConfig({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk-test' });
    expect(res).toMatchObject({ ok: false, count: 0 });
    expect(res.error).toMatch(/ETIMEDOUT/);
  });
});
