'use strict';

/**
 * Tests for the s19 fix: MCP external tools wired end-to-end into the tool pool.
 *
 * Covers the two gaps this fix closes:
 *   1. normalize_mcp_name + annotation mapping in the naming authority
 *      (serializeTool): qualified `mcp__server__tool` names are collision/
 *      injection-safe, the raw tool name is preserved for dispatch, and MCP
 *      readOnly/destructive hints map to registry permission flags.
 *   2. The assemble_tool_pool bridge (toolPool.syncMcpToolsToRegistry): connected
 *      servers' tools become first-class CALLABLE registry tools whose execute()
 *      dispatches to the owning client with the ORIGINAL tool name, and the MCP
 *      partition is rebuilt on every sync so disconnected tools disappear.
 *
 * Everything runs against fakes — no subprocess, no network.
 */

const assert = require('assert');

const { normalizeMcpName, serializeTool } = require('../src/services/mcp/types');
const { syncMcpToolsToRegistry, annotateDescription, refreshMcpToolPool } = require('../src/services/mcp/toolPool');

// ── Fakes ───────────────────────────────────────────────────────────────────

function fakeClient(name, toolDefs) {
  return {
    name,
    calls: [],
    listTools() { return toolDefs.map((t) => serializeTool(name, t)); },
    async callTool(toolName, args) {
      this.calls.push({ toolName, args });
      return { ok: true, toolName, args };
    },
  };
}

function fakeManager(clients) {
  const map = new Map(clients.map((c) => [c.name, c]));
  return {
    getConnectedServers() { return [...map.keys()]; },
    getClient(n) { return map.get(n); },
  };
}

function fakeRegistry() {
  const m = new Map();
  return {
    _m: m,
    register(tool) { m.set(tool.name, tool); },
    clearMcpTools() { m.clear(); },
    getMcpToolNames() { return [...m.keys()]; },
    get(n) { return m.get(n); },
  };
}

describe('s19 — normalizeMcpName', () => {
  test('preserves the allowed charset and replaces everything else with _', () => {
    assert.strictEqual(normalizeMcpName('read_file-2'), 'read_file-2');
    assert.strictEqual(normalizeMcpName('my.server'), 'my_server');
    assert.strictEqual(normalizeMcpName('a b/c:d'), 'a_b_c_d');
    assert.strictEqual(normalizeMcpName('jira!@#'), 'jira___');
    assert.strictEqual(normalizeMcpName(null), '');
  });
});

describe('s19 — serializeTool naming + annotation mapping', () => {
  test('normalizes both segments and keeps the original tool name for dispatch', () => {
    const s = serializeTool('my.docs', { name: 'read:file', description: 'Read a file' });
    assert.strictEqual(s.name, 'mcp__my_docs__read_file');
    assert.strictEqual(s.originalToolName, 'read:file', 'raw name retained for dispatch');
    assert.strictEqual(s.normalizedServerName, 'my_docs');
    assert.strictEqual(s.isMcp, true);
  });

  test('maps readOnly/destructive hints to permission flags (explicit only)', () => {
    const ro = serializeTool('docs', { name: 'search', annotations: { readOnlyHint: true } });
    assert.strictEqual(ro.isReadOnly, true);
    assert.strictEqual(ro.isDestructive, false);

    const de = serializeTool('deploy', { name: 'trigger', annotations: { destructiveHint: true } });
    assert.strictEqual(de.isDestructive, true);
    assert.strictEqual(de.isReadOnly, false);

    const none = serializeTool('x', { name: 'y' });
    assert.strictEqual(none.isReadOnly, false);
    assert.strictEqual(none.isDestructive, false);
  });
});

describe('s19 — annotateDescription', () => {
  test('appends the annotation, readOnly winning over destructive', () => {
    assert.strictEqual(annotateDescription('Search', { isReadOnly: true }), 'Search (readOnly)');
    assert.strictEqual(annotateDescription('Deploy', { isDestructive: true }), 'Deploy (destructive)');
    assert.strictEqual(annotateDescription('Plain', {}), 'Plain');
  });
});

