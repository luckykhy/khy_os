// Unit tests for the gateway read-through cache helpers in aiManagementServer.
// These back the catalog/model-list GET caching that cuts first-load burden.
// With no Redis reachable, cacheService transparently falls back to an in-process
// Map, so these tests are deterministic without external infrastructure.

const { __test__ } = require('../../src/services/aiManagementServer');
const {
  cachedGatewayPayload,
  writeGatewayCache,
  invalidateGatewayCache,
  gatewayCacheEnabled,
  gatewayCacheTtl,
} = __test__;

// Unique key per test run so the shared memory cache never collides across cases.
let counter = 0;
function freshKey() {
  counter += 1;
  return `aigw:test:${process.pid}:${counter}`;
}

describe('gateway read-through cache', () => {
  const savedEnabled = process.env.KHY_GATEWAY_CACHE;
  const savedTtl = process.env.KHY_GATEWAY_CACHE_TTL;

  afterEach(() => {
    if (savedEnabled === undefined) delete process.env.KHY_GATEWAY_CACHE;
    else process.env.KHY_GATEWAY_CACHE = savedEnabled;
    if (savedTtl === undefined) delete process.env.KHY_GATEWAY_CACHE_TTL;
    else process.env.KHY_GATEWAY_CACHE_TTL = savedTtl;
  });

  test('read-through runs the producer once, then serves from cache', async () => {
    const key = freshKey();
    let calls = 0;
    const producer = async () => { calls += 1; return { n: calls }; };

    const first = await cachedGatewayPayload(key, producer);
    const second = await cachedGatewayPayload(key, producer);

    expect(first).toEqual({ n: 1 });
    expect(second).toEqual({ n: 1 }); // cached — producer not re-run
    expect(calls).toBe(1);
  });

  test('invalidate forces the next read to recompute', async () => {
    const key = freshKey();
    let calls = 0;
    const producer = async () => { calls += 1; return { n: calls }; };

    await cachedGatewayPayload(key, producer);
    await invalidateGatewayCache();
    const after = await cachedGatewayPayload(key, producer);

    expect(after).toEqual({ n: 2 });
    expect(calls).toBe(2);
  });

  test('writeGatewayCache warms a key so a later read skips the producer', async () => {
    const key = freshKey();
    let calls = 0;
    const producer = async () => { calls += 1; return { from: 'producer' }; };

    await writeGatewayCache(key, { from: 'live' });
    const got = await cachedGatewayPayload(key, producer);

    expect(got).toEqual({ from: 'live' });
    expect(calls).toBe(0);
  });

  test('null payloads are never cached (a miss must not be masked)', async () => {
    const key = freshKey();
    let calls = 0;
    const producer = async () => { calls += 1; return calls === 1 ? null : { n: calls }; };

    const first = await cachedGatewayPayload(key, producer);
    const second = await cachedGatewayPayload(key, producer);

    expect(first).toBeNull();
    expect(second).toEqual({ n: 2 }); // re-ran because null was not stored
    expect(calls).toBe(2);
  });

  test('disabled cache always runs the producer and stores nothing', async () => {
    process.env.KHY_GATEWAY_CACHE = '0';
    expect(gatewayCacheEnabled()).toBe(false);

    const key = freshKey();
    let calls = 0;
    const producer = async () => { calls += 1; return { n: calls }; };

    await cachedGatewayPayload(key, producer);
    await cachedGatewayPayload(key, producer);
    expect(calls).toBe(2); // no caching while disabled
  });

  test('ttl is env-driven with a sane default', () => {
    delete process.env.KHY_GATEWAY_CACHE_TTL;
    expect(gatewayCacheTtl()).toBe(60);
    process.env.KHY_GATEWAY_CACHE_TTL = '120';
    expect(gatewayCacheTtl()).toBe(120);
    process.env.KHY_GATEWAY_CACHE_TTL = 'garbage';
    expect(gatewayCacheTtl()).toBe(60); // invalid → default
  });
});
