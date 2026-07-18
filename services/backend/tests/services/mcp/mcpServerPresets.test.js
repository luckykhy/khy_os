'use strict';

/**
 * mcpServerPresets.test.js — 纯叶子契约:开源 MCP server 预设注册表 + `khy mcp add <预设名>` 展开。
 *
 * 覆盖:门控(flagRegistry 优先 + 本地 CANON 回退)、canonicalPresetName(别名/未知)、
 * hasPreset(门控约束)、resolvePreset(构形/extraArgs 追加/env 透传/缺失 env 收集/未知名/门控关)、
 * listPresets(排序 + 门控关空数组)、buildServerConfig 预设展开接线(短名/带位置参数/launcher 覆盖/门控关回退)。
 */

const test = require('node:test');
const assert = require('node:assert');

const presets = require('../../../src/services/mcp/mcpServerPresets');
const spec = require('../../../src/services/mcp/mcpAddSpec');

// ── 门控 ──────────────────────────────────────────────────────────────────────
test('isPresetsEnabled: default ON; CANON off-words disable; EXTENDED stays on', () => {
  assert.strictEqual(presets.isPresetsEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(presets.isPresetsEnabled({ KHY_MCP_PRESETS: off }), false, `off=${off}`);
  }
  assert.strictEqual(presets.isPresetsEnabled({ KHY_MCP_PRESETS: 'disable' }), true); // 非 CANON → 开
});

// ── canonicalPresetName ───────────────────────────────────────────────────────
test('canonicalPresetName: known names, aliases, unknown → ""', () => {
  assert.strictEqual(presets.canonicalPresetName('github'), 'github');
  assert.strictEqual(presets.canonicalPresetName('GitHub'), 'github'); // 大小写不敏感
  assert.strictEqual(presets.canonicalPresetName('gh'), 'github');     // 别名
  assert.strictEqual(presets.canonicalPresetName('fs'), 'filesystem');
  assert.strictEqual(presets.canonicalPresetName('pg'), 'postgres');
  assert.strictEqual(presets.canonicalPresetName('sequentialthinking'), 'sequential-thinking');
  assert.strictEqual(presets.canonicalPresetName('nope'), '');
  assert.strictEqual(presets.canonicalPresetName(''), '');
  assert.strictEqual(presets.canonicalPresetName(null), '');
});

// ── hasPreset(门控约束)────────────────────────────────────────────────────────
test('hasPreset: true for known (gate on), false when gated off', () => {
  assert.strictEqual(presets.hasPreset('github', {}), true);
  assert.strictEqual(presets.hasPreset('gh', {}), true);
  assert.strictEqual(presets.hasPreset('unknown', {}), false);
  assert.strictEqual(presets.hasPreset('github', { KHY_MCP_PRESETS: '0' }), false); // 门控关
});

