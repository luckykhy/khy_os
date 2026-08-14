'use strict';

/**
 * installLedger.test.js — 安装台账纯核心叶子契约锁死(node:test)。
 *
 * 台账是「干净卸载」的真源:创建副作用当刻记「实际写了什么」,卸载时逆序回滚。
 * 本套件锁死:
 *   - recordSideEffect:归一化 + 密钥形态丢弃 + 门关返 null + 非法入参返 null;
 *   - computeRollback:逆序、按 target 去重、registration/process 先于 file、未知 action 进 skipped、
 *     门关返空步骤、非数组返空;
 *   - ledgerPath:纯拼接、非法返 null;
 *   - 门控 KHY_INSTALL_LEDGER 默认开,CANON off 值 → 关;
 *   - 绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  isLedgerEnabled,
  ledgerPath,
  recordSideEffect,
  computeRollback,
  describeInstallLedger,
  LEDGER_FILENAME,
  KIND,
} = require('../../src/services/uninstall/installLedger');

test('gate default-on; CANON off values close it (byte-revert)', () => {
  assert.equal(isLedgerEnabled({}), true);
  assert.equal(isLedgerEnabled({ KHY_INSTALL_LEDGER: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(isLedgerEnabled({ KHY_INSTALL_LEDGER: off }), false, `off word ${off}`);
  }
});

test('recordSideEffect normalizes a file entry with resolved absolute path', () => {
  const rec = recordSideEffect({
    kind: KIND.FILE,
    target: '/tmp/khy/foo/../foo/bar.js',
    action: 'unlink',
    checksum: 'abc123',
    ts: 1700000000000,
  }, { env: {} });
  assert.ok(rec);
  assert.equal(rec.v, 1);
  assert.equal(rec.kind, 'file');
  assert.equal(rec.target, '/tmp/khy/foo/bar.js');
  assert.equal(rec.action, 'unlink');
  assert.equal(rec.checksum, 'abc123');
  assert.equal(rec.ts, 1700000000000);
});

test('recordSideEffect keeps non-path targets verbatim for registration/process', () => {
  const reg = recordSideEffect({ kind: KIND.REGISTRATION, target: 'autostart:linux', action: 'unregister-autostart' }, { env: {} });
  assert.equal(reg.target, 'autostart:linux');
  const proc = recordSideEffect({ kind: KIND.PROCESS, target: 'md-bridge', action: 'stop-process' }, { env: {} });
  assert.equal(proc.target, 'md-bridge');
});

test('recordSideEffect returns null when gate off (does not record)', () => {
  const rec = recordSideEffect({ kind: KIND.FILE, target: '/tmp/x', action: 'unlink' }, { env: { KHY_INSTALL_LEDGER: 'off' } });
  assert.equal(rec, null);
});

test('recordSideEffect rejects malformed / unknown-kind entries', () => {
  assert.equal(recordSideEffect(null, { env: {} }), null);
  assert.equal(recordSideEffect({}, { env: {} }), null);
  assert.equal(recordSideEffect({ kind: 'bogus', target: '/tmp/x', action: 'unlink' }, { env: {} }), null);
  assert.equal(recordSideEffect({ kind: KIND.FILE, target: '', action: 'unlink' }, { env: {} }), null);
  assert.equal(recordSideEffect({ kind: KIND.FILE, target: '/tmp/x', action: '' }, { env: {} }), null);
});

test('recordSideEffect drops secret-shaped meta values; keeps allowlisted scalars', () => {
  const rec = recordSideEffect({
    kind: KIND.FILE,
    target: '/tmp/x',
    action: 'unlink',
    meta: {
      scope: 'user',
      platform: 'linux',
      token: 'sk-abcdef0123456789abcdef0123456789', // secret-shaped → dropped
      apiKey: 'super-secret-value',                  // key name → dropped
      random: 'notallowed',                           // not in allowlist → dropped
      label: 'md-editor',
    },
  }, { env: {} });
  assert.deepEqual(rec.meta, { scope: 'user', platform: 'linux', label: 'md-editor' });
});

test('recordSideEffect never throws on hostile input', () => {
  assert.doesNotThrow(() => recordSideEffect({ kind: KIND.FILE, target: 123, action: {} }, { env: {} }));
  assert.doesNotThrow(() => recordSideEffect(undefined, {}));
});

test('computeRollback reverses order and orders registration/process before file/dir', () => {
  const entries = [
    { kind: 'file', target: '/a/one.js', action: 'unlink' },
    { kind: 'dir', target: '/a/dir', action: 'rmdir' },
    { kind: 'registration', target: 'md-editor', action: 'unregister-md-editor' },
    { kind: 'process', target: 'daemon', action: 'stop-process' },
    { kind: 'file', target: '/a/two.js', action: 'unlink' },
  ];
  const { steps } = computeRollback(entries, { env: {} });
  // registration + process first (in reverse-encounter order), then dir, then files.
  assert.deepEqual(steps.map((s) => s.kind), ['registration', 'process', 'dir', 'file', 'file']);
  // files preserve reverse-creation order: two.js recorded after one.js → two.js rolled back first.
  const files = steps.filter((s) => s.kind === 'file').map((s) => s.target);
  assert.deepEqual(files, ['/a/two.js', '/a/one.js']);
});

test('computeRollback dedupes by target, keeping the last recorded entry', () => {
  const entries = [
    { kind: 'file', target: '/a/x.js', action: 'unlink', checksum: 'old' },
    { kind: 'file', target: '/a/x.js', action: 'unlink', checksum: 'new' },
  ];
  const { steps } = computeRollback(entries, { env: {} });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].checksum, 'new'); // last write wins (reverse traversal hits it first)
});

test('computeRollback routes unknown actions to skipped (never silently executes)', () => {
  const entries = [
    { kind: 'file', target: '/a/x.js', action: 'rm -rf /' }, // unknown → skipped
    { kind: 'file', target: '/a/y.js', action: 'unlink' },
  ];
  const { steps, skipped } = computeRollback(entries, { env: {} });
  assert.deepEqual(steps.map((s) => s.target), ['/a/y.js']);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'unknown-action');
});

test('computeRollback returns empty steps when gate off / not an array', () => {
  assert.deepEqual(computeRollback([{ kind: 'file', target: '/a', action: 'unlink' }], { env: { KHY_INSTALL_LEDGER: '0' } }).steps, []);
  assert.deepEqual(computeRollback(null, { env: {} }).steps, []);
  assert.deepEqual(computeRollback('nope', { env: {} }).steps, []);
});

test('computeRollback tolerates malformed rows without throwing', () => {
  const entries = [null, {}, { kind: 'file' }, { kind: 'file', target: '/a/ok.js', action: 'unlink' }];
  let out;
  assert.doesNotThrow(() => { out = computeRollback(entries, { env: {} }); });
  assert.equal(out.steps.length, 1);
  assert.ok(out.skipped.length >= 1);
});

test('ledgerPath joins into the data home; null on bad input', () => {
  assert.equal(ledgerPath('/home/u/.khy'), require('path').join('/home/u/.khy', LEDGER_FILENAME));
  assert.equal(ledgerPath(''), null);
  assert.equal(ledgerPath(null), null);
  assert.equal(ledgerPath(42), null);
});

test('describeInstallLedger self-reports gate + actions', () => {
  const d = describeInstallLedger();
  assert.equal(d.gate, 'KHY_INSTALL_LEDGER');
  assert.equal(d.defaultOn, true);
  assert.ok(d.actions.includes('unregister-md-editor'));
  assert.ok(d.kinds.includes('runtime'));
});
