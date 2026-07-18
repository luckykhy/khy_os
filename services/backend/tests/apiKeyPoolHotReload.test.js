/**
 * apiKeyPool.reload() + apiKeyPoolWatcher — hot-reload without a restart.
 *
 * The pool reads its three sources (api_keys.json + env + builtins) once at
 * init(). reload() re-derives the desired set and reconciles it by key id,
 * preserving runtime state on survivors, adding newcomers, and removing vanished
 * keys (freeing their concurrency slot). The watcher overlays .env key vars into
 * process.env and calls reload() on a content change, deduped by SHA-256.
 *
 * We isolate the singleton by pointing KHY_DATA_HOME at a throwaway dir BEFORE
 * requiring the module, so POOL_FILE lands there.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-keypool-'));
process.env.KHY_DATA_HOME = TMP;
// Deterministic env baseline — clear any inherited provider keys so the test
// controls the env source entirely.
for (const k of Object.keys(process.env)) {
  if (/_API_KEY(S)?(_\d+)?$/i.test(k) || /_API_ENDPOINT$/i.test(k)) delete process.env[k];
}

const POOL_FILE = path.join(TMP, 'api_keys.json');

function writePool(obj) {
  fs.writeFileSync(POOL_FILE, JSON.stringify(obj, null, 2), 'utf-8');
}
function findKey(provider, label) {
  return pool.getPoolStatus(provider).find(e => e.label === label);
}

const pool = require('../src/services/apiKeyPool');

describe('apiKeyPool.reload()', () => {
  beforeAll(() => {
    // Seed a persisted key for deepseek, then init the pool from it.
    writePool({ deepseek: [{ key: 'sk-ds-original', endpoint: 'https://api.deepseek.com/v1', priority: 5, label: 'file' }] });
    pool.init();
  });

  test('getPoolFilePath points at the data-home api_keys.json', () => {
    expect(pool.getPoolFilePath()).toBe(POOL_FILE);
  });

  test('init loaded the persisted key as active', () => {
    expect(findKey('deepseek', 'file')).toBeDefined();
  });

  test('reload preserves runtime state (cooldown/stats) on a surviving key', () => {
    const picked = pool.pick('deepseek');
    expect(picked).toBeTruthy();
    const keyId = picked.keyId;
    // Drive runtime state: a 429 records a failure and applies a cooldown.
    pool.markFailure(keyId, 429);
    const before = pool.getPoolStatus('deepseek').find(e => e.keyId === keyId);
    expect(before.totalFailures).toBeGreaterThan(0);
    expect(before.status).toBe('cooldown');
    expect(before.cooldownRemaining).toBeGreaterThan(0);

    // Reload with the SAME on-disk content → same id → state must survive.
    const r = pool.reload();
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);

    const after = pool.getPoolStatus('deepseek').find(e => e.keyId === keyId);
    expect(after).toBeDefined();
    expect(after.totalFailures).toBe(before.totalFailures);
    expect(after.status).toBe('cooldown');
    expect(after.cooldownRemaining).toBeGreaterThan(0);
  });

  test('reload adds a newly-persisted key (observable via pick + endpoint)', () => {
    writePool({
      deepseek: [{ key: 'sk-ds-original', endpoint: 'https://api.deepseek.com/v1', priority: 5, label: 'file' }],
      openai: [{ key: 'sk-oa-new', endpoint: 'https://api.openai.com/v1', priority: 0, label: 'file' }],
    });
    const r = pool.reload();
    expect(r.added).toBe(1);
    expect(pool.getProviders()).toContain('openai');
    const picked = pool.pick('openai');
    expect(picked.keyId).toBeTruthy();
    expect(picked.endpoint).toBe('https://api.openai.com/v1');
  });

  test('reload refreshes mutable metadata (endpoint/priority) on the same key', () => {
    writePool({
      deepseek: [{ key: 'sk-ds-original', endpoint: 'https://api.deepseek.com/v1', priority: 5, label: 'file' }],
      openai: [{ key: 'sk-oa-new', endpoint: 'https://relay.example/v1', priority: 7, label: 'file' }],
    });
    const r = pool.reload();
    expect(r.updated).toBeGreaterThanOrEqual(1);
    expect(r.added).toBe(0);
    const picked = pool.pick('openai');
    expect(picked.endpoint).toBe('https://relay.example/v1'); // endpoint refreshed in place
  });

  test('reload picks up a key added via an env var (read from process.env)', () => {
    process.env.QWEN_API_KEY = 'sk-qwen-from-env';
    const r = pool.reload();
    expect(r.added).toBe(1);
    expect(findKey('qwen', 'env')).toBeDefined();
  });

  test('reload never persists env keys back to api_keys.json', () => {
    pool.reload();
    const onDisk = JSON.parse(fs.readFileSync(POOL_FILE, 'utf-8'));
    expect(onDisk.qwen).toBeUndefined(); // env-sourced key must not be written
  });

  test('reload removes a vanished key', () => {
    const oa = findKey('openai', 'file');
    expect(oa).toBeDefined();
    const oaId = oa.keyId;
    // Drop openai from the file entirely (env qwen stays via process.env).
    writePool({ deepseek: [{ key: 'sk-ds-original', endpoint: 'https://api.deepseek.com/v1', priority: 5, label: 'file' }] });
    const r = pool.reload();
    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(pool.getProviders()).not.toContain('openai');
    expect(pool.getPoolStatus('openai').find(e => e.keyId === oaId)).toBeUndefined();
    // qwen (env) survives because it is still in process.env.
    expect(findKey('qwen', 'env')).toBeDefined();
  });
});

describe('apiKeyPoolWatcher', () => {
  const watcher = require('../src/services/apiKeyPoolWatcher');

  afterEach(() => {
    try { watcher.stop(); } catch { /* ignore */ }
    delete process.env.KHY_DISABLE_KEYPOOL_WATCH;
  });

  test('overlayEnvFile overlays only key/endpoint vars, never unrelated keys', () => {
    const envPath = path.join(TMP, 'overlay.env');
    fs.writeFileSync(envPath,
      'GLM_API_KEY=sk-glm-overlay\nGLM_API_ENDPOINT=https://glm/v1\nUNRELATED=nope\n', 'utf-8');
    delete process.env.GLM_API_KEY;
    delete process.env.GLM_API_ENDPOINT;
    delete process.env.UNRELATED;
    const applied = watcher.__testHooks.overlayEnvFile(envPath);
    expect(applied).toBe(2); // key + endpoint, not UNRELATED
    expect(process.env.GLM_API_KEY).toBe('sk-glm-overlay');
    expect(process.env.GLM_API_ENDPOINT).toBe('https://glm/v1');
    expect(process.env.UNRELATED).toBeUndefined();
  });

  test('start() is a no-op when KHY_DISABLE_KEYPOOL_WATCH=1', () => {
    process.env.KHY_DISABLE_KEYPOOL_WATCH = '1';
    watcher.start();
    expect(watcher.getStatus().running).toBe(false);
  });

  test('start() watches the pool target and triggerReloadNow reloads', () => {
    watcher.start();
    const status = watcher.getStatus();
    expect(status.running).toBe(true);
    expect(status.watchers.some(w => w.path === pool.getPoolFilePath())).toBe(true);
    const r = watcher.triggerReloadNow();
    expect(typeof r.total).toBe('number');
  });

  test('reloadFrom dedups by content hash (no reload when bytes unchanged)', () => {
    watcher.start();
    const target = pool.getPoolFilePath();
    const before = watcher.getStatus().stats.reloads;
    // Hash was seeded with current content at start() → unchanged → no reload.
    const did = watcher.__testHooks.reloadFrom(target);
    expect(did).toBe(false);
    expect(watcher.getStatus().stats.reloads).toBe(before);
  });
});
