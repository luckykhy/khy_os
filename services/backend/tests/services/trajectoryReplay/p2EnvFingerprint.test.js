'use strict';

/**
 * p2EnvFingerprint.test.js — DESIGN-ARCH-048 PHASE 2 (environment fingerprint).
 *
 * Covers capture totality (required keys present, missing → null), the env-tunable
 * probe list / timeout (零硬编码), match on identical fingerprints, precise diff on
 * a changed field, and that a slow/hung probe never wedges capture (活跃度超时).
 */

const test = require('node:test');
const assert = require('node:assert');

const envFingerprint = require('../../../src/services/trajectoryReplay/envFingerprint');

test('capture returns all required keys and a populated default node probe', () => {
  const fp = envFingerprint.capture();
  for (const key of ['os', 'node', 'cwd', 'toolchain', 'manifestHash', 'capturedAt']) {
    assert.ok(Object.prototype.hasOwnProperty.call(fp, key), `missing key: ${key}`);
  }
  assert.ok(fp.os && typeof fp.os.platform === 'string');
  assert.strictEqual(fp.node, process.version);
  assert.strictEqual(typeof fp.cwd, 'string');
  // Default probe list is "node" and node is obviously present.
  assert.ok(Object.prototype.hasOwnProperty.call(fp.toolchain, 'node'));
  assert.ok(typeof fp.toolchain.node === 'string' && fp.toolchain.node.length > 0);
});

test('probe list and timeout are env-tunable (零硬编码)', () => {
  const origTools = process.env.KHY_REPLAY_FINGERPRINT_TOOLS;
  const origTimeout = process.env.KHY_REPLAY_PROBE_TIMEOUT_MS;
  try {
    process.env.KHY_REPLAY_FINGERPRINT_TOOLS = 'node, npm';
    assert.deepStrictEqual(envFingerprint._probeTools(), ['node', 'npm']);
    process.env.KHY_REPLAY_PROBE_TIMEOUT_MS = '1234';
    assert.strictEqual(envFingerprint._probeTimeoutMs(), 1234);
    // Empty/garbage falls back to defaults.
    process.env.KHY_REPLAY_FINGERPRINT_TOOLS = '';
    assert.deepStrictEqual(envFingerprint._probeTools(), ['node']);
    process.env.KHY_REPLAY_PROBE_TIMEOUT_MS = 'not-a-number';
    assert.strictEqual(envFingerprint._probeTimeoutMs(), envFingerprint.DEFAULT_PROBE_TIMEOUT_MS);
  } finally {
    if (origTools == null) delete process.env.KHY_REPLAY_FINGERPRINT_TOOLS; else process.env.KHY_REPLAY_FINGERPRINT_TOOLS = origTools;
    if (origTimeout == null) delete process.env.KHY_REPLAY_PROBE_TIMEOUT_MS; else process.env.KHY_REPLAY_PROBE_TIMEOUT_MS = origTimeout;
  }
});

test('a missing tool probes to null without throwing', () => {
  const orig = process.env.KHY_REPLAY_FINGERPRINT_TOOLS;
  try {
    process.env.KHY_REPLAY_FINGERPRINT_TOOLS = 'definitely-not-a-real-binary-xyz';
    const fp = envFingerprint.capture();
    assert.strictEqual(fp.toolchain['definitely-not-a-real-binary-xyz'], null);
  } finally {
    if (orig == null) delete process.env.KHY_REPLAY_FINGERPRINT_TOOLS; else process.env.KHY_REPLAY_FINGERPRINT_TOOLS = orig;
  }
});

test('compare matches identical fingerprints, ignoring capturedAt drift', () => {
  const a = { os: { platform: 'linux', arch: 'x64' }, node: 'v20.0.0', cwd: '/x', toolchain: { node: 'v20.0.0' }, manifestHash: 'abc', capturedAt: 1 };
  const b = { ...a, capturedAt: 999999 };
  const res = envFingerprint.compare(a, b);
  assert.strictEqual(res.match, true);
  assert.strictEqual(res.diffs.length, 0);
});

test('compare reports exactly one diff for a changed node version', () => {
  const a = { os: { platform: 'linux' }, node: 'v20.0.0', cwd: '/x', toolchain: { node: 'v20.0.0' }, manifestHash: null, capturedAt: 1 };
  const b = { os: { platform: 'linux' }, node: 'v22.0.0', cwd: '/x', toolchain: { node: 'v20.0.0' }, manifestHash: null, capturedAt: 2 };
  const res = envFingerprint.compare(a, b);
  assert.strictEqual(res.match, false);
  assert.strictEqual(res.diffs.length, 1);
  assert.strictEqual(res.diffs[0].field, 'node');
  assert.strictEqual(res.diffs[0].recorded, 'v20.0.0');
  assert.strictEqual(res.diffs[0].current, 'v22.0.0');
});

test('compare descends into nested toolchain/os objects', () => {
  const a = { toolchain: { node: 'v20', npm: '10' }, os: { platform: 'linux', arch: 'x64' } };
  const b = { toolchain: { node: 'v20', npm: '11' }, os: { platform: 'linux', arch: 'arm64' } };
  const res = envFingerprint.compare(a, b);
  const fields = res.diffs.map((d) => d.field).sort();
  assert.deepStrictEqual(fields, ['os.arch', 'toolchain.npm']);
});

test('a slow probe is bounded by the activity timeout and does not hang', () => {
  const origTools = process.env.KHY_REPLAY_FINGERPRINT_TOOLS;
  const origTimeout = process.env.KHY_REPLAY_PROBE_TIMEOUT_MS;
  try {
    // `sleep --version` returns fast on coreutils, but force a tiny timeout to
    // exercise the bound; either way capture must return promptly with a value.
    process.env.KHY_REPLAY_FINGERPRINT_TOOLS = 'sleep';
    process.env.KHY_REPLAY_PROBE_TIMEOUT_MS = '200';
    const start = Date.now();
    const fp = envFingerprint.capture();
    const elapsed = Date.now() - start;
    assert.ok(Object.prototype.hasOwnProperty.call(fp.toolchain, 'sleep'));
    assert.ok(elapsed < 5000, `capture took too long: ${elapsed}ms`);
  } finally {
    if (origTools == null) delete process.env.KHY_REPLAY_FINGERPRINT_TOOLS; else process.env.KHY_REPLAY_FINGERPRINT_TOOLS = origTools;
    if (origTimeout == null) delete process.env.KHY_REPLAY_PROBE_TIMEOUT_MS; else process.env.KHY_REPLAY_PROBE_TIMEOUT_MS = origTimeout;
  }
});