// ── resolvePreset ─────────────────────────────────────────────────────────────
test('resolvePreset: github → stdio config, missing env collected', () => {
  const r = presets.resolvePreset('github', { gateEnv: {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, 'github');
  assert.strictEqual(r.config.type, 'stdio');
  assert.strictEqual(r.config.command, 'npx');
  assert.deepStrictEqual(r.config.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.deepStrictEqual(r.meta.requiresEnv, ['GITHUB_PERSONAL_ACCESS_TOKEN']);
  assert.deepStrictEqual(r.meta.missingEnv, ['GITHUB_PERSONAL_ACCESS_TOKEN']); // 未提供 → 缺
});

test('resolvePreset: env provided → merged into config + no longer missing', () => {
  const r = presets.resolvePreset('github', {
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'tok' }, gateEnv: {},
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.config.env, { GITHUB_PERSONAL_ACCESS_TOKEN: 'tok' });
  assert.deepStrictEqual(r.meta.missingEnv, []);
});

test('resolvePreset: extraArgs appended (filesystem path)', () => {
  const r = presets.resolvePreset('filesystem', { extraArgs: ['/home/me/docs'], gateEnv: {} });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.config.args, ['-y', '@modelcontextprotocol/server-filesystem', '/home/me/docs']);
});

test('resolvePreset: unknown name → ok:false; gated off → ok:false', () => {
  assert.strictEqual(presets.resolvePreset('nope', { gateEnv: {} }).ok, false);
  assert.strictEqual(presets.resolvePreset('github', { gateEnv: { KHY_MCP_PRESETS: '0' } }).ok, false);
});

test('resolvePreset: does not mutate the frozen preset args (returns a copy)', () => {
  const before = presets._PRESETS.filesystem.args.slice();
  presets.resolvePreset('filesystem', { extraArgs: ['/x'], gateEnv: {} });
  assert.deepStrictEqual(presets._PRESETS.filesystem.args, before);
});

// ── listPresets ───────────────────────────────────────────────────────────────
test('listPresets: sorted, includes github; gated off → empty', () => {
  const list = presets.listPresets({});
  assert.ok(list.length >= 10);
  const names = list.map((p) => p.name);
  assert.ok(names.includes('github'));
  assert.ok(names.includes('filesystem'));
  // sorted ascending
  const sorted = names.slice().sort();
  assert.deepStrictEqual(names, sorted);
  // each row carries a runnable command string
  const gh = list.find((p) => p.name === 'github');
  assert.match(gh.command, /^npx /);
  assert.deepStrictEqual(presets.listPresets({ KHY_MCP_PRESETS: 'off' }), []);
});

// ── buildServerConfig 预设展开接线 ─────────────────────────────────────────────
test('buildServerConfig: `mcp add github` (no command) expands preset', () => {
  const r = spec.buildServerConfig({ name: 'github', rest: [], options: {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.config.command, 'npx');
  assert.deepStrictEqual(r.config.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.ok(r.preset, 'preset meta attached');
  assert.deepStrictEqual(r.preset.missingEnv, ['GITHUB_PERSONAL_ACCESS_TOKEN']);
});

test('buildServerConfig: `mcp add filesystem ~/docs` expands preset + trailing path arg', () => {
  const r = spec.buildServerConfig({ name: 'filesystem', rest: ['/home/me/docs'], options: {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.config.command, 'npx');
  assert.deepStrictEqual(r.config.args, ['-y', '@modelcontextprotocol/server-filesystem', '/home/me/docs']);
});

test('buildServerConfig: alias `gh` expands to github preset', () => {
  const r = spec.buildServerConfig({ name: 'gh', rest: [], options: {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, 'github');
  assert.deepStrictEqual(r.config.args, ['-y', '@modelcontextprotocol/server-github']);
});

test('buildServerConfig: env passed to preset via -e preamble', () => {
  const r = spec.buildServerConfig({
    name: 'github', rest: ['-e', 'GITHUB_PERSONAL_ACCESS_TOKEN=tok'], options: {},
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.config.env, { GITHUB_PERSONAL_ACCESS_TOKEN: 'tok' });
  assert.deepStrictEqual(r.preset.missingEnv, []);
});

test('buildServerConfig: explicit `-- npx …` command overrides preset (literal, no preset meta)', () => {
  const r = spec.buildServerConfig({
    name: 'github', rest: ['npx', '-y', 'my-custom-github'], options: {},
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.config.args, ['-y', 'my-custom-github']);
  assert.strictEqual(r.preset, undefined, 'launcher command → literal path, no preset expansion');
});

test('buildServerConfig: preset expansion OFF (KHY_MCP_PRESETS=0) → falls back to "缺少命令"', () => {
  const prev = process.env.KHY_MCP_PRESETS;
  process.env.KHY_MCP_PRESETS = '0';
  try {
    const r = spec.buildServerConfig({ name: 'github', rest: [], options: {} });
    assert.strictEqual(r.ok, false); // 无命令 + 预设关 → 回退原错误
    assert.match(r.error, /命令/);
  } finally {
    if (prev === undefined) delete process.env.KHY_MCP_PRESETS; else process.env.KHY_MCP_PRESETS = prev;
  }
});
