'use strict';

/**
 * MCP progressive-disclosure tests (TDD red first).
 *
 * Borrowed conclusion (proposal 2026-09-18-tier1-minimax-code #2): when the
 * serialized MCP tool directory would exceed threshold × context window, the
 * whole MCP partition is deferred (revealed on demand via the existing
 * toolSearch/ensureTool machinery); below the threshold it stays inline.
 * No new invoke-gate tool is introduced (B-U5: extend canonical).
 */

const {
  planMcpDisclosure,
  estimateToolTokens,
  DEFAULT_THRESHOLD_PCT,
} = require('../../src/services/domain/messaging/mcp/mcpDisclosurePlan');
const {
  buildCallableTool,
  syncMcpToolsToRegistry,
  refreshMcpToolPool,
} = require('../../src/services/domain/messaging/mcp/toolPool');

function serializedTool(i, schemaKB = 0) {
  return {
    name: `mcp__srv__tool${i}`,
    originalToolName: `tool${i}`,
    description: `does thing ${i}`,
    inputJSONSchema: schemaKB
      ? { type: 'object', properties: { blob: { type: 'string', default: 'x'.repeat(schemaKB * 1024) } } }
      : { type: 'object', properties: {} },
    isReadOnly: true,
  };
}

function makeFakeRegistry() {
  const registered = [];
  return {
    registered,
    register(def, meta) { registered.push({ def, meta }); },
    clearMcpTools() { registered.length = 0; },
    getMcpToolNames() { return registered.map((r) => r.def.name); },
  };
}

function makeFakeManager(toolsByServer) {
  return {
    getConnectedServers: () => Object.keys(toolsByServer),
    getClient: (server) => {
      const tools = toolsByServer[server] || [];
      return {
        listTools: () => tools,
        callTool: async (name, params) => ({ ok: true, name, params }),
      };
    },
  };
}

describe('estimateToolTokens', () => {
  test('grows monotonically with serialized directory size', () => {
    const small = estimateToolTokens([serializedTool(1)]);
    const big = estimateToolTokens([serializedTool(1), ...Array.from({ length: 20 }, (_, i) => serializedTool(i, 8))]);
    expect(big).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0);
  });
});

describe('planMcpDisclosure', () => {
  test('small directory stays inline', () => {
    const plan = planMcpDisclosure({ toolCount: 3, estTokens: 500, contextWindowTokens: 200_000 });
    expect(plan.mode).toBe('inline');
    expect(plan.thresholdPct).toBe(DEFAULT_THRESHOLD_PCT);
  });

  test('directory over threshold×window is deferred', () => {
    const plan = planMcpDisclosure({ toolCount: 200, estTokens: 40_000, contextWindowTokens: 100_000 });
    // budget = 0.15 * 100k = 15k < 40k → defer
    expect(plan.mode).toBe('deferred');
    expect(plan.budgetTokens).toBe(15_000);
  });

  test('zero/absent window falls back conservatively without throwing', () => {
    const plan = planMcpDisclosure({ toolCount: 50, estTokens: 5000, contextWindowTokens: 0 });
    expect(['inline', 'deferred']).toContain(plan.mode);
    expect(plan.budgetTokens).toBeGreaterThan(0);
  });

  test('disabled gate keeps everything inline regardless of size', () => {
    const plan = planMcpDisclosure(
      { toolCount: 999, estTokens: 9_999_999, contextWindowTokens: 1000 },
      { enabled: false },
    );
    expect(plan.mode).toBe('inline');
  });
});

describe('toolPool wiring', () => {
  test('buildCallableTool marks shouldDefer only when told', () => {
    const client = { callTool: async () => ({}) };
    const plain = buildCallableTool(serializedTool(1), client);
    const deferred = buildCallableTool(serializedTool(1), client, { shouldDefer: true });
    expect(plain.shouldDefer).toBeFalsy();
    expect(deferred.shouldDefer).toBe(true);
  });

  test('oversized MCP directory registers tools with shouldDefer', () => {
    const registry = makeFakeRegistry();
    const prev = process.env.KHY_MCP_DISCLOSURE_WINDOW;
    process.env.KHY_MCP_DISCLOSURE_WINDOW = '10000'; // tiny window → forces defer
    try {
      const tools = Array.from({ length: 30 }, (_, i) => serializedTool(i, 4));
      const res = syncMcpToolsToRegistry({
        manager: makeFakeManager({ srv: tools }),
        registry,
      });
      expect(res.disclosure.mode).toBe('deferred');
      expect(registry.registered.length).toBe(30);
      expect(registry.registered.every((r) => r.def.shouldDefer === true)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.KHY_MCP_DISCLOSURE_WINDOW;
      else process.env.KHY_MCP_DISCLOSURE_WINDOW = prev;
    }
  });

  test('small directory registers without shouldDefer', () => {
    const registry = makeFakeRegistry();
    const res = syncMcpToolsToRegistry({
      manager: makeFakeManager({ srv: [serializedTool(1), serializedTool(2)] }),
      registry,
      contextWindowTokens: 200_000,
    });
    expect(res.disclosure.mode).toBe('inline');
    expect(registry.registered.every((r) => !r.def.shouldDefer)).toBe(true);
  });

  test('refreshMcpToolPool never throws and reports disclosure mode', () => {
    const registry = makeFakeRegistry();
    const res = refreshMcpToolPool({
      manager: makeFakeManager({ srv: [serializedTool(1)] }),
      registry,
      contextWindowTokens: 200_000,
    });
    expect(res.refreshed).toBe(true);
    expect(res.disclosure.mode).toBe('inline');
  });
});
