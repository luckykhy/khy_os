'use strict';

/**
 * portableCli.test.js — 便携 CLI 子系统(注册表/解析器/安装器/适配器接线/自动安装桥)
 * 的纯逻辑测试:门开命中 / 门关逐字节回退 / 恶意 env 绝不抛 / win32·posix 分支。
 *
 * 用真临时目录搭一个假的便携安装(<root>/<portableDir>/node_modules/<pkg>/package.json+入口),
 * 验证解析器读 package.json.bin 定位入口、包成 node 启动规格。绝不触网、绝不真装。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../../../../src/services/gateway/adapters/portableCliRegistry');
const resolver = require('../../../../src/services/gateway/adapters/portableCliResolver');
const installer = require('../../../../src/services/gateway/adapters/portableCliInstaller');
const adapterSpawn = require('../../../../src/services/gateway/adapters/portableAdapterSpawn');
const autoInstall = require('../../../../src/cli/handlers/_portableAutoInstall');

/** 在临时根下搭一个假便携安装:返回 { root, entryAbs }。 */
function makePortableFixture(toolKey, { binField, entryRel = 'cli.js', entryContent = '#!/usr/bin/env node\n' } = {}) {
  const tool = registry.getTool(toolKey);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-portable-'));
  const pkgDir = path.join(root, tool.portableDir, 'node_modules', ...tool.pkg.split('/'));
  fs.mkdirSync(pkgDir, { recursive: true });
  const entryAbs = path.join(pkgDir, entryRel);
  fs.mkdirSync(path.dirname(entryAbs), { recursive: true });
  fs.writeFileSync(entryAbs, entryContent);
  const bin = binField !== undefined ? binField : { [tool.bin]: entryRel };
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: tool.pkg, bin }));
  return { root, entryAbs };
}

// ─────────────────────────── registry ───────────────────────────

test('registry: listTools 稳定含 claude/codex/opencode', () => {
  const keys = registry.listTools().map((t) => t.key);
  assert.deepStrictEqual(keys, ['claude', 'codex', 'opencode']);
});

test('registry: isKnownTool 归一化大小写空白', () => {
  assert.strictEqual(registry.isKnownTool('  CLAUDE '), true);
  assert.strictEqual(registry.isKnownTool('codex'), true);
  assert.strictEqual(registry.isKnownTool('aider'), false);
  assert.strictEqual(registry.isKnownTool(null), false);
});

test('registry: hasNativeResolver 仅 opencode', () => {
  assert.strictEqual(registry.hasNativeResolver('opencode'), true);
  assert.strictEqual(registry.hasNativeResolver('claude'), false);
  assert.strictEqual(registry.getTool('nope'), null);
});

// ─────────────────────────── resolver ───────────────────────────

test('resolver: 便携命中 → node 启动规格(读 package.json.bin 定位入口)', () => {
  const { root, entryAbs } = makePortableFixture('codex');
  const spec = resolver.resolveLaunchSpec('codex', { env: {}, toolsRoot: root });
  assert.ok(spec);
  assert.strictEqual(spec.command, process.execPath);
  assert.deepStrictEqual(spec.argsPrefix, [entryAbs]);
  assert.strictEqual(spec.resolvedFrom, 'portable');
});

test('resolver: bin 为字符串也能定位入口', () => {
  const { root, entryAbs } = makePortableFixture('claude', { binField: 'cli.js' });
  const spec = resolver.resolveLaunchSpec('claude', { env: {}, toolsRoot: root });
  assert.deepStrictEqual(spec.argsPrefix, [entryAbs]);
});

test('resolver: 门 KHY_PORTABLE_CLI=off → null(逐字节回退)', () => {
  const { root } = makePortableFixture('codex');
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(resolver.resolveLaunchSpec('codex', { env: { KHY_PORTABLE_CLI: v }, toolsRoot: root }), null);
  }
});

test('resolver: opencode 让给专用解析器 → 恒 null', () => {
  const { root } = makePortableFixture('opencode');
  assert.strictEqual(resolver.resolveLaunchSpec('opencode', { env: {}, toolsRoot: root }), null);
});

