'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../../../src/services/mcp/mcpConfigStore');

function _tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mcpstore-'));
}
function _readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// ── scopePath ─────────────────────────────────────────────────────────────────
test('scopePath: user → <home>/.khy/mcp.json, project → <cwd>/.khy/mcp.json', () => {
  assert.strictEqual(store.scopePath('user', { homedir: '/h' }), path.join('/h', '.khy', 'mcp.json'));
  assert.strictEqual(store.scopePath('project', { cwd: '/proj' }), path.join('/proj', '.khy', 'mcp.json'));
});

// ── addServer: fresh file ─────────────────────────────────────────────────────
test('addServer: creates mcp.json under user scope', () => {
  const home = _tmp();
  try {
    const cfg = { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] };
    const res = store.addServer('filesystem', cfg, { scope: 'user', homedir: home });
    assert.strictEqual(res.replaced, false);
    assert.strictEqual(res.path, path.join(home, '.khy', 'mcp.json'));
    const j = _readJson(res.path);
    assert.deepStrictEqual(j.mcpServers.filesystem, cfg);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── addServer: merges into existing, preserves others + top-level keys ─────────
test('addServer: merges without clobbering existing servers / unknown top-level keys', () => {
  const home = _tmp();
  try {
    const file = path.join(home, '.khy', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      _note: 'keep me',
      mcpServers: { existing: { type: 'stdio', command: 'foo' } },
    }), 'utf-8');

    const res = store.addServer('github', { type: 'stdio', command: 'bar' }, { scope: 'user', homedir: home });
    assert.strictEqual(res.replaced, false);
    const j = _readJson(file);
    assert.strictEqual(j._note, 'keep me');               // 未知顶层字段保留
    assert.strictEqual(j.mcpServers.existing.command, 'foo'); // 既有 server 保留
    assert.strictEqual(j.mcpServers.github.command, 'bar');   // 新增
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── addServer: same name overwrites → replaced:true ───────────────────────────
test('addServer: same name → replaced:true', () => {
  const home = _tmp();
  try {
    store.addServer('x', { type: 'stdio', command: 'a' }, { scope: 'user', homedir: home });
    const res = store.addServer('x', { type: 'stdio', command: 'b' }, { scope: 'user', homedir: home });
    assert.strictEqual(res.replaced, true);
    const j = _readJson(res.path);
    assert.strictEqual(j.mcpServers.x.command, 'b');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── project scope writes to cwd ───────────────────────────────────────────────
test('addServer: project scope writes <cwd>/.khy/mcp.json', () => {
  const proj = _tmp();
  try {
    const res = store.addServer('shared', { type: 'stdio', command: 'npx' }, { scope: 'project', cwd: proj });
    assert.strictEqual(res.path, path.join(proj, '.khy', 'mcp.json'));
    assert.ok(fs.existsSync(res.path));
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

// ── removeServer ──────────────────────────────────────────────────────────────
test('removeServer: removes present, reports absent', () => {
  const home = _tmp();
  try {
    store.addServer('a', { type: 'stdio', command: 'x' }, { scope: 'user', homedir: home });
    store.addServer('b', { type: 'stdio', command: 'y' }, { scope: 'user', homedir: home });
    const gone = store.removeServer('a', { scope: 'user', homedir: home });
    assert.strictEqual(gone.removed, true);
    const j = _readJson(gone.path);
    assert.ok(!j.mcpServers.a);
    assert.ok(j.mcpServers.b); // 只删目标

    const absent = store.removeServer('nope', { scope: 'user', homedir: home });
    assert.strictEqual(absent.removed, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('removeServer: missing file → removed:false (no throw)', () => {
  const home = _tmp();
  try {
    const res = store.removeServer('x', { scope: 'user', homedir: home });
    assert.strictEqual(res.removed, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── corrupt file → throws (does not silently clobber user config) ─────────────
test('readConfigFile: corrupt JSON throws rather than eating user config', () => {
  const home = _tmp();
  try {
    const file = path.join(home, '.khy', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not valid json', 'utf-8');
    assert.throws(() => store.readConfigFile(file), /损坏|解析/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── E2E: leaf → store round-trips through mcp/index.js loadConfig ──────────────
test('E2E: mcpAddSpec.buildServerConfig → store.addServer → mcp.loadConfig sees it', () => {
  const spec = require('../../../src/services/mcp/mcpAddSpec');
  const home = _tmp();
  const prevHome = os.homedir;
  // loadConfig 读 os.homedir()/.khy/mcp.json,这里把 os.homedir 指向临时目录。
  os.homedir = () => home;
  // 让 CC-bridge 不干扰(它也读 os.homedir()/.claude.json,不存在即跳过)。
  try {
    const built = spec.buildServerConfig({
      name: 'filesystem',
      rest: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp/docs'],
      options: { scope: 'user' },
    });
    assert.strictEqual(built.ok, true);
    store.addServer(built.name, built.config, { scope: 'user', homedir: home });

    // 清 require 缓存以确保 mcp/index.js 用被替换后的 os.homedir 计算 CONFIG_PATHS。
    delete require.cache[require.resolve('../../../src/services/mcp/index.js')];
    const mcp = require('../../../src/services/mcp/index.js');
    const loaded = mcp.loadConfig();
    assert.ok(loaded.mcpServers.filesystem, 'loadConfig should surface the added server');
    assert.strictEqual(loaded.mcpServers.filesystem.command, 'npx');
  } finally {
    os.homedir = prevHome;
    delete require.cache[require.resolve('../../../src/services/mcp/index.js')];
    fs.rmSync(home, { recursive: true, force: true });
  }
});
