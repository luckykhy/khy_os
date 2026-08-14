'use strict';

/**
 * openclawHome — pins the pure leaf resolving OpenClaw's on-disk state home so
 * every khy↔OpenClaw bridge computes the same root. Zero-IO: homedir + env are
 * injected, so the suite is deterministic (POSIX path assertions). Covers the
 * override precedence (KHY_OPENCLAW_DATA_HOME > OPENCLAW_STATE_DIR > default),
 * --profile mirroring, homedir optionality, and fail-soft on junk (never throws).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { openclawStateDir } = require('../src/utils/openclawHome');

test('default: <homedir>/.openclaw when no override', () => {
  assert.strictEqual(openclawStateDir({ homedir: '/home/u', env: {} }), path.join('/home/u', '.openclaw'));
});

test('KHY_OPENCLAW_DATA_HOME wins over everything', () => {
  const dir = openclawStateDir({
    homedir: '/home/u',
    env: { KHY_OPENCLAW_DATA_HOME: '/custom/oc', OPENCLAW_STATE_DIR: '/other', KHY_OPENCLAW_PROFILE: 'work' },
  });
  assert.strictEqual(dir, '/custom/oc');
});

test('OPENCLAW_STATE_DIR used when no khy override', () => {
  assert.strictEqual(
    openclawStateDir({ homedir: '/home/u', env: { OPENCLAW_STATE_DIR: '/oc/state' } }),
    '/oc/state',
  );
});

test('KHY_OPENCLAW_PROFILE → ~/.openclaw-<name> (mirrors --profile)', () => {
  assert.strictEqual(
    openclawStateDir({ homedir: '/home/u', env: { KHY_OPENCLAW_PROFILE: 'work' } }),
    path.join('/home/u', '.openclaw-work'),
  );
});

test('no homedir and no override → empty string', () => {
  assert.strictEqual(openclawStateDir({ env: {} }), '');
  assert.strictEqual(openclawStateDir({}), '');
  assert.strictEqual(openclawStateDir(), '');
});

test('blank/whitespace override is ignored (falls through to default)', () => {
  assert.strictEqual(
    openclawStateDir({ homedir: '/home/u', env: { KHY_OPENCLAW_DATA_HOME: '   ' } }),
    path.join('/home/u', '.openclaw'),
  );
});

test('never throws on junk input', () => {
  assert.doesNotThrow(() => openclawStateDir({ homedir: {}, env: 5 }));
  assert.doesNotThrow(() => openclawStateDir({ homedir: 123, env: { KHY_OPENCLAW_DATA_HOME: {} } }));
});