test('resolver: 未知工具 / 无根 → null', () => {
  assert.strictEqual(resolver.resolveLaunchSpec('aider', { env: {}, toolsRoot: '/tmp' }), null);
  assert.strictEqual(resolver.resolveLaunchSpec('codex', { env: {} }), null);
});

test('resolver: KHY_<TOOL>_BIN 显式覆盖(存在 .js → node 规格)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-override-'));
  const bin = path.join(dir, 'mycodex.js');
  fs.writeFileSync(bin, '#!/usr/bin/env node\n');
  const spec = resolver.resolveLaunchSpec('codex', { env: { KHY_CODEX_BIN: bin } });
  assert.strictEqual(spec.command, process.execPath);
  assert.deepStrictEqual(spec.argsPrefix, [bin]);
  assert.strictEqual(spec.resolvedFrom, 'override');
});

test('resolver: 覆盖路径不存在 → override-missing 原样直接执行', () => {
  const spec = resolver.resolveLaunchSpec('codex', { env: { KHY_CODEX_BIN: '/no/such/codex-bin' } });
  assert.strictEqual(spec.resolvedFrom, 'override-missing');
  assert.strictEqual(spec.command, '/no/such/codex-bin');
  assert.deepStrictEqual(spec.argsPrefix, []);
});

test('resolver: 原生二进制入口(无 node shebang, 无 .js 扩展)→ 直接执行', () => {
  const { root, entryAbs } = makePortableFixture('codex', {
    binField: { codex: 'codex-native' },
    entryRel: 'codex-native',
    entryContent: '\x7fELF binary-ish',
  });
  const spec = resolver.resolveLaunchSpec('codex', { env: {}, toolsRoot: root });
  assert.strictEqual(spec.command, entryAbs);
  assert.deepStrictEqual(spec.argsPrefix, []);
});

test('resolver: 恶意 env 绝不抛', () => {
  assert.doesNotThrow(() => resolver.resolveLaunchSpec('codex', { env: { KHY_TOOLS_DIR: 12345 } }));
  assert.doesNotThrow(() => resolver.resolveLaunchSpec(null, null));
  assert.strictEqual(resolver.resolveLaunchSpec(null, null), null);
});

test('resolver: isInstalled 反映便携命中', () => {
  const { root } = makePortableFixture('codex');
  assert.strictEqual(resolver.isInstalled('codex', { env: {}, toolsRoot: root }), true);
  assert.strictEqual(resolver.isInstalled('codex', { env: {}, toolsRoot: '/nope' }), false);
});

test('resolver: packageDir 拼接跨平台正确(scoped pkg 逐段)', () => {
  const dir = resolver.packageDir('claude', { env: {}, toolsRoot: '/r' });
  assert.ok(dir.includes(path.join('claude-portable', 'node_modules')));
  assert.ok(dir.endsWith(path.join('@anthropic-ai', 'claude-code')));
  assert.strictEqual(resolver.packageDir('aider', { toolsRoot: '/r' }), null);
});

// ─────────────────────── resolveSpawn / adapterSpawn ───────────────────────

test('resolveSpawn: 便携命中 → node 前缀 + 业务 args', () => {
  const { root, entryAbs } = makePortableFixture('codex');
  const r = resolver.resolveSpawn('codex', ['chat', '--foo'], {
    env: {}, toolsRoot: root, fallback: { command: 'codex', args: ['chat', '--foo'] },
  });
  assert.strictEqual(r.command, process.execPath);
  assert.deepStrictEqual(r.args, [entryAbs, 'chat', '--foo']);
  assert.strictEqual(r.resolvedFrom, 'portable');
});

test('resolveSpawn: 未命中 → 逐字节回退 fallback', () => {
  const r = resolver.resolveSpawn('codex', ['x'], {
    env: {}, toolsRoot: '/nope', fallback: { command: 'cmd.exe', args: ['/d', '/s', '/c', 'codex.cmd', 'x'] },
  });
  assert.strictEqual(r.command, 'cmd.exe');
  assert.deepStrictEqual(r.args, ['/d', '/s', '/c', 'codex.cmd', 'x']);
  assert.strictEqual(r.resolvedFrom, 'fallback');
});

