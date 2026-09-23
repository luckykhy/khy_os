'use strict';

/**
 * aiManagementServer.gatewayCache.test.js — locks the exported pure logic of the
 * gateway read-through cache and the chat request id generator:
 *   - gatewayCacheEnabled / gatewayCacheTtl env contract (default on, 60s TTL,
 *     KHY_GATEWAY_CACHE / KHY_GATEWAY_CACHE_TTL overrides, invalid → 60)
 *   - cachedGatewayPayload: hit short-circuit / miss produce-and-store /
 *     null-value-never-cached / cache-fault-fallthrough / disabled bypass
 *   - writeGatewayCache + invalidateGatewayCache best-effort semantics
 *     (the 'aigw:' invalidation prefix)
 *   - _genChatRequestId shape (req_<ts36>_<seq36>) + monotonic rotation
 * cacheService is stubbed so no Redis / real store is touched; whoever changes
 * the TTL contract or the aigw: prefix goes red first.
 */

jest.mock('../src/services/cacheService', () => ({
  get: jest.fn(async () => null),
  set: jest.fn(async () => {}),
  del: jest.fn(async () => {}),
  clearByPrefix: jest.fn(async () => {}),
  getStats: jest.fn(() => ({ hits: 0, misses: 0 })),
}));

const cacheService = require('../src/services/cacheService');
const { __test__ } = require('../src/services/aiManagementServer');

const {
  cachedGatewayPayload,
  writeGatewayCache,
  invalidateGatewayCache,
  gatewayCacheEnabled,
  gatewayCacheTtl,
  _genChatRequestId,
} = __test__;

const CACHE_ENV = ['KHY_GATEWAY_CACHE', 'KHY_GATEWAY_CACHE_TTL'];
const savedEnv = {};

beforeAll(() => {
  for (const key of CACHE_ENV) {
    if (process.env[key] !== undefined) savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterAll(() => {
  for (const key of CACHE_ENV) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
});

beforeEach(() => {
  cacheService.get.mockClear().mockResolvedValue(null);
  cacheService.set.mockClear().mockResolvedValue(undefined);
  cacheService.clearByPrefix.mockClear().mockResolvedValue(undefined);
  for (const key of CACHE_ENV) delete process.env[key];
});

describe('aiManagementServer gateway read cache — env 契约', () => {
  test('KHY_GATEWAY_CACHE 缺省视为开启；"0" 关闭', () => {
    expect(gatewayCacheEnabled()).toBe(true);
    process.env.KHY_GATEWAY_CACHE = '0';
    expect(gatewayCacheEnabled()).toBe(false);
    process.env.KHY_GATEWAY_CACHE = '1';
    expect(gatewayCacheEnabled()).toBe(true);
  });

  test('KHY_GATEWAY_CACHE_TTL 合法值生效，缺省 60 秒', () => {
    expect(gatewayCacheTtl()).toBe(60);
    process.env.KHY_GATEWAY_CACHE_TTL = '90';
    expect(gatewayCacheTtl()).toBe(90);
  });

  test('KHY_GATEWAY_CACHE_TTL 非法值（非数字 / 0 / 负数）回退 60 秒', () => {
    for (const bad of ['abc', '0', '-5', '']) {
      process.env.KHY_GATEWAY_CACHE_TTL = bad;
      expect(gatewayCacheTtl()).toBe(60);
    }
  });
});

describe('aiManagementServer cachedGatewayPayload — 读穿透语义', () => {
  test('缓存命中 → 直接返回，producer 不被调用', async () => {
    cacheService.get.mockResolvedValueOnce({ cached: true });
    const producer = jest.fn(async () => 'live');
    const out = await cachedGatewayPayload('aigw:x', producer);
    expect(out).toEqual({ cached: true });
    expect(producer).not.toHaveBeenCalled();
  });

  test('缓存未命中 → 跑 producer 并回写 (key, value, ttl=60)', async () => {
    const producer = jest.fn(async () => ({ fresh: 1 }));
    const out = await cachedGatewayPayload('aigw:x', producer);
    expect(out).toEqual({ fresh: 1 });
    expect(producer).toHaveBeenCalledTimes(1);
    expect(cacheService.set).toHaveBeenCalledTimes(1);
    expect(cacheService.set).toHaveBeenCalledWith('aigw:x', { fresh: 1 }, 60);
  });

  test('producer 返回 null → 不写缓存（避免掩盖未命中），结果透传 null', async () => {
    const producer = jest.fn(async () => null);
    const out = await cachedGatewayPayload('aigw:x', producer);
    expect(out).toBeNull();
    expect(cacheService.set).not.toHaveBeenCalled();
  });

  test('缓存读取抛错 → 落到实时 producer（缓存故障不破坏请求）', async () => {
    cacheService.get.mockRejectedValueOnce(new Error('redis down'));
    const producer = jest.fn(async () => 'live');
    const out = await cachedGatewayPayload('aigw:x', producer);
    expect(out).toBe('live');
  });

  test('KHY_GATEWAY_CACHE=0 → 完全绕过缓存（get/set 均不调用）', async () => {
    process.env.KHY_GATEWAY_CACHE = '0';
    const producer = jest.fn(async () => 'live');
    const out = await cachedGatewayPayload('aigw:x', producer);
    expect(out).toBe('live');
    expect(cacheService.get).not.toHaveBeenCalled();
    expect(cacheService.set).not.toHaveBeenCalled();
  });
});

describe('aiManagementServer 缓存写入 / 失效', () => {
  test('writeGatewayCache 开启时写入指定 key', async () => {
    await writeGatewayCache('aigw:catalog', { n: 1 });
    expect(cacheService.set).toHaveBeenCalledWith('aigw:catalog', { n: 1 }, 60);
  });

  test('writeGatewayCache 关闭或值为 null → 不写', async () => {
    await writeGatewayCache('aigw:catalog', null);
    expect(cacheService.set).not.toHaveBeenCalled();
    cacheService.set.mockClear();
    process.env.KHY_GATEWAY_CACHE = '0';
    await writeGatewayCache('aigw:catalog', { n: 1 });
    expect(cacheService.set).not.toHaveBeenCalled();
  });

  test('invalidateGatewayCache 按 aigw: 前缀清空（开）；关闭时不动', async () => {
    await invalidateGatewayCache();
    expect(cacheService.clearByPrefix).toHaveBeenCalledWith('aigw:');
    cacheService.clearByPrefix.mockClear();
    process.env.KHY_GATEWAY_CACHE = '0';
    await invalidateGatewayCache();
    expect(cacheService.clearByPrefix).not.toHaveBeenCalled();
  });

  test('invalidateGatewayCache 底层抛错被吞（best-effort，不炸调用方）', async () => {
    cacheService.clearByPrefix.mockRejectedValueOnce(new Error('boom'));
    await expect(invalidateGatewayCache()).resolves.toBeUndefined();
  });
});

describe('aiManagementServer _genChatRequestId — 会话关联 id', () => {
  test('形状 req_<ts36>_<seq36>，连续两次不重复', () => {
    const a = _genChatRequestId();
    const b = _genChatRequestId();
    expect(a).toMatch(/^req_[0-9a-z]+_[0-9a-z]+$/);
    expect(b).toMatch(/^req_[0-9a-z]+_[0-9a-z]+$/);
    expect(a).not.toBe(b, '连续两个 request id 必须不同');
  });
});
