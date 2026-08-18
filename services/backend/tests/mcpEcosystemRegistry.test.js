'use strict';

/**
 * mcpEcosystemRegistry — pins the declarative SSOT that lets khy **reuse the MCP
 * servers other agents already have configured** (goal 2026-08-18「蹭生态」).
 * Zero-IO: homedir/projectDir/platform/env are injected and file TEXT is passed
 * in, so the suite is deterministic and platform-independent.
 *
 * Covers: table well-formedness, the two-level gate (global + per-ecosystem),
 * platform-aware base resolution, source enumeration/ordering, per-format
 * parsing (json/json5/toml), every entry shape (standard / vscode / zed),
 * normalization to khy's `{type:'stdio'|'sse'|'http'}` schema, the skips that
 * keep khy from adopting servers it cannot connect (disabled, `${input:}`
 * placeholders, extension-provided), and fail-soft on junk (never throws).
 */

const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const reg = require('../src/services/mcp/mcpEcosystemRegistry');

const HOME = '/home/u';
const PROJ = '/work/repo';

// ── table shape ─────────────────────────────────────────────────────────────

test('ECOSYSTEMS: every entry is well-formed and uniquely gated', () => {
  const ids = new Set();
  const gates = new Set();
  const FORMATS = new Set(['json', 'json5', 'toml']);
  const SHAPES = new Set(['standard', 'vscode', 'zed']);
  const BASES = new Set(['home', 'userAppConfig', 'project']);
  assert.ok(reg.ECOSYSTEMS.length >= 10, 'the point of the registry is breadth');
  for (const e of reg.ECOSYSTEMS) {
    assert.ok(e.id && !ids.has(e.id), `duplicate/missing id: ${e.id}`);
    ids.add(e.id);
    assert.ok(e.label, `${e.id}: missing label`);
    assert.match(e.gate, /^KHY_MCP_ECO_[A-Z0-9_]+$/, `${e.id}: gate naming`);
    assert.ok(!gates.has(e.gate), `${e.id}: duplicate gate ${e.gate}`);
    gates.add(e.gate);
    assert.ok(FORMATS.has(e.format), `${e.id}: bad format ${e.format}`);
    assert.ok(SHAPES.has(e.shape), `${e.id}: bad shape ${e.shape}`);
    assert.ok(e.extract && typeof e.extract === 'string', `${e.id}: missing extract path`);
    assert.ok(['http', 'sse'].includes(e.remoteDefault), `${e.id}: bad remoteDefault`);
    assert.ok(['local', 'doc'].includes(e.evidence), `${e.id}: evidence must be local|doc`);
    assert.ok(Array.isArray(e.sources) && e.sources.length, `${e.id}: no sources`);
    for (const s of e.sources) {
      assert.ok(BASES.has(s.base), `${e.id}: bad base ${s.base}`);
      assert.ok(Array.isArray(s.segs) && s.segs.length, `${e.id}: empty segs`);
      assert.ok(s.kind, `${e.id}: source missing kind`);
    }
  }
});

test('ECOSYSTEMS: frozen, and the dedicated-bridge agents are deliberately absent', () => {
  assert.ok(Object.isFrozen(reg.ECOSYSTEMS));
  assert.ok(Object.isFrozen(reg.ECOSYSTEMS[0]));
  const ids = reg.ECOSYSTEMS.map((e) => e.id);
  // Claude Code / OpenClaw keep their own bridges — double-registering would
  // route the same server through two paths.
  assert.ok(!ids.includes('claude-code'));
  assert.ok(!ids.includes('openclaw'));
  assert.ok(Object.prototype.hasOwnProperty.call(reg.EXCLUDED, 'claude-code'));
  assert.ok(Object.prototype.hasOwnProperty.call(reg.EXCLUDED, 'openclaw'));
});

// ── gates ───────────────────────────────────────────────────────────────────

