'use strict';

/**
 * assembleToolPool stability regressions (prompt-cache-order protection).
 *
 * Guards three invariants of src/tools/index.js#assembleToolPool:
 *   1. Sequence stability — under identical conditions, repeated calls yield
 *      an element-wise identical tool-name sequence (not just set equality).
 *   2. Built-in wins — an MCP tool colliding with a built-in name never
 *      shadows the built-in, and the built-in partition's relative order is
 *      unaffected by MCP tool registration/removal.
 *   3. Memoization equivalence — KHY_TOOL_ASSEMBLE_POOL_MEMO on/off produce
 *      equivalent name sequences, and the memo invalidates on _toolsVersion
 *      bumps (e.g. after registering a new tool).
 *
 * Isolation notes:
 *   - The registry is a module-level singleton; every test gets a fresh
 *     instance via jest.resetModules() + a controlled require, so no test
 *     pollutes another (or the real process-wide registry).
 *   - Data home is hermetic: jest.taskStoreIsolation.setup.js pins
 *     KHY_DATA_HOME to a throwaway temp dir per test file, so loadDenyRules()
 *     never reads the real ~/.khy/tool_deny_rules.json.
 *   - The memo gate env var is saved/restored around every test.
 */

const MEMO_ENV = 'KHY_TOOL_ASSEMBLE_POOL_MEMO';

let savedMemoEnv;

beforeEach(() => {
  savedMemoEnv = Object.prototype.hasOwnProperty.call(process.env, MEMO_ENV)
    ? process.env[MEMO_ENV]
    : undefined;
});

afterEach(() => {
  if (savedMemoEnv === undefined) delete process.env[MEMO_ENV];
  else process.env[MEMO_ENV] = savedMemoEnv;
});

/** Fresh registry instance — resets the module-level singleton per scenario. */
function freshRegistry() {
  jest.resetModules();
  // eslint-disable-next-line global-require
  return require('../../src/tools/index.js');
}

function setMemo(value) {
  if (value === undefined) delete process.env[MEMO_ENV];
  else process.env[MEMO_ENV] = value;
}

/** Tool-name sequence in pool iteration order (order matters — no sorting). */
function poolNames(reg, profileId) {
  return [...reg.assembleToolPool(undefined, profileId).keys()];
}

/** Minimal MCP stub definition registered through the public register() API. */
function registerMcpStub(reg, name, description) {
  reg.register(
    {
      name,
      description: description || `mcp stub ${name}`,
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ success: true }),
    },
    { isMcp: true }
  );
}

describe('assembleToolPool sequence stability', () => {
  test('memo off: 10 consecutive rebuilds return an element-wise identical name sequence', () => {
    setMemo('0');
    const reg = freshRegistry();
    const first = poolNames(reg);
    expect(first.length).toBeGreaterThan(0);
    for (let i = 0; i < 9; i++) {
      // toEqual on arrays is element-wise (order-sensitive), not set equality.
      expect(poolNames(reg)).toEqual(first);
    }
  });

  test('memo on: 10 consecutive calls return an element-wise identical name sequence', () => {
    setMemo('1');
    const reg = freshRegistry();
    reg._resetAssemblePoolMemo();
    const first = poolNames(reg);
    for (let i = 0; i < 9; i++) {
      expect(poolNames(reg)).toEqual(first);
    }
  });
});

describe('assembleToolPool built-in priority over same-name MCP tools', () => {
  test('built-in wins on name collision, and built-in partition order survives MCP add/remove', () => {
    setMemo('0'); // force genuine rebuilds; memoization is covered separately
    const reg = freshRegistry();

    // Baseline: built-in partition only (fresh registry has no MCP tools,
    // but compute defensively against pre-registered MCP names).
    const preMcp = new Set(reg.getMcpToolNames());
    const baseline = poolNames(reg).filter((n) => !preMcp.has(n));
    expect(baseline.length).toBeGreaterThan(0);

    const collidingName = baseline[0];
    const builtinTool = reg.assembleToolPool().get(collidingName);
    expect(builtinTool).toBeDefined();

    // Register a same-name MCP stub plus a uniquely-named MCP stub.
    const MARKER = 'MCP_SHADOW_ATTEMPT_MARKER';
    const uniqueMcpName = 'zzz_pool_stability_mcp_stub';
    registerMcpStub(reg, collidingName, MARKER);
    registerMcpStub(reg, uniqueMcpName);

    const pool = reg.assembleToolPool();

    // uniqBy(name): the colliding entry must still be the built-in object.
    expect(pool.get(collidingName)).toBe(builtinTool);
    expect(pool.get(collidingName).description).not.toBe(MARKER);

    // The unique MCP stub is present.
    expect(pool.has(uniqueMcpName)).toBe(true);

    // Partitioned ordering: the built-in prefix is byte-identical to baseline —
    // MCP additions never reorder or interleave with the built-in partition.
    const namesWithMcp = [...pool.keys()];
    expect(namesWithMcp.slice(0, baseline.length)).toEqual(baseline);

    // MCP removal restores the exact baseline sequence.
    reg.clearMcpTools();
    expect(poolNames(reg)).toEqual(baseline);
  });
});

describe('assembleToolPool memoization equivalence and invalidation', () => {
  test('memo on and memo off produce equivalent name sequences', () => {
    const reg = freshRegistry();

    setMemo('0');
    const offNames = poolNames(reg);

    setMemo('1');
    reg._resetAssemblePoolMemo();
    const onNames = poolNames(reg);

    expect(onNames).toEqual(offNames);

    // Sanity: memo on actually caches (same Map reference on repeat call).
    const a = reg.assembleToolPool();
    const b = reg.assembleToolPool();
    expect(b).toBe(a);
    expect(reg._assemblePoolMemoSize()).toBe(1);
  });

  test('memo invalidates on _toolsVersion bump (new tool registration) and stays equivalent to rebuild', () => {
    setMemo('1');
    const reg = freshRegistry();
    reg._resetAssemblePoolMemo();

    const before = reg.assembleToolPool();
    const keyBefore = reg._assemblePoolCacheKey(undefined);
    const stubName = 'zzz_pool_memo_invalidation_stub';
    expect(before.has(stubName)).toBe(false);

    // Registering a tool bumps _toolsVersion → the cache key must change.
    registerMcpStub(reg, stubName);
    const keyAfter = reg._assemblePoolCacheKey(undefined);
    expect(keyAfter).not.toBe(keyBefore);

    // The memoized path must recompute, not return the stale Map.
    const after = reg.assembleToolPool();
    expect(after).not.toBe(before);
    expect(after.has(stubName)).toBe(true);

    // Recomputed memoized result must match a memo-off fresh rebuild.
    const afterNames = [...after.keys()];
    setMemo('0');
    expect(poolNames(reg)).toEqual(afterNames);
  });
});
