'use strict';

const test = require('node:test');
const assert = require('node:assert');

const spec = require('../../../src/services/mcp/mcpAddSpec');

// ── 门控 ──────────────────────────────────────────────────────────────────────
test('isMcpAddEnabled: CANON gating (0/false/off/no → off; disable stays on)', () => {
  assert.strictEqual(spec.isMcpAddEnabled({}), true);
  assert.strictEqual(spec.isMcpAddEnabled({ KHY_MCP_ADD: 'off' }), false);
  assert.strictEqual(spec.isMcpAddEnabled({ KHY_MCP_ADD: '0' }), false);
  assert.strictEqual(spec.isMcpAddEnabled({ KHY_MCP_ADD: 'no' }), false);
  assert.strictEqual(spec.isMcpAddEnabled({ KHY_MCP_ADD: 'false' }), false);
  assert.strictEqual(spec.isMcpAddEnabled({ KHY_MCP_ADD: 'disable' }), true); // EXTENDED 词 → 开
});

// ── 名称校验 ──────────────────────────────────────────────────────────────────
test('isValidServerName: ^[a-zA-Z0-9_-]{1,64}$', () => {
  assert.ok(spec.isValidServerName('filesystem'));
  assert.ok(spec.isValidServerName('my-server_2'));
  assert.ok(!spec.isValidServerName(''));
  assert.ok(!spec.isValidServerName('has space'));
  assert.ok(!spec.isValidServerName('bad/name'));
  assert.ok(!spec.isValidServerName('a'.repeat(65)));
});

// ── scope / transport / env 解析 ──────────────────────────────────────────────
test('normalizeScope: project/local/proj → project; else user', () => {
  assert.strictEqual(spec.normalizeScope('project'), 'project');
  assert.strictEqual(spec.normalizeScope('local'), 'project');
  assert.strictEqual(spec.normalizeScope('proj'), 'project');
  assert.strictEqual(spec.normalizeScope('user'), 'user');
  assert.strictEqual(spec.normalizeScope(undefined), 'user');
});

test('normalizeTransport: stdio default, sse/http ok, unknown → null', () => {
  assert.strictEqual(spec.normalizeTransport(undefined), 'stdio');
  assert.strictEqual(spec.normalizeTransport('sse'), 'sse');
  assert.strictEqual(spec.normalizeTransport('HTTP'), 'http');
  assert.strictEqual(spec.normalizeTransport('ws'), null);
});

test('parseEnvPair / parseEnvString', () => {
  assert.deepStrictEqual(spec.parseEnvPair('API_KEY=abc123'), ['API_KEY', 'abc123']);
  assert.deepStrictEqual(spec.parseEnvPair('URL=http://x?y=1'), ['URL', 'http://x?y=1']); // value 含 =
  assert.strictEqual(spec.parseEnvPair('nokey'), null);
  assert.strictEqual(spec.parseEnvPair('=noname'), null);
  assert.deepStrictEqual(spec.parseEnvString('A=1,B=2'), { A: '1', B: '2' });
  assert.deepStrictEqual(spec.parseEnvString(''), {});
});

// ── 前导 flag 消费(兼容拷贝 claude 的 -s/-e 写法)────────────────────────────
test('_consumePreamble: consumes -s/-e/--transport then stops at command', () => {
  const r = spec._consumePreamble(['-s', 'user', '-e', 'K=V', '-e', 'K2=V2', 'npx', '-y', 'pkg']);
  assert.strictEqual(r.scope, 'user');
  assert.deepStrictEqual(r.env, { K: 'V', K2: 'V2' }); // 多个 -e 累加
  assert.deepStrictEqual(r.command, ['npx', '-y', 'pkg']); // 命令里的 -y 不被当 flag
});

// ── buildServerConfig:stdio ───────────────────────────────────────────────────
test('buildServerConfig: stdio via -- command (khy options scope/env)', () => {
  const r = spec.buildServerConfig({
    name: 'filesystem',
    rest: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/Users/me/Documents'],
    options: { scope: 'user' },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, 'filesystem');
  assert.strictEqual(r.scope, 'user');
  assert.deepStrictEqual(r.config, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/Documents'],
  });
});

test('buildServerConfig: stdio with env (khy --env string) + project scope', () => {
  const r = spec.buildServerConfig({
    name: 'github',
    rest: ['npx', '-y', '@modelcontextprotocol/server-github'],
    options: { env: 'GITHUB_TOKEN=tok', scope: 'project' },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.scope, 'project');
  assert.deepStrictEqual(r.config.env, { GITHUB_TOKEN: 'tok' });
  assert.strictEqual(r.config.command, 'npx');
});

test('buildServerConfig: pasted claude form (-s user -e K=V) parsed from rest', () => {
  const r = spec.buildServerConfig({
    name: 'api-server',
    rest: ['-s', 'user', '-e', 'API_KEY=xyz', 'node', '/path/server.js'],
    options: {},
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.scope, 'user');
  assert.deepStrictEqual(r.config.env, { API_KEY: 'xyz' });
  assert.strictEqual(r.config.command, 'node');
  assert.deepStrictEqual(r.config.args, ['/path/server.js']);
});

// ── buildServerConfig:sse / http ──────────────────────────────────────────────
test('buildServerConfig: sse transport needs url', () => {
  const ok = spec.buildServerConfig({
    name: 'remote', rest: [], options: { transport: 'sse', url: 'https://example.com/sse' },
  });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.config, { type: 'sse', url: 'https://example.com/sse' });

  const bad = spec.buildServerConfig({ name: 'remote', rest: [], options: { transport: 'http' } });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /URL/);
});

// ── buildServerConfig:错误路径 ────────────────────────────────────────────────
test('buildServerConfig: rejects bad name / missing command', () => {
  assert.strictEqual(spec.buildServerConfig({ name: 'bad name', rest: ['npx'] }).ok, false);
  assert.strictEqual(spec.buildServerConfig({ name: '', rest: ['npx'] }).ok, false);
  const noCmd = spec.buildServerConfig({ name: 'x', rest: [], options: {} });
  assert.strictEqual(noCmd.ok, false);
  assert.match(noCmd.error, /命令/);
});
