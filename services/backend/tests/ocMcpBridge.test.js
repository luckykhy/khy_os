'use strict';

/**
 * ocMcpBridge — pins the pure leaf that maps OpenClaw's MCP config source and
 * extracts the mcpServers map out of OpenClaw's `mcp.servers` shape, so khy
 * reuses OpenClaw's MCP servers. Zero-IO: homedir/env are injected and the file
 * TEXT is passed in, so the suite is deterministic. Covers: gate default-ON +
 * falsy set, source enumeration + state-home overrides, JSON5-lite parse
 * (comments + trailing commas), extraction from mcp.servers, and fail-soft on
 * junk (never throws).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const bridge = require('../src/services/mcp/ocMcpBridge');

test('isOcMcpBridgeEnabled: default ON, {0,false,off,no} OFF', () => {
  assert.strictEqual(bridge.isOcMcpBridgeEnabled({}), true);
  assert.strictEqual(bridge.isOcMcpBridgeEnabled({ KHY_OPENCLAW_MCP_BRIDGE: undefined }), true);
  assert.strictEqual(bridge.isOcMcpBridgeEnabled({ KHY_OPENCLAW_MCP_BRIDGE: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(bridge.isOcMcpBridgeEnabled({ KHY_OPENCLAW_MCP_BRIDGE: v }), false, `expected off for ${v}`);
  }
});

test('ocMcpConfigSources: default home → <home>/.openclaw/openclaw.json', () => {
  assert.deepStrictEqual(bridge.ocMcpConfigSources({ homedir: '/home/u', env: {} }), [
    { path: path.join('/home/u', '.openclaw', 'openclaw.json'), kind: 'openclawJson' },
  ]);
});

test('ocMcpConfigSources: KHY_OPENCLAW_DATA_HOME / OPENCLAW_STATE_DIR override root', () => {
  assert.deepStrictEqual(bridge.ocMcpConfigSources({ homedir: '/h', env: { KHY_OPENCLAW_DATA_HOME: '/custom' } }), [
    { path: path.join('/custom', 'openclaw.json'), kind: 'openclawJson' },
  ]);
  assert.deepStrictEqual(bridge.ocMcpConfigSources({ homedir: '/h', env: { OPENCLAW_STATE_DIR: '/oc' } }), [
    { path: path.join('/oc', 'openclaw.json'), kind: 'openclawJson' },
  ]);
});

test('ocMcpConfigSources: no home & no override → empty', () => {
  assert.deepStrictEqual(bridge.ocMcpConfigSources({ env: {} }), []);
  assert.deepStrictEqual(bridge.ocMcpConfigSources(), []);
});

test('parseConfig: plain JSON', () => {
  assert.deepStrictEqual(bridge.parseConfig('{"mcp":{"servers":{"a":{"command":"x"}}}}'),
    { mcp: { servers: { a: { command: 'x' } } } });
});

test('parseConfig: JSON5-lite with comments + trailing commas', () => {
  const text = `{
    // line comment
    "mcp": {
      /* block comment */
      "servers": {
        "fs": { "command": "mcp-fs", "args": ["/tmp",], },
      },
    },
  }`;
  const obj = bridge.parseConfig(text);
  assert.strictEqual(obj.mcp.servers.fs.command, 'mcp-fs');
  assert.deepStrictEqual(obj.mcp.servers.fs.args, ['/tmp']);
});

test('parseConfig: junk / empty → null, never throws', () => {
  assert.strictEqual(bridge.parseConfig(''), null);
  assert.strictEqual(bridge.parseConfig('not json at all {{{'), null);
  assert.strictEqual(bridge.parseConfig(null), null);
  assert.strictEqual(bridge.parseConfig(42), null);
});

test('extractMcpServers: pulls mcp.servers, shallow-copies', () => {
  const raw = { mcp: { servers: { fs: { command: 'mcp-fs' }, web: { url: 'http://x', transport: 'http' } } } };
  const out = bridge.extractMcpServers(raw);
  assert.deepStrictEqual(Object.keys(out).sort(), ['fs', 'web']);
  out.fs.command = 'mutated';
  assert.strictEqual(raw.mcp.servers.fs.command, 'mcp-fs', 'must not mutate injected input');
});

test('extractMcpServers: misses → empty map, never throws', () => {
  assert.deepStrictEqual(bridge.extractMcpServers({}), {});
  assert.deepStrictEqual(bridge.extractMcpServers({ mcp: {} }), {});
  assert.deepStrictEqual(bridge.extractMcpServers({ mcp: { servers: 'nope' } }), {});
  assert.deepStrictEqual(bridge.extractMcpServers(null), {});
  assert.deepStrictEqual(bridge.extractMcpServers({ mcp: { servers: { bad: null, ok: { command: 'c' } } } }), { ok: { command: 'c' } });
});
