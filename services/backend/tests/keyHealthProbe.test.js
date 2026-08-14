'use strict';

/**
 * Tests for keyHealthProbe service.
 */

// Mock apiKeyPool before requiring the module
jest.mock('../src/services/apiKeyPool', () => ({
  init: jest.fn(),
  getProviders: jest.fn(() => []),
  listAvailableKeys: jest.fn(() => []),
  markSuccess: jest.fn(),
  markFailure: jest.fn(),
}));

const pool = require('../src/services/apiKeyPool');
const probe = require('../src/services/keyHealthProbe');

// Mock global fetch
const _origFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  probe._resetForTest();
});

afterAll(() => {
  global.fetch = _origFetch;
  probe._resetForTest();
});

describe('keyHealthProbe', () => {

  // ── probeAll ──

  test('probeAll() returns empty array when no providers', async () => {
    pool.getProviders.mockReturnValue([]);
    const results = await probe.probeAll();
    expect(results).toEqual([]);
    expect(pool.init).toHaveBeenCalled();
  });

  test('probeAll() probes all keys across providers', async () => {
    pool.getProviders.mockReturnValue(['deepseek', 'openai']);
    pool.listAvailableKeys.mockImplementation((provider) => {
      if (provider === 'deepseek') {
        return [{ keyId: 'ds-1', key: 'sk-ds', endpoint: 'https://api.deepseek.com/v1' }];
      }
      if (provider === 'openai') {
        return [
          { keyId: 'oai-1', key: 'sk-oai1', endpoint: 'https://api.openai.com/v1' },
          { keyId: 'oai-2', key: 'sk-oai2', endpoint: 'https://api.openai.com/v1' },
        ];
      }
      return [];
    });

    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const results = await probe.probeAll();
    expect(results).toHaveLength(3);
    expect(results.map(r => r.keyId)).toEqual(['ds-1', 'oai-1', 'oai-2']);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('probeKey() accepts pool entries that expose keyId instead of id', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await probe.probeKey('deepseek', {
      keyId: 'keyid-1', key: 'sk-test', endpoint: 'https://api.deepseek.com/v1',
    });

    expect(result.keyId).toBe('keyid-1');
    expect(result.healthy).toBe(true);
    expect(pool.markSuccess).toHaveBeenCalledWith('keyid-1');
  });

  // ── probeKey ──

  test('probeKey() marks healthy on 200', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await probe.probeKey('deepseek', {
      id: 'k1', key: 'sk-test', endpoint: 'https://api.deepseek.com/v1',
    });

    expect(result.healthy).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(pool.markSuccess).toHaveBeenCalledWith('k1');
    expect(pool.markFailure).not.toHaveBeenCalled();
  });

  test('probeKey() marks unhealthy on 401', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });

    const result = await probe.probeKey('openai', {
      id: 'k2', key: 'sk-bad', endpoint: 'https://api.openai.com/v1',
    });

    expect(result.healthy).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.error).toBe('HTTP 401');
    expect(pool.markFailure).toHaveBeenCalledWith('k2', 401, 'HTTP 401');
    expect(pool.markSuccess).not.toHaveBeenCalled();
  });

  test('probeKey() marks unhealthy on 429 rate limit', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 });

    const result = await probe.probeKey('deepseek', {
      id: 'k3', key: 'sk-rl', endpoint: 'https://api.deepseek.com/v1',
    });

    expect(result.healthy).toBe(false);
    expect(result.statusCode).toBe(429);
    expect(pool.markFailure).toHaveBeenCalledWith('k3', 429, 'HTTP 429');
  });

  test('probeKey() handles network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await probe.probeKey('deepseek', {
      id: 'k4', key: 'sk-net', endpoint: 'https://api.deepseek.com/v1',
    });

    expect(result.healthy).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
    expect(pool.markFailure).toHaveBeenCalledWith('k4', 0, 'ECONNREFUSED');
  });

  test('probeKey() handles timeout (AbortError)', async () => {
    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    global.fetch = jest.fn().mockRejectedValue(abortErr);

    const result = await probe.probeKey('openai', {
      id: 'k5', key: 'sk-slow', endpoint: 'https://api.openai.com/v1',
    });

    expect(result.healthy).toBe(false);
    expect(result.error).toBe('Timeout');
    expect(pool.markFailure).toHaveBeenCalledWith('k5', 0, 'Timeout');
  });

  test('probeKey() handles missing endpoint', async () => {
    const result = await probe.probeKey('unknown', {
      id: 'k6', key: 'sk-nope', endpoint: '',
    });

    expect(result.healthy).toBe(false);
    expect(result.error).toBe('No endpoint configured');
    expect(pool.markFailure).toHaveBeenCalled();
  });

  test('probeKey() uses correct health endpoint per provider', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await probe.probeKey('ollama', {
      id: 'ollama-1', key: '', endpoint: 'http://localhost:11434',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.any(Object),
    );

    global.fetch.mockClear();

    await probe.probeKey('deepseek', {
      id: 'ds-1', key: 'sk-ds', endpoint: 'https://api.deepseek.com/v1',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.deepseek.com/v1/v1/models',
      expect.any(Object),
    );
  });

  test('probeKey() sends Authorization header when key is present', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await probe.probeKey('openai', {
      id: 'auth-1', key: 'sk-mykey', endpoint: 'https://api.openai.com',
    });

    const fetchCall = global.fetch.mock.calls[0];
    expect(fetchCall[1].headers).toHaveProperty('Authorization', 'Bearer sk-mykey');
  });

  // ── start / stop ──

  test('start() activates periodic probing', () => {
    jest.useFakeTimers();
    pool.getProviders.mockReturnValue([]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    probe.start({ intervalMs: 1000 });
    expect(probe.isRunning()).toBe(true);

    jest.advanceTimersByTime(3100);

    probe.stop();
    expect(probe.isRunning()).toBe(false);

    jest.useRealTimers();
  });

  test('start() is idempotent', () => {
    jest.useFakeTimers();
    probe.start({ intervalMs: 60000 });
    probe.start({ intervalMs: 60000 }); // should not create second timer
    expect(probe.isRunning()).toBe(true);

    probe.stop();
    expect(probe.isRunning()).toBe(false);
    jest.useRealTimers();
  });

  test('stop() is safe when not started', () => {
    expect(() => probe.stop()).not.toThrow();
    expect(probe.isRunning()).toBe(false);
  });
});