test('global gate KHY_MCP_ECOSYSTEM: default ON, {0,false,off,no} OFF', () => {
  assert.strictEqual(reg.isMcpEcosystemEnabled({}), true);
  assert.strictEqual(reg.isMcpEcosystemEnabled({ KHY_MCP_ECOSYSTEM: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      reg.isMcpEcosystemEnabled({ KHY_MCP_ECOSYSTEM: v }),
      false,
      `expected off for ${v}`
    );
  }
});

test('gate OFF → no sources at all (shell loop becomes a no-op)', () => {
  const off = reg.mcpEcosystemSources({
    homedir: HOME,
    projectDir: PROJ,
    platform: 'linux',
    env: { KHY_MCP_ECOSYSTEM: '0' },
  });
  assert.deepStrictEqual(off, []);
  assert.deepStrictEqual(reg.getEcosystems({ KHY_MCP_ECOSYSTEM: 'off' }), []);
});

test('per-ecosystem gate turns off exactly one family; parent OFF wins', () => {
  assert.strictEqual(reg.isEcosystemEnabled('cursor', {}), true);
  assert.strictEqual(reg.isEcosystemEnabled('cursor', { KHY_MCP_ECO_CURSOR: '0' }), false);
  assert.strictEqual(reg.isEcosystemEnabled('codex', { KHY_MCP_ECO_CURSOR: '0' }), true);
  assert.strictEqual(reg.isEcosystemEnabled('cursor', { KHY_MCP_ECOSYSTEM: '0' }), false);
  assert.strictEqual(reg.isEcosystemEnabled('nope-not-a-thing', {}), false);
  const ids = reg
    .mcpEcosystemSources({ homedir: HOME, platform: 'linux', env: { KHY_MCP_ECO_CURSOR: 'no' } })
    .map((s) => s.ecosystem);
  assert.ok(!ids.includes('cursor'));
  assert.ok(ids.includes('codex'));
});

// ── path resolution ─────────────────────────────────────────────────────────

test('userAppConfigDir: per-platform application config root', () => {
  assert.strictEqual(
    reg.userAppConfigDir({ homedir: HOME, platform: 'win32', env: { APPDATA: 'C:/AD' } }),
    'C:/AD'
  );
  assert.strictEqual(
    reg.userAppConfigDir({ homedir: HOME, platform: 'win32', env: {} }),
    path.join(HOME, 'AppData', 'Roaming')
  );
  assert.strictEqual(
    reg.userAppConfigDir({ homedir: HOME, platform: 'darwin', env: {} }),
    path.join(HOME, 'Library', 'Application Support')
  );
  assert.strictEqual(
    reg.userAppConfigDir({ homedir: HOME, platform: 'linux', env: { XDG_CONFIG_HOME: '/x/cfg' } }),
    '/x/cfg'
  );
  assert.strictEqual(
    reg.userAppConfigDir({ homedir: HOME, platform: 'linux', env: {} }),
    path.join(HOME, '.config')
  );
  assert.strictEqual(reg.userAppConfigDir({}), '');
});

test('resolveBase: unknown base and missing inputs yield empty string', () => {
  assert.strictEqual(reg.resolveBase('home', { homedir: HOME }), HOME);
  assert.strictEqual(reg.resolveBase('project', { projectDir: PROJ }), PROJ);
  assert.strictEqual(reg.resolveBase('project', {}), '');
  assert.strictEqual(reg.resolveBase('nope', { homedir: HOME }), '');
});

// ── source enumeration ──────────────────────────────────────────────────────

test('sources: known paths appear, project sources only with a projectDir', () => {
  const withProj = reg.mcpEcosystemSources({
    homedir: HOME,
    projectDir: PROJ,
    platform: 'linux',
    env: {},
  });
  const paths = withProj.map((s) => s.path);
  assert.ok(paths.includes(path.join(HOME, '.cursor', 'mcp.json')));
  assert.ok(paths.includes(path.join(PROJ, '.cursor', 'mcp.json')));
  assert.ok(paths.includes(path.join(HOME, '.codex', 'config.toml')));
  assert.ok(paths.includes(path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json')));
  assert.ok(paths.includes(path.join(PROJ, '.vscode', 'mcp.json')));
  assert.ok(paths.includes(path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json')));

  const noProj = reg.mcpEcosystemSources({ homedir: HOME, platform: 'linux', env: {} });
  assert.ok(noProj.length < withProj.length);
  assert.ok(!noProj.some((s) => s.path.startsWith(PROJ)));
});

test('sources: each carries the parse recipe, and ordering is deterministic', () => {
  const args = { homedir: HOME, projectDir: PROJ, platform: 'linux', env: {} };
  const a = reg.mcpEcosystemSources(args);
  const b = reg.mcpEcosystemSources(args);
  assert.deepStrictEqual(a, b);
  const codex = a.find((s) => s.ecosystem === 'codex');
  assert.strictEqual(codex.format, 'toml');
  assert.strictEqual(codex.extract, 'mcp_servers');
  assert.strictEqual(codex.shape, 'standard');
  assert.ok(codex.label && codex.kind && codex.evidence);
  // Table order is the merge order the shell relies on.
  const ids = [...new Set(a.map((s) => s.ecosystem))];
  assert.deepStrictEqual(ids, reg.ECOSYSTEMS.map((e) => e.id).filter((id) => ids.includes(id)));
});

test('sources: platform-scoped entries only surface on their platform', () => {
  const win = reg.mcpEcosystemSources({ homedir: HOME, platform: 'win32', env: { APPDATA: 'C:/AD' } });
  const linux = reg.mcpEcosystemSources({ homedir: HOME, platform: 'linux', env: {} });
  assert.ok(win.some((s) => s.ecosystem === 'zed' && s.kind === 'user-win'));
  assert.ok(!linux.some((s) => s.kind === 'user-win'));
});

test('sources: no homedir → only project-based sources; nothing at all → []', () => {
  // path.join normalizes separators (win32 → backslashes), so compare against
  // the normalized prefix rather than the raw literal.
  const projPrefix = path.join(PROJ);
  const projOnly = reg.mcpEcosystemSources({ projectDir: PROJ, platform: 'linux', env: {} });
  assert.ok(projOnly.length > 0);
  assert.ok(projOnly.every((s) => s.path.startsWith(projPrefix)));
  assert.deepStrictEqual(reg.mcpEcosystemSources({ env: {} }), []);
  assert.deepStrictEqual(reg.mcpEcosystemSources(), reg.mcpEcosystemSources({}));
});

// ── parsing ─────────────────────────────────────────────────────────────────

test('parseEcosystemConfig: json / json5 / toml, plus JSON-with-comments rescue', () => {
  assert.deepStrictEqual(reg.parseEcosystemConfig('{"a":1}', 'json'), { a: 1 });
  assert.deepStrictEqual(reg.parseEcosystemConfig('{a: 1, /*c*/ b: 2,}', 'json5'), { a: 1, b: 2 });
  assert.deepStrictEqual(reg.parseEcosystemConfig('[t]\nk = "v"', 'toml'), { t: { k: 'v' } });
  // VS Code / Zed settings routinely carry comments even in a .json file.
  assert.deepStrictEqual(reg.parseEcosystemConfig('{\n // note\n "a": 1,\n}', 'json'), { a: 1 });
  for (const bad of ['', '   ', null, undefined, 42, '{not json', '<html>']) {
    assert.strictEqual(reg.parseEcosystemConfig(bad, 'json'), null, `expected null for ${bad}`);
  }
});

// ── normalization ───────────────────────────────────────────────────────────

test('standard shape: stdio entries normalize to khy stdio config', () => {
  assert.deepStrictEqual(
    reg.normalizeServerConfig({ command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } }, {}),
    { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } }
  );
  // env values are stringified; empty env is dropped rather than emitted.
  assert.deepStrictEqual(reg.normalizeServerConfig({ command: 'x', env: { N: 3, B: true } }, {}), {
    type: 'stdio',
    command: 'x',
    env: { N: '3', B: 'true' },
  });
  assert.deepStrictEqual(reg.normalizeServerConfig({ command: 'x', env: {} }, {}), {
    type: 'stdio',
    command: 'x',
  });
  // command given as an array → head is the binary, tail joins args.
  assert.deepStrictEqual(
    reg.normalizeServerConfig({ command: ['uvx', 'srv'], args: ['--flag'] }, {}),
    { type: 'stdio', command: 'uvx', args: ['srv', '--flag'] }
  );
  assert.strictEqual(reg.normalizeServerConfig({ command: [] }, {}), null);
});

test('standard shape: remote entries pick a transport per declaration then default', () => {
  assert.deepStrictEqual(reg.normalizeServerConfig({ url: 'https://x/mcp' }, {}), {
    type: 'http',
    url: 'https://x/mcp',
  });
  // Gemini/Qwen convention: bare `url` is SSE, `httpUrl` is streamable HTTP.
  assert.deepStrictEqual(
    reg.normalizeServerConfig({ url: 'https://x/sse' }, { remoteDefault: 'sse' }),
    { type: 'sse', url: 'https://x/sse' }
  );
  assert.deepStrictEqual(
    reg.normalizeServerConfig({ httpUrl: 'https://x/mcp' }, { remoteDefault: 'sse' }),
    { type: 'http', url: 'https://x/mcp' }
  );
  // Windsurf's serverUrl, and explicit type/transport aliases.
  assert.deepStrictEqual(reg.normalizeServerConfig({ serverUrl: 'https://x/sse' }, {}), {
    type: 'http',
    url: 'https://x/sse',
  });
  assert.deepStrictEqual(
    reg.normalizeServerConfig({ url: 'https://x/mcp', type: 'streamable-http' }, {}),
    { type: 'http', url: 'https://x/mcp' }
  );
  assert.deepStrictEqual(
    reg.normalizeServerConfig({ url: 'https://x/sse', transport: 'SSE' }, {}),
    { type: 'sse', url: 'https://x/sse' }
  );
  assert.deepStrictEqual(
    reg.normalizeServerConfig({ url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } }, {}),
    { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } }
  );
  // Non-http(s) URLs and missing command/url are unusable → skipped.
  assert.strictEqual(reg.normalizeServerConfig({ url: 'ws://x' }, {}), null);
  assert.strictEqual(reg.normalizeServerConfig({}, {}), null);
});

test('vscode shape: `servers` map, stdio + http entries', () => {
  const parsed = reg.parseEcosystemConfig(
    JSON.stringify({
      inputs: [{ id: 'tok', type: 'promptString' }],
      servers: {
        fs: { type: 'stdio', command: 'npx', args: ['-y', 'server-filesystem'] },
        remote: { type: 'http', url: 'https://api.example.com/mcp' },
        needsInput: { type: 'stdio', command: 'srv', env: { TOKEN: '${input:tok}' } },
      },
    }),
    'json'
  );
  const out = reg.extractEcosystemServers(parsed, {
    extract: 'servers',
    shape: 'vscode',
    remoteDefault: 'http',
  });
  assert.deepStrictEqual(out.fs, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'server-filesystem'],
  });
  assert.deepStrictEqual(out.remote, { type: 'http', url: 'https://api.example.com/mcp' });
  // `${input:…}` needs interactive resolution khy cannot do → not adopted.
  assert.strictEqual(out.needsInput, undefined);
});

