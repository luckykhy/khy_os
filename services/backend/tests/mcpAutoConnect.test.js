'use strict';

/**
 * Tests for the MCP auto-connect leaf (services/mcp/autoConnect.js) — the
 * runtime trigger that was missing, leaving configured external MCP servers
 * unreachable. All scenarios use a fake manager + injected latch state; no
 * subprocess, no network.
 */

const test = require('node:test');
const assert = require('node:assert');

const { ensureMcpConnected, autoConnectEnabled } = require('../src/services/mcp/autoConnect');

/** Build a fake MCP manager recording connectAll calls. */
function makeManager({ servers = [], connectResult, connectThrows = false } = {}) {
  const calls = { connectAll: 0, loadConfig: 0, projectDirs: [] };
  return {
    calls,
    loadConfig(projectDir) {
      calls.loadConfig++;
      calls.projectDirs.push(projectDir);
      const mcpServers = {};
      for (const name of servers) mcpServers[name] = { command: 'echo', args: [name] };
      return { mcpServers };
    },
    async connectAll(projectDir) {
      calls.connectAll++;
      if (connectThrows) throw new Error('spawn failed');
      return connectResult || { connected: servers, failed: [] };
    },
  };
}

function freshState() { return { started: false }; }

test('gate ON + configured servers → connectAll invoked, returns connected', async () => {
  const manager = makeManager({ servers: ['fs', 'git'] });
  const res = await ensureMcpConnected({
    manager, env: {}, projectDir: '/proj', state: freshState(),
  });
  assert.strictEqual(manager.calls.connectAll, 1);
  assert.deepStrictEqual(res.connected, ['fs', 'git']);
  assert.deepStrictEqual(manager.calls.projectDirs[0], '/proj');
});

test('gate OFF (KHY_MCP_AUTOCONNECT=false) → connectAll NEVER invoked (legacy)', async () => {
  const manager = makeManager({ servers: ['fs'] });
  const res = await ensureMcpConnected({
    manager, env: { KHY_MCP_AUTOCONNECT: 'false' }, state: freshState(),
  });
  assert.strictEqual(manager.calls.connectAll, 0);
  assert.strictEqual(manager.calls.loadConfig, 0, 'must not even read config when disabled');
  assert.strictEqual(res.skipped, 'disabled');
});

test('gate OFF is case-insensitive (FALSE / False)', async () => {
  for (const v of ['FALSE', 'False', 'false']) {
    const manager = makeManager({ servers: ['fs'] });
    await ensureMcpConnected({ manager, env: { KHY_MCP_AUTOCONNECT: v }, state: freshState() });
    assert.strictEqual(manager.calls.connectAll, 0, `disabled for ${v}`);
  }
});

test('no servers configured → skip without spawning anything', async () => {
  const manager = makeManager({ servers: [] });
  const res = await ensureMcpConnected({ manager, env: {}, state: freshState() });
  assert.strictEqual(manager.calls.connectAll, 0);
  assert.strictEqual(res.skipped, 'no-servers');
});

test('one-shot latch → second call with same state is a no-op', async () => {
  const manager = makeManager({ servers: ['fs'] });
  const state = freshState();
  await ensureMcpConnected({ manager, env: {}, state });
  const res2 = await ensureMcpConnected({ manager, env: {}, state });
  assert.strictEqual(manager.calls.connectAll, 1, 'connectAll runs at most once per state');
  assert.strictEqual(res2.skipped, 'already-started');
});

test('best-effort: connectAll throwing is swallowed, returns error field', async () => {
  const manager = makeManager({ servers: ['fs'], connectThrows: true });
  const res = await ensureMcpConnected({ manager, env: {}, state: freshState() });
  assert.strictEqual(manager.calls.connectAll, 1);
  assert.ok(res.error && /spawn failed/.test(res.error));
});

test('manager without connectAll → graceful skip (unsupported)', async () => {
  const manager = makeManager({ servers: ['fs'] });
  delete manager.connectAll;
  const res = await ensureMcpConnected({ manager, env: {}, state: freshState() });
  assert.strictEqual(res.skipped, 'unsupported');
});

test('autoConnectEnabled default ON when unset', () => {
  assert.strictEqual(autoConnectEnabled({}), true);
  assert.strictEqual(autoConnectEnabled({ KHY_MCP_AUTOCONNECT: 'true' }), true);
  assert.strictEqual(autoConnectEnabled({ KHY_MCP_AUTOCONNECT: 'false' }), false);
});

test('failed connections are surfaced in the result', async () => {
  const manager = makeManager({
    servers: ['fs', 'broken'],
    connectResult: { connected: ['fs'], failed: [{ name: 'broken', error: 'ENOENT' }] },
  });
  const res = await ensureMcpConnected({ manager, env: {}, state: freshState() });
  assert.deepStrictEqual(res.connected, ['fs']);
  assert.strictEqual(res.failed.length, 1);
  assert.strictEqual(res.failed[0].name, 'broken');
});
