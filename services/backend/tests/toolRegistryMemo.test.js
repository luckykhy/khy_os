'use strict';

// Deterministic tests for toolRegistry.getAll() memoization (KHY_TOOL_REGISTRY_MEMO).
// Covers: cache reuse when no writes occurred, invalidation on register /
// clearMcpTools / reload, and byte-identical legacy fallback when the gate is off.

const test = require('node:test');
const assert = require('node:assert');

const registry = require('../src/tools');

function withMemo(value, fn) {
  const prev = process.env.KHY_TOOL_REGISTRY_MEMO;
  if (value === undefined) delete process.env.KHY_TOOL_REGISTRY_MEMO;
  else process.env.KHY_TOOL_REGISTRY_MEMO = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KHY_TOOL_REGISTRY_MEMO;
    else process.env.KHY_TOOL_REGISTRY_MEMO = prev;
  }
}

test('two consecutive getAll() calls return the SAME cached Map when no writes occurred', () => {
  withMemo('1', () => {
    const a = registry.getAll();
    const b = registry.getAll();
    assert.strictEqual(a, b, 'cache hit returns identical Map reference');
    assert.ok(a.size > 1, 'registry is populated');
  });
});

test('register() invalidates the cache and surfaces the new tool', () => {
  withMemo('1', () => {
    const before = registry.getAll();
    const name = '__memo_probe_tool__';
    registry.register({
      name,
      description: 'memo test probe',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ ok: true }),
    });
    const after = registry.getAll();
    assert.notStrictEqual(after, before, 'register() rebuilt the cache (new reference)');
    assert.ok(after.has(name), 'new tool is visible after register()');
    // A follow-up call with no further writes returns the cached reference again.
    assert.strictEqual(registry.getAll(), after, 'cache stabilizes after the write');
  });
});

test('clearMcpTools() invalidates the cache', () => {
  withMemo('1', () => {
    const name = '__memo_probe_mcp__';
    registry.register(
      {
        name,
        description: 'memo mcp probe',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({ ok: true }),
      },
      { isMcp: true }
    );
    const withMcp = registry.getAll();
    assert.ok(withMcp.has(name), 'mcp tool present before clear');
    registry.clearMcpTools();
    const afterClear = registry.getAll();
    assert.notStrictEqual(afterClear, withMcp, 'clearMcpTools() rebuilt the cache');
    assert.ok(!afterClear.has(name), 'mcp tool gone after clearMcpTools()');
  });
});

test('reload() invalidates the cache (stale reference is not returned)', () => {
  withMemo('1', () => {
    const before = registry.getAll();
    registry.reload();
    const after = registry.getAll();
    assert.notStrictEqual(after, before, 'reload() forced a fresh merged Map');
    assert.ok(after.size > 1, 'registry repopulated after reload');
  });
});

test('gate off (KHY_TOOL_REGISTRY_MEMO=0) rebuilds a fresh Map every call', () => {
  withMemo('0', () => {
    const a = registry.getAll();
    const b = registry.getAll();
    assert.notStrictEqual(a, b, 'each call is a distinct Map when memo disabled');
    // Content must still be equivalent (byte-identical legacy behaviour).
    assert.deepStrictEqual([...a.keys()].sort(), [...b.keys()].sort(), 'same tool set');
  });
});

test('off tokens off/false/no also disable memoization', () => {
  for (const token of ['off', 'false', 'no', 'OFF']) {
    withMemo(token, () => {
      const a = registry.getAll();
      const b = registry.getAll();
      assert.notStrictEqual(a, b, `token "${token}" disables memo`);
    });
  }
});
