'use strict';

/**
 * proxy core CLI face — node:test coverage.
 *
 * Pure formatters + fail-soft runCore (DI fake installer, captured `out`), plus
 * source-level wiring assertions (proxy.js delegates gated; router.js dispatches
 * the `core` subcommand; flagRegistry registers the gate).
 *
 * Run: node --test services/backend/tests/cli/proxyCoreInstallHandler.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const H = require('../../src/cli/handlers/proxyCoreInstallHandler');

const DESC = {
  version: 'v1.18.10',
  releasesPage: 'https://github.com/MetaCubeX/mihomo/releases',
  binDir: '/home/u/.khyquant/bin',
  dest: '/home/u/.khyquant/bin/mihomo',
  platform: 'linux',
  arch: 'x64',
  supported: true,
  assetFile: 'mihomo-linux-amd64-compatible-v1.18.10.gz',
  url: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.18.10/mihomo-linux-amd64-compatible-v1.18.10.gz',
  kind: 'gz',
};

// ── pure: formatDownloadHint ────────────────────────────────────────────────
test('formatDownloadHint: gives exact URL + landing path', () => {
  const lines = H.formatDownloadHint(DESC);
  assert.ok(lines.some((l) => l.includes(DESC.url)), 'must include official URL');
  assert.ok(lines.some((l) => l.includes(DESC.dest)), 'must include landing path');
});

test('formatDownloadHint: cold platform (unsupported) → releases page + manual note', () => {
  const lines = H.formatDownloadHint({ ...DESC, supported: false, url: undefined });
  assert.ok(lines.some((l) => l.includes(DESC.releasesPage)), 'falls back to releases page');
  assert.ok(lines.some((l) => l.includes('自选对应架构')), 'manual-pick note present');
});

test('formatDownloadHint: null/garbage descriptor → empty, never throws', () => {
  assert.deepStrictEqual(H.formatDownloadHint(null), []);
  assert.deepStrictEqual(H.formatDownloadHint(42), []);
});

// ── pure: formatCoreInstallResult ───────────────────────────────────────────
test('install result: existing → ok, path shown', () => {
  const { ok, lines } = H.formatCoreInstallResult({ success: true, method: 'existing', path: '/p/mihomo' }, DESC);
  assert.strictEqual(ok, true);
  assert.ok(lines[0].includes('/p/mihomo'));
  assert.ok(lines[0].includes('✓'));
});

test('install result: adopted → shows source', () => {
  const { ok, lines } = H.formatCoreInstallResult(
    { success: true, method: 'adopted', path: '/p/mihomo', source: '/usr/bin/mihomo' }, DESC);
  assert.strictEqual(ok, true);
  assert.ok(lines[0].includes('/usr/bin/mihomo'));
});

test('install result: downloaded-verified → version + integrity tag', () => {
  const { ok, lines } = H.formatCoreInstallResult(
    { success: true, method: 'downloaded-verified', integrity: 'sha256-pinned', path: '/p/mihomo', version: 'v1.18.10' }, DESC);
  assert.strictEqual(ok, true);
  assert.ok(lines[0].includes('v1.18.10'), 'version shown');
  assert.ok(lines[0].includes('sha256-pinned'), 'integrity tag shown');
});

test('install result: disabled → warn + guidance + where-to-download tail', () => {
  const { ok, lines } = H.formatCoreInstallResult(
    { success: false, reason: 'disabled', guidance: '自动下载内核未启用(KHY_PROXY_CORE_AUTO_INSTALL=0)。' }, DESC);
  assert.strictEqual(ok, false);
  assert.ok(lines[0].includes('未启用'));
  assert.ok(lines.some((l) => l.includes(DESC.url)), 'failure always surfaces the URL');
});

test('install result: error reason → structured, still gives URL', () => {
  const { ok, lines } = H.formatCoreInstallResult(
    { success: false, reason: 'download-failed', error: 'socket hang up' }, DESC);
  assert.strictEqual(ok, false);
  assert.ok(lines.some((l) => l.includes('download-failed')), 'reason surfaced');
  assert.ok(lines.some((l) => l.includes('socket hang up')), 'error detail surfaced');
  assert.ok(lines.some((l) => l.includes(DESC.url)), 'URL still given');
});

test('install result: garbage/no result → treated as failure, never throws', () => {
  const { ok, lines } = H.formatCoreInstallResult(null, DESC);
  assert.strictEqual(ok, false);
  assert.ok(lines.length > 0);
});

// ── pure: formatCoreStatus ──────────────────────────────────────────────────
test('status: installed → single ok line, no download noise', () => {
  const lines = H.formatCoreStatus({ installed: true, path: '/p/mihomo', descriptor: DESC });
  assert.ok(lines[0].includes('已安装'));
  assert.ok(!lines.some((l) => l.includes(DESC.url)), 'no where-to-download when already installed');
});

test('status: not installed → install hint + where-to-download', () => {
  const lines = H.formatCoreStatus({ installed: false, path: null, descriptor: DESC });
  assert.ok(lines.some((l) => l.includes('proxy core install')), 'suggests the install command');
  assert.ok(lines.some((l) => l.includes(DESC.url)), 'gives the URL');
});

// ── runCore (DI fake installer, captured out) ───────────────────────────────
function fakeInstaller(overrides = {}) {
  return {
    describeCoreDownload: () => DESC,
    isInstalled: () => false,
    _binaryPath: () => DESC.dest,
    install: async () => ({ success: true, method: 'downloaded-verified', integrity: 'sha256-pinned', path: DESC.dest, version: 'v1.18.10' }),
    ...overrides,
  };
}

test('runCore install: happy path → ok, prints success', async () => {
  const out = [];
  const res = await H.runCore({ action: 'install', env: {}, out: (l) => out.push(l), installer: fakeInstaller() });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.action, 'install');
  assert.ok(out.some((l) => l.includes('已下载并安装')), 'prints success line');
});

test('runCore install: disabled → ok:false, prints URL', async () => {
  const out = [];
  const res = await H.runCore({
    action: 'install', env: {}, out: (l) => out.push(l),
    installer: fakeInstaller({ install: async () => ({ success: false, reason: 'disabled', guidance: 'x' }) }),
  });
  assert.strictEqual(res.ok, false);
  assert.ok(out.some((l) => l.includes(DESC.url)));
});

test('runCore install: installer.install throws → fail-soft, ok:false, no throw', async () => {
  const out = [];
  const res = await H.runCore({
    action: 'install', env: {}, out: (l) => out.push(l),
    installer: fakeInstaller({ install: async () => { throw new Error('boom'); } }),
  });
  assert.strictEqual(res.ok, false);
  assert.ok(out.some((l) => l.includes('boom')), 'surfaces the thrown error');
});

test('runCore status: not installed → ok:false, prints where-to-download', async () => {
  const out = [];
  const res = await H.runCore({ action: 'status', env: {}, out: (l) => out.push(l), installer: fakeInstaller() });
  assert.strictEqual(res.action, 'status');
  assert.strictEqual(res.ok, false);
  assert.ok(out.some((l) => l.includes(DESC.url)));
});

test('runCore status: installed → ok:true', async () => {
  const out = [];
  const res = await H.runCore({
    action: 'status', env: {}, out: (l) => out.push(l),
    installer: fakeInstaller({ isInstalled: () => true }),
  });
  assert.strictEqual(res.ok, true);
  assert.ok(out.some((l) => l.includes('已安装')));
});

test('runCore: describeCoreDownload throwing does not break the run', async () => {
  const out = [];
  const res = await H.runCore({
    action: 'status', env: {}, out: (l) => out.push(l),
    installer: fakeInstaller({ describeCoreDownload: () => { throw new Error('desc-fail'); } }),
  });
  assert.strictEqual(res.action, 'status'); // still returns, no throw
});

// ── source-level wiring (readFileSync + regex) ──────────────────────────────
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '../../', rel), 'utf8');

test('wiring: proxy.js handleProxyCore is gated + delegates to the leaf', () => {
  const src = SRC('src/cli/handlers/proxy.js');
  assert.match(src, /async function handleProxyCore\(/, 'wrapper defined');
  assert.match(src, /KHY_PROXY_CORE_INSTALL_CLI/, 'gated by the flag');
  assert.match(src, /return handleProxyHelp\(\);/, 'gate off → byte-revert to help');
  assert.match(src, /proxyCoreInstallHandler'\)\.runCore/, 'delegates to leaf runCore');
  assert.match(src, /handleProxyCore,/, 'exported');
});

test('wiring: router.js dispatches the core subcommand', () => {
  const src = SRC('src/cli/router.js');
  assert.match(src, /subCommand === 'core'\)\s*await proxy\.handleProxyCore\(/, 'router routes proxy core');
});

test('wiring: flagRegistry registers KHY_PROXY_CORE_INSTALL_CLI default-on', () => {
  const src = SRC('src/services/flagRegistry.js');
  assert.match(src, /KHY_PROXY_CORE_INSTALL_CLI:\s*\{\s*mode:\s*'default-on'/, 'registered default-on');
});
