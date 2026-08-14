'use strict';

/**
 * ccMcpBridge — pins the pure leaf that maps Claude Code's MCP config sources
 * and extracts mcpServers maps out of each CC shape, so khy reuses CC's tool
 * (MCP) marketplace. Zero-IO: sources are paths (asserted POSIX-style) and the
 * parsed JSON is injected, so the suite is deterministic. Covers: gate
 * default-ON + falsy set, source enumeration/priority, per-shape extraction
 * (user map, projects[dir] map, .mcp.json), path-resolve tolerance, and
 * fail-soft on junk (never throws).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const bridge = require('../src/services/mcp/ccMcpBridge');

test('isCcMcpBridgeEnabled: default ON, {0,false,off,no} OFF', () => {
  assert.strictEqual(bridge.isCcMcpBridgeEnabled({}), true);
  assert.strictEqual(bridge.isCcMcpBridgeEnabled({ KHY_CC_MCP_BRIDGE: undefined }), true);
  assert.strictEqual(bridge.isCcMcpBridgeEnabled({ KHY_CC_MCP_BRIDGE: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(bridge.isCcMcpBridgeEnabled({ KHY_CC_MCP_BRIDGE: v }), false, `expected off for ${v}`);
  }
});

test('ccMcpConfigSources: home only → single claudeJson-user source', () => {
  const src = bridge.ccMcpConfigSources({ homedir: '/home/u' });
  assert.deepStrictEqual(src, [
    { path: path.join('/home/u', '.claude.json'), kind: 'claudeJson-user' },
  ]);
});

test('ccMcpConfigSources: home + project → user, project map, and .mcp.json', () => {
  const src = bridge.ccMcpConfigSources({ homedir: '/home/u', projectDir: '/work/repo' });
  assert.deepStrictEqual(src, [
    { path: path.join('/home/u', '.claude.json'), kind: 'claudeJson-user' },
    { path: path.join('/home/u', '.claude.json'), kind: 'claudeJson-project' },
    { path: path.join('/work/repo', '.mcp.json'), kind: 'mcpJson' },
  ]);
});

test('ccMcpConfigSources: no home → only .mcp.json (or empty)', () => {
  assert.deepStrictEqual(bridge.ccMcpConfigSources({ projectDir: '/p' }), [
    { path: path.join('/p', '.mcp.json'), kind: 'mcpJson' },
  ]);
  assert.deepStrictEqual(bridge.ccMcpConfigSources({}), []);
  assert.deepStrictEqual(bridge.ccMcpConfigSources(), []);
});

test('extractMcpServers: user shape pulls top-level mcpServers', () => {
  const raw = { mcpServers: { fs: { command: 'mcp-fs', args: ['/tmp'] }, web: { type: 'http', url: 'http://x' } } };
  const out = bridge.extractMcpServers(raw, 'claudeJson-user');
  assert.deepStrictEqual(Object.keys(out).sort(), ['fs', 'web']);
  assert.strictEqual(out.fs.command, 'mcp-fs');
  // shallow-copied: mutating output must not touch the injected input.
  out.fs.command = 'mutated';
  assert.strictEqual(raw.mcpServers.fs.command, 'mcp-fs');
});

test('extractMcpServers: mcpJson shape same as user (top-level map)', () => {
  const raw = { mcpServers: { db: { command: 'mcp-db' } } };
  assert.deepStrictEqual(bridge.extractMcpServers(raw, 'mcpJson'), { db: { command: 'mcp-db' } });
});

test('extractMcpServers: project shape keys into projects[dir].mcpServers', () => {
  const dir = '/work/repo';
  const raw = { projects: { [dir]: { mcpServers: { git: { command: 'mcp-git' } } } } };
  assert.deepStrictEqual(bridge.extractMcpServers(raw, 'claudeJson-project', dir), { git: { command: 'mcp-git' } });
  // path.resolve tolerance: a non-normalized dir still resolves to the entry.
  assert.deepStrictEqual(
    bridge.extractMcpServers({ projects: { [path.resolve(dir)]: { mcpServers: { git: { command: 'g' } } } } }, 'claudeJson-project', `${dir}/.`),
    { git: { command: 'g' } },
  );
});

test('extractMcpServers: misses → empty map, never throws', () => {
  assert.deepStrictEqual(bridge.extractMcpServers({}, 'claudeJson-user'), {});
  assert.deepStrictEqual(bridge.extractMcpServers({ projects: {} }, 'claudeJson-project', '/x'), {});
  assert.deepStrictEqual(bridge.extractMcpServers(null, 'mcpJson'), {});
  assert.deepStrictEqual(bridge.extractMcpServers({ mcpServers: 'nope' }, 'claudeJson-user'), {});
  assert.deepStrictEqual(bridge.extractMcpServers({ mcpServers: { bad: null, ok: { command: 'c' } } }, 'mcpJson'), { ok: { command: 'c' } });
  assert.doesNotThrow(() => bridge.extractMcpServers({ projects: 5 }, 'claudeJson-project', {}));
  assert.deepStrictEqual(bridge.extractMcpServers(raw_unknownKind(), 'weird-kind'), {});
});

function raw_unknownKind() { return { mcpServers: { a: { command: 'a' } } }; }
