'use strict';

/**
 * Tests for the unified management plane (MCR): contract validation, the
 * single-funnel registry, and the CLI⇄Web parity guard.
 *
 * The registry is exercised with synthetic in-memory contracts via _reset(),
 * so these tests touch no real DB / files / processes. A final group loads the
 * real management/index to assert the shipped 3 resources pass parity.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { validateContract, SOURCE_KINDS } = require('../src/services/management/resourceContract');
const registry = require('../src/services/management/managementRegistry');
const { checkParity } = require('../src/services/management/parityGuard');

function fakeContract(over = {}) {
  return {
    id: 'thing',
    label: 'Thing',
    source: 'file',
    sourceDetail: '/tmp/thing.json',
    capabilities: ['list'],
    ops: { list: async () => ({ items: [] }) },
    ...over,
  };
}

describe('resourceContract.validateContract', () => {
  test('accepts a well-formed contract', () => {
    const { ok, errors } = validateContract(fakeContract());
    assert.equal(ok, true, errors.join('; '));
  });

  test('rejects bad id, missing source, and capability/op misalignment', () => {
    assert.equal(validateContract(fakeContract({ id: 'Bad ID' })).ok, false);
    assert.equal(validateContract(fakeContract({ source: 'cloud' })).ok, false);
    // capability declared but no op impl
    assert.equal(
      validateContract(fakeContract({ capabilities: ['list', 'add'], ops: { list: async () => {} } })).ok,
      false
    );
    // op present that is not in capabilities
    assert.equal(
      validateContract(fakeContract({ ops: { list: async () => {}, secret: async () => {} } })).ok,
      false
    );
  });

  test('source kinds are the documented closed set', () => {
    assert.deepEqual([...SOURCE_KINDS].sort(), ['db', 'env', 'file', 'process']);
  });
});

describe('managementRegistry single funnel', () => {
  beforeEach(() => registry._reset());

  test('register + invoke routes through the contract op', async () => {
    let sawCtx = null;
    registry.register(fakeContract({
      ops: {
        list: async (args, ctx) => { sawCtx = ctx; return { items: [1, 2] }; },
      },
    }));
    const out = await registry.invoke('thing', 'list', {}, { source: 'web', user: { id: 7 } });
    assert.deepEqual(out, { items: [1, 2] });
    assert.equal(sawCtx.source, 'web');
    assert.equal(sawCtx.user.id, 7);
  });

  test('blocks two resources sharing one source-of-truth', () => {
    registry.register(fakeContract({ id: 'a', sourceDetail: '/tmp/shared.json' }));
    assert.throws(
      () => registry.register(fakeContract({ id: 'b', sourceDetail: '/tmp/shared.json' })),
      (err) => err.code === 'SOURCE_CONFLICT'
    );
  });

  test('invoke throws on unknown resource and unsupported op', async () => {
    registry.register(fakeContract());
    await assert.rejects(() => registry.invoke('nope', 'list', {}, {}), (err) => err.code === 'UNKNOWN_RESOURCE');
    await assert.rejects(() => registry.invoke('thing', 'destroy', {}, {}), (err) => err.code === 'UNSUPPORTED_OP');
  });

  test('describe() returns a sorted resource × capability matrix', () => {
    registry.register(fakeContract({ id: 'zeta', sourceDetail: '/tmp/z' }));
    registry.register(fakeContract({ id: 'alpha', sourceDetail: '/tmp/a' }));
    const ids = registry.describe().map((r) => r.id);
    assert.deepEqual(ids, ['alpha', 'zeta']);
  });
});

describe('parityGuard', () => {
  beforeEach(() => registry._reset());

  test('passes when CLI sub-commands match registry resources', () => {
    registry.register(fakeContract({ id: 'users', sourceDetail: 'users' }));
    registry.register(fakeContract({ id: 'api-keys', sourceDetail: '/tmp/keys' }));
    const fakeSchema = { getRouterSubCommands: () => ({ manage: ['list', 'users', 'api-keys'] }) };
    const { ok, errors } = checkParity({ registry, commandSchema: fakeSchema });
    assert.equal(ok, true, errors.join('; '));
  });

  test('fails when CLI sub-commands drift from registry resources', () => {
    registry.register(fakeContract({ id: 'users', sourceDetail: 'users' }));
    const fakeSchema = { getRouterSubCommands: () => ({ manage: ['list', 'users', 'ghost'] }) };
    const { ok, errors } = checkParity({ registry, commandSchema: fakeSchema });
    assert.equal(ok, false);
    assert.match(errors.join(' '), /CLI_PARITY/);
  });
});

describe('shipped management resources', () => {
  test('the real registry (7 resources) passes parity', () => {
    // Clear any synthetic contracts left by earlier blocks, then let the index
    // re-register the shipped resources into the clean registry.
    registry._reset();
    const real = require('../src/services/management');
    real.ensureRegistered();
    const ids = real.listIds().sort();
    assert.deepEqual(ids, [
      'api-keys', 'cron', 'custom-providers', 'dependencies',
      'model-config', 'model-overrides', 'users',
    ]);
    const { ok, errors } = checkParity();
    assert.equal(ok, true, errors.join('; '));
  });

  test('model-config get masks the API key (never returns raw)', async () => {
    registry._reset();
    const real = require('../src/services/management');
    real.ensureRegistered();
    const prevKey = process.env.RELAY_API_KEY;
    process.env.RELAY_API_KEY = 'sk-supersecretkey123456';
    try {
      const snap = await real.invoke('model-config', 'get', {}, { source: 'web' });
      assert.equal(snap.hasApiKey, true);
      assert.ok(!('apiKey' in snap), 'snapshot must not contain a raw apiKey field');
      assert.ok(!String(snap.apiKeyMasked).includes('supersecretkey'), 'masked key must not leak the secret');
      assert.match(snap.apiKeyMasked, /\.\.\./);
    } finally {
      if (prevKey === undefined) delete process.env.RELAY_API_KEY;
      else process.env.RELAY_API_KEY = prevKey;
    }
  });

  test('custom-providers list never echoes raw keys', async () => {
    registry._reset();
    const real = require('../src/services/management');
    real.ensureRegistered();
    const out = await real.invoke('custom-providers', 'list', {}, { source: 'web' });
    assert.ok(Array.isArray(out.providers));
    for (const p of out.providers) {
      assert.ok(!('key' in p) && !('keyInput' in p) && !('apiKey' in p),
        'provider entries must expose only metadata + keyCount');
      assert.equal(typeof p.keyCount, 'number');
    }
  });
});

describe('dataHome legacy migration (read-old-write-new, never delete)', () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  // Each case runs in a fresh node process so the service module resolves its
  // data paths from a sandboxed HOME + KHY_DATA_HOME set before require time.
  function runMigration({ legacyRel, requireExpr, payload }) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mig-home-'));
    const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mig-data-'));
    const legacyFile = path.join(home, '.khyquant', legacyRel);
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, payload, 'utf-8');

    const script = `
      const svc = ${requireExpr};
      svc.__trigger();
    `;
    const targetFile = path.join(dataHome, legacyRel);
    execFileSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        KHY_DATA_HOME: dataHome,
        KHY_MODEL_OVERRIDES_FILE: '',
        KHY_CRON_JOBS_FILE: '',
        KHY_CRON_GROWTH_DIR: '',
      },
      cwd: path.resolve(__dirname, '..'),
    });

    assert.ok(fs.existsSync(targetFile), `migrated file should exist at ${targetFile}`);
    assert.equal(fs.readFileSync(targetFile, 'utf-8'), payload, 'content must be copied verbatim');
    assert.ok(fs.existsSync(legacyFile), 'legacy file must NOT be deleted');
  }

  test('customProviderRegistry migrates custom_providers.json', () => {
    runMigration({
      legacyRel: 'custom_providers.json',
      payload: '[]',
      requireExpr: `(() => { const m = require('./src/services/customProviderRegistry'); return { __trigger: () => m.listProviders() }; })()`,
    });
  });

  test('modelCuration migrates model_overrides.json', () => {
    runMigration({
      legacyRel: 'model_overrides.json',
      payload: '{}',
      requireExpr: `(() => { const m = require('./src/services/gateway/modelCuration'); return { __trigger: () => m.getOverrides() }; })()`,
    });
  });

  test('cronScheduler migrates growth/cron_jobs.json', () => {
    runMigration({
      legacyRel: path.join('growth', 'cron_jobs.json'),
      payload: '{"version":1,"jobs":{}}',
      requireExpr: `(() => { const m = require('./src/services/cronScheduler'); return { __trigger: () => m.listJobs() }; })()`,
    });
  });
});