test('adapterSpawn.forTool: 门关时 portableSpawn 回退、portableInstalled=false', () => {
  const prev = process.env.KHY_PORTABLE_CLI;
  process.env.KHY_PORTABLE_CLI = 'off';
  try {
    const { portableSpawn, portableInstalled } = adapterSpawn.forTool('codex');
    const r = portableSpawn(['a'], 'codex', ['a']);
    assert.strictEqual(r.command, 'codex');
    assert.deepStrictEqual(r.args, ['a']);
    assert.strictEqual(portableInstalled(), false);
  } finally {
    if (prev === undefined) delete process.env.KHY_PORTABLE_CLI; else process.env.KHY_PORTABLE_CLI = prev;
  }
});

test('adapterSpawn.forTool: 便携命中经 KHY_TOOLS_DIR → node 规格', () => {
  const { root, entryAbs } = makePortableFixture('claude');
  const prev = process.env.KHY_TOOLS_DIR;
  process.env.KHY_TOOLS_DIR = root;
  try {
    const { portableSpawn, portableInstalled } = adapterSpawn.forTool('claude');
    const r = portableSpawn(['--print'], 'claude', ['--print']);
    assert.strictEqual(r.command, process.execPath);
    assert.deepStrictEqual(r.args, [entryAbs, '--print']);
    assert.strictEqual(portableInstalled(), true);
  } finally {
    if (prev === undefined) delete process.env.KHY_TOOLS_DIR; else process.env.KHY_TOOLS_DIR = prev;
  }
});

// ─────────────────────────── installer (gate only, no network) ───────────────────────────

test('installer: 门 KHY_PORTABLE_CLI_INSTALL=off → gated,不触网', async () => {
  const r = await installer.install('codex', { env: { KHY_PORTABLE_CLI_INSTALL: 'off' } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.gated, true);
});

test('installer: 未知工具 → 明确错误', async () => {
  const r = await installer.install('aider', { env: {} });
  assert.strictEqual(r.ok, false);
  assert.ok(/未知/.test(r.error));
});

test('installer: isInstallEnabled 默认开、显式关', () => {
  assert.strictEqual(installer.isInstallEnabled({}), true);
  assert.strictEqual(installer.isInstallEnabled({ KHY_PORTABLE_CLI_INSTALL: 'no' }), false);
});

// ─────────────────────────── auto-install bridge ───────────────────────────

test('autoInstall: 门 off → 不尝试、gated', async () => {
  const prev = process.env.KHY_PORTABLE_CLI_AUTOINSTALL;
  process.env.KHY_PORTABLE_CLI_AUTOINSTALL = 'off';
  try {
    const r = await autoInstall.maybeAutoInstallPortable('claude', { getStatus: () => ({ available: false }) }, {});
    assert.strictEqual(r.attempted, false);
    assert.strictEqual(r.gated, true);
  } finally {
    if (prev === undefined) delete process.env.KHY_PORTABLE_CLI_AUTOINSTALL; else process.env.KHY_PORTABLE_CLI_AUTOINSTALL = prev;
  }
});

test('autoInstall: 非便携工具 → 不尝试', async () => {
  const r = await autoInstall.maybeAutoInstallPortable('kiro', { getStatus: () => ({ available: false }) }, { rl: {} });
  assert.strictEqual(r.attempted, false);
});

test('autoInstall: 无 rl / 非交互 → 不提示不安装', async () => {
  const r = await autoInstall.maybeAutoInstallPortable('claude', { getStatus: () => ({ available: false }) }, { rl: null });
  assert.strictEqual(r.attempted, false);
});

test('autoInstall: isAutoInstallEnabled 默认开、显式关', () => {
  assert.strictEqual(autoInstall.isAutoInstallEnabled({}), true);
  assert.strictEqual(autoInstall.isAutoInstallEnabled({ KHY_PORTABLE_CLI_AUTOINSTALL: '0' }), false);
});