describe('s19 — syncMcpToolsToRegistry (assemble_tool_pool bridge)', () => {
  test('registers connected tools under the qualified mcp__ name', () => {
    const reg = fakeRegistry();
    const res = syncMcpToolsToRegistry({
      manager: fakeManager([fakeClient('docs', [{ name: 'search' }])]),
      registry: reg,
    });
    assert.deepStrictEqual(res.registered, ['mcp__docs__search']);
    assert.ok(reg.get('mcp__docs__search'));
  });

  test('execute() dispatches to the owning client with the ORIGINAL tool name', async () => {
    const client = fakeClient('docs', [{ name: 'read:file' }]); // normalized != original
    const reg = fakeRegistry();
    syncMcpToolsToRegistry({ manager: fakeManager([client]), registry: reg });

    const tool = reg.get('mcp__docs__read_file');
    assert.ok(tool, 'tool registered under normalized name');
    const out = await tool.execute({ path: '/etc/hosts' });

    assert.strictEqual(client.calls.length, 1);
    assert.strictEqual(client.calls[0].toolName, 'read:file', 'dispatched with raw name, not normalized');
    assert.deepStrictEqual(client.calls[0].args, { path: '/etc/hosts' });
    assert.strictEqual(out.ok, true);
  });

  test('carries the permission annotation into the registered description', () => {
    const reg = fakeRegistry();
    syncMcpToolsToRegistry({
      manager: fakeManager([fakeClient('deploy', [
        { name: 'trigger', description: 'Trigger a deploy', annotations: { destructiveHint: true } },
      ])]),
      registry: reg,
    });
    const tool = reg.get('mcp__deploy__trigger');
    assert.ok(/\(destructive\)$/.test(tool.description));
    assert.strictEqual(tool.isDestructive, true);
  });

  test('rebuilds the pool each sync — a disconnected server drops its tools', () => {
    const docs = fakeClient('docs', [{ name: 'search' }]);
    const deploy = fakeClient('deploy', [{ name: 'trigger' }]);
    const reg = fakeRegistry();

    syncMcpToolsToRegistry({ manager: fakeManager([docs, deploy]), registry: reg });
    assert.ok(reg.get('mcp__docs__search'));
    assert.ok(reg.get('mcp__deploy__trigger'));

    // deploy disconnects -> only docs remains connected.
    syncMcpToolsToRegistry({ manager: fakeManager([docs]), registry: reg });
    assert.ok(reg.get('mcp__docs__search'), 'still-connected tool kept');
    assert.strictEqual(reg.get('mcp__deploy__trigger'), undefined, 'stale tool removed on rebuild');
  });

  test('two servers with same-named tools never collide (server-prefixed)', () => {
    const reg = fakeRegistry();
    syncMcpToolsToRegistry({
      manager: fakeManager([
        fakeClient('jira', [{ name: 'search' }]),
        fakeClient('notion', [{ name: 'search' }]),
      ]),
      registry: reg,
    });
    assert.ok(reg.get('mcp__jira__search'));
    assert.ok(reg.get('mcp__notion__search'));
  });
});

describe('s20 — refreshMcpToolPool (per-turn loop slot)', () => {
  test('no servers connected and nothing registered → cheap no-op', () => {
    const reg = fakeRegistry();
    const res = refreshMcpToolPool({ manager: fakeManager([]), registry: reg });
    assert.strictEqual(res.refreshed, false);
    assert.deepStrictEqual(res.registered, []);
    assert.strictEqual(reg._m.size, 0);
  });

  test('connected servers → syncs their tools into the pool', () => {
    const reg = fakeRegistry();
    const res = refreshMcpToolPool({
      manager: fakeManager([fakeClient('docs', [{ name: 'search' }])]),
      registry: reg,
    });
    assert.strictEqual(res.refreshed, true);
    assert.deepStrictEqual(res.registered, ['mcp__docs__search']);
    assert.ok(reg.get('mcp__docs__search'));
  });

  test('a disconnect drops stale MCP tools left from a prior turn', () => {
    const reg = fakeRegistry();
    // Turn 1: docs connected → tool registered.
    refreshMcpToolPool({ manager: fakeManager([fakeClient('docs', [{ name: 'search' }])]), registry: reg });
    assert.ok(reg.get('mcp__docs__search'));

    // Turn 2: nothing connected → stale tool cleared.
    const res = refreshMcpToolPool({ manager: fakeManager([]), registry: reg });
    assert.strictEqual(res.refreshed, true, 'cleared stale partition');
    assert.strictEqual(reg.get('mcp__docs__search'), undefined);
    assert.strictEqual(reg._m.size, 0);
  });

  test('never throws — a broken manager degrades to a no-op result', () => {
    const brokenManager = {
      getConnectedServers() { throw new Error('boom'); },
    };
    let res;
    assert.doesNotThrow(() => {
      res = refreshMcpToolPool({ manager: brokenManager, registry: fakeRegistry() });
    });
    assert.strictEqual(res.refreshed, false);
    assert.deepStrictEqual(res.registered, []);
  });
});

describe('s19 — integration with the real tool registry', () => {
  const realRegistry = require('../src/tools');

  afterEach(() => realRegistry.reload());

  test('synced MCP tools become visible and callable in the real registry', () => {
    syncMcpToolsToRegistry({
      manager: fakeManager([fakeClient('docs', [{ name: 'search' }])]),
      registry: realRegistry,
    });

    assert.ok(realRegistry.get('mcp__docs__search'), 'registered into the live registry');
    assert.ok(realRegistry.getMcpToolNames().includes('mcp__docs__search'));
    assert.ok(realRegistry.assembleToolPool([]).has('mcp__docs__search'),
      'included in the assembled tool pool the agent loop sees');
  });

  test('clearMcpTools removes only the MCP partition, not built-ins', () => {
    const builtInCount = realRegistry.getMcpToolNames().length;
    assert.strictEqual(builtInCount, 0, 'no MCP tools before sync');
    syncMcpToolsToRegistry({
      manager: fakeManager([fakeClient('docs', [{ name: 'search' }])]),
      registry: realRegistry,
    });
    assert.strictEqual(realRegistry.getMcpToolNames().length, 1);
    realRegistry.clearMcpTools();
    assert.strictEqual(realRegistry.getMcpToolNames().length, 0);
    // A built-in tool still resolves after clearing the MCP partition.
    assert.ok(realRegistry.count() > 0);
  });
});