test('zed shape: nested command object; extension-provided servers are skipped', () => {
  const parsed = reg.parseEcosystemConfig(
    ['{', '  // zed settings allow comments', '  "context_servers": {', '    "local": { "source": "custom", "command": { "path": "npx", "args": ["-y", "srv"], "env": { "K": "v" } } },', '    "byExtension": { "source": "extension" },', '    "flat": { "command": "uvx", "args": ["srv"] }', '  }', '}'].join('\n'),
    'json5'
  );
  const out = reg.extractEcosystemServers(parsed, {
    extract: 'context_servers',
    shape: 'zed',
    remoteDefault: 'http',
  });
  assert.deepStrictEqual(out.local, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'srv'],
    env: { K: 'v' },
  });
  assert.deepStrictEqual(out.flat, { type: 'stdio', command: 'uvx', args: ['srv'] });
  assert.strictEqual(out.byExtension, undefined);
});

test('disabled entries are never adopted', () => {
  assert.strictEqual(reg.normalizeServerConfig({ command: 'x', disabled: true }, {}), null);
  assert.strictEqual(reg.normalizeServerConfig({ command: 'x', enabled: false }, {}), null);
  assert.ok(reg.normalizeServerConfig({ command: 'x', disabled: false }, {}));
});

test('dotted extract path reaches nested maps (mcp.servers style)', () => {
  const parsed = { mcp: { servers: { a: { command: 'x' } } } };
  const out = reg.extractEcosystemServers(parsed, { extract: 'mcp.servers', shape: 'standard' });
  assert.deepStrictEqual(out, { a: { type: 'stdio', command: 'x' } });
});

