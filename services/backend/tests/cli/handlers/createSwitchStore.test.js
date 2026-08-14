'use strict';

/**
 * Behavior tests for the createSwitchStore convergence inside cli/handlers/proxy.js.
 *
 * createSwitchStore is a private (non-exported) factory, so it is covered through the
 * four named thin bindings it backs (loadTraeSwitchStore / saveTraeSwitchStore /
 * loadWindsurfSwitchStore / saveWindsurfSwitchStore). Those bindings are also not in
 * module.exports; the host injects three of them into proxySwitchProfiles via
 * setProxySwitchProfilesDeps. We capture the injected references with a shim that
 * wraps the leaf's DI setter (forwarding the exact same deps, so host behavior is
 * unchanged), then exercise load/save semantics.
 *
 * Isolation: KHY_APP_HOME redirects utils/dataHome.getAppHome() to a fresh os.tmpdir()
 * sandbox BEFORE proxy.js computes KHY_DIR at require time, so no real ~/.khy data is
 * ever read or written. Store calls run in child node processes so each probe gets a
 * clean require cache with the sandboxed home. The sandbox is removed on exit.
 *
 * saveTraeSwitchStore is not DI-injected, so the Trae side is covered via the on-disk
 * contract of loadTraeSwitchStore (valid store honored, corrupt store → fallback);
 * both sides share the same factory, and the Windsurf save/load round-trip proves the
 * parameterized save path.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Must be set before proxy.js (and utils/dataHome) is required in any probe process.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-switchstore-test-'));
process.env.KHY_APP_HOME = TMP_HOME;

const proxyPath = require.resolve('../../../src/cli/handlers/proxy');
const leafPath = require.resolve('../../../src/cli/handlers/proxySwitchProfiles');
const proxyModule = require(proxyPath);

const TRAE_FILE = path.join(TMP_HOME, 'trae_switch_profiles.json');
const WINDSURF_FILE = path.join(TMP_HOME, 'windsurf_switch_profiles.json');

// Capture shim: wrap the leaf DI setter to grab the store function references the
// host injects, while forwarding the identical deps to the real setter.
const SHIM = path.join(TMP_HOME, '__capture_shim.js');
fs.writeFileSync(SHIM, [
  "'use strict';",
  `const leaf = require(${JSON.stringify(leafPath)});`,
  'const realSetter = leaf.setProxySwitchProfilesDeps;',
  'let captured = {};',
  'leaf.setProxySwitchProfilesDeps = (deps = {}) => { captured = { ...captured, ...deps }; return realSetter(deps); };',
  `require(${JSON.stringify(proxyPath)});`,
  'module.exports = captured;',
].join('\n'), 'utf-8');

/** Run a snippet in a child node process with the sandboxed KHY_APP_HOME. */
function probeCaptured(snippet) {
  const script = `const captured = require(${JSON.stringify(SHIM)});\n${snippet}`;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, KHY_APP_HOME: TMP_HOME },
    encoding: 'utf-8',
  });
  return out.trim();
}

function cleanStores() {
  for (const f of [TRAE_FILE, WINDSURF_FILE]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}

test.after(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('host module loads under sandboxed KHY_APP_HOME with contract exports intact', () => {
  for (const n of ['handleProxyTraeSwitch', 'handleProxyWindsurfSwitch', 'handleProxySwitchCenter', 'maybeAutoSyncSwitchCenter']) {
    assert.strictEqual(typeof proxyModule[n], 'function', `missing ${n}`);
  }
});

test('load returns { activeId: "", profiles: [] } fallback when store file is missing', () => {
  cleanStores();
  const out = probeCaptured(`
    const trae = captured.loadTraeSwitchStore();
    const wind = captured.loadWindsurfSwitchStore();
    console.log(JSON.stringify({ trae, wind }));
  `);
  const { trae, wind } = JSON.parse(out);
  assert.deepStrictEqual(trae, { activeId: '', profiles: [] });
  assert.deepStrictEqual(wind, { activeId: '', profiles: [] });
});

test('load returns fallback on corrupted JSON (no throw)', () => {
  cleanStores();
  fs.writeFileSync(TRAE_FILE, '{ not valid json !!!', 'utf-8');
  fs.writeFileSync(WINDSURF_FILE, '<<<garbage>>>', 'utf-8');
  const out = probeCaptured(`
    const trae = captured.loadTraeSwitchStore();
    const wind = captured.loadWindsurfSwitchStore();
    console.log(JSON.stringify({ trae, wind }));
  `);
  const { trae, wind } = JSON.parse(out);
  assert.deepStrictEqual(trae, { activeId: '', profiles: [] });
  assert.deepStrictEqual(wind, { activeId: '', profiles: [] });
  cleanStores();
});

test('windsurf save→load round-trips a valid profile and keeps a valid activeId', () => {
  cleanStores();
  const out = probeCaptured(`
    const saved = captured.saveWindsurfSwitchStore({
      activeId: 'alpha',
      profiles: [{ id: 'alpha', name: 'Alpha', endpoint: 'https://api.example.com/v1', key: 'k', models: ['model-a'] }],
    });
    const loaded = captured.loadWindsurfSwitchStore();
    console.log(JSON.stringify({ saved, loaded }));
  `);
  const { saved, loaded } = JSON.parse(out);
  assert.strictEqual(saved.activeId, 'alpha');
  assert.strictEqual(saved.profiles.length, 1);
  assert.strictEqual(saved.profiles[0].id, 'alpha');
  assert.deepStrictEqual(saved.profiles[0].models, ['model-a']);
  assert.strictEqual(loaded.activeId, 'alpha');
  assert.strictEqual(loaded.profiles.length, 1);
  assert.strictEqual(loaded.profiles[0].endpoint, saved.profiles[0].endpoint);
  // Store file lands in the sandbox, never in the real .khy dir.
  assert.ok(fs.existsSync(WINDSURF_FILE), 'windsurf store file written to sandbox');
  cleanStores();
});

test('save normalizes an invalid activeId to empty string', () => {
  cleanStores();
  const out = probeCaptured(`
    const saved = captured.saveWindsurfSwitchStore({
      activeId: 'does-not-exist',
      profiles: [{ id: 'beta', endpoint: 'https://api.example.com/v1', models: ['model-b'] }],
    });
    console.log(JSON.stringify(saved));
  `);
  const saved = JSON.parse(out);
  assert.strictEqual(saved.activeId, '');
  assert.strictEqual(saved.profiles.length, 1);
  assert.strictEqual(saved.profiles[0].id, 'beta');
  cleanStores();
});

test('trae and windsurf stores are isolated by their storeFile parameter', () => {
  cleanStores();
  fs.writeFileSync(TRAE_FILE, JSON.stringify({
    activeId: 'gamma',
    profiles: [{ id: 'gamma', name: 'Gamma', endpoint: 'https://api.example.com/v1', models: ['model-c'] }],
  }, null, 2), 'utf-8');
  const out = probeCaptured(`
    const trae = captured.loadTraeSwitchStore();
    const wind = captured.loadWindsurfSwitchStore();
    console.log(JSON.stringify({ trae, wind }));
  `);
  const { trae, wind } = JSON.parse(out);
  assert.strictEqual(trae.activeId, 'gamma');
  assert.strictEqual(trae.profiles.length, 1);
  // Windsurf file untouched → its own fallback, proving parameterized isolation.
  assert.deepStrictEqual(wind, { activeId: '', profiles: [] });
  cleanStores();
});
