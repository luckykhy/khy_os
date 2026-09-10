'use strict';
// Deterministic tests for toolRegistry.getAll() memoization (KHY_TOOL_REGISTRY_MEMO).
// Covers: cache reuse when no writes occurred, invalidation on register /
// clearMcpTools / reload, and byte-identical legacy fallback when the gate is off.
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

describe('Tool Registry Memo', () => {
  test('two consecutive getAll() calls return the SAME cached Map when no writes occurred', async () => {
      withMemo('1', () => {
        const a = registry.getAll();
        const b = registry.getAll();
        expect(a).toBe(b, 'cache hit returns identical Map reference');
        expect(a.size > 1).toBeTruthy();
      });
  });

  test('register() invalidates the cache and surfaces the new tool', async () => {
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
        expect(after).not.toBe(before, 'register() rebuilt the cache (new reference)');
        expect(after.has(name)).toBeTruthy();
        // A follow-up call with no further writes returns the cached reference again.
        expect(registry.getAll()).toBe(after, 'cache stabilizes after the write');
      });
  });

  test('clearMcpTools() invalidates the cache', async () => {
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
        expect(withMcp.has(name)).toBeTruthy();
        registry.clearMcpTools();
        const afterClear = registry.getAll();
        expect(afterClear).not.toBe(withMcp, 'clearMcpTools() rebuilt the cache');
        expect(!afterClear.has(name)).toBeTruthy();
      });
  });

  test('reload() invalidates the cache (stale reference is not returned)', async () => {
      withMemo('1', () => {
        const before = registry.getAll();
        registry.reload();
        const after = registry.getAll();
        expect(after).not.toBe(before, 'reload() forced a fresh merged Map');
        expect(after.size > 1).toBeTruthy();
      });
  });

  test('gate off (KHY_TOOL_REGISTRY_MEMO=0) rebuilds a fresh Map every call', async () => {
      withMemo('0', () => {
        const a = registry.getAll();
        const b = registry.getAll();
        expect(a).not.toBe(b, 'each call is a distinct Map when memo disabled');
        // Content must still be equivalent (byte-identical legacy behaviour).
        expect([...a.keys()].sort()).toEqual([...b.keys()].sort(), 'same tool set');
      });
  });

  test('off tokens off/false/no also disable memoization', async () => {
      for (const token of ['off', 'false', 'no', 'OFF']) {
        withMemo(token, () => {
          const a = registry.getAll();
          const b = registry.getAll();
          expect(a).not.toBe(b, `token "${token}" disables memo`);
        });
      }
  });

});