test('extractEcosystemServers: fail-soft on every junk input', () => {
  for (const bad of [null, undefined, 42, 'str', [], {}, { mcpServers: [] }, { mcpServers: 3 }]) {
    assert.deepStrictEqual(
      reg.extractEcosystemServers(bad, { extract: 'mcpServers', shape: 'standard' }),
      {},
      `expected {} for ${JSON.stringify(bad)}`
    );
  }
  assert.deepStrictEqual(reg.extractEcosystemServers({ mcpServers: { a: 1, b: null } }, {}), {});
  assert.deepStrictEqual(reg.extractEcosystemServers(), {});
});

test('normalizeServerConfig: fail-soft on every junk input', () => {
  for (const bad of [null, undefined, 42, 'str', [], () => {}]) {
    assert.strictEqual(reg.normalizeServerConfig(bad, {}), null);
  }
  // Called with no options at all → defaults apply, still no throw.
  assert.deepStrictEqual(reg.normalizeServerConfig({ command: 'x' }), {
    type: 'stdio',
    command: 'x',
  });
});

test('full round trip: a Codex config.toml becomes khy-shaped servers', () => {
  const src = reg
    .mcpEcosystemSources({ homedir: HOME, platform: 'linux', env: {} })
    .find((s) => s.ecosystem === 'codex');
  const parsed = reg.parseEcosystemConfig(
    ['[mcp_servers.everything]', 'command = "npx"', 'args = ["-y", "srv-everything"]'].join('\n'),
    src.format
  );
  assert.deepStrictEqual(reg.extractEcosystemServers(parsed, src), {
    everything: { type: 'stdio', command: 'npx', args: ['-y', 'srv-everything'] },
  });
});
