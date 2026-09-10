'use strict';
/**
 * installLedger.test.js �?安装台账纯核心叶子契约锁�?node:test)�?
 *
 * 台账是「干净卸载」的真源:创建副作用当刻记「实际写了什么�?卸载时逆序回滚�?
 * 本套件锁�?
 *   - recordSideEffect:归一�?+ 密钥形态丢�?+ 门关�?null + 非法入参�?null;
 *   - computeRollback:逆序、按 target 去重、registration/process 先于 file、未�?action �?skipped�?
 *     门关返空步骤、非数组返空;
 *   - ledgerPath:纯拼接、非法返 null;
 *   - 门控 KHY_INSTALL_LEDGER 默认开,CANON off �?�?�?
 *   - 绝不抛�?
 */
const {
  isLedgerEnabled,
  ledgerPath,
  recordSideEffect,
  computeRollback,
  describeInstallLedger,
  LEDGER_FILENAME,
  KIND,
} = require('../../src/services/domain/maintenance/uninstall/installLedger.js');

describe('Install Ledger', () => {
  test('gate default-on; CANON off values close it (byte-revert)', () => {
      expect(isLedgerEnabled({})).toBe(true);
      expect(isLedgerEnabled({ KHY_INSTALL_LEDGER: '1' })).toBe(true);
      for (const off of ['0', 'false', 'off', 'no']) {
        expect(isLedgerEnabled({ KHY_INSTALL_LEDGER: off })).toBe(false);
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
      expect(rec).toBeTruthy();
      expect(rec.v).toBe(1);
      expect(rec.kind).toBe('file');
      expect(rec.target).toBe('/tmp/khy/foo/bar.js');
      expect(rec.action).toBe('unlink');
      expect(rec.checksum).toBe('abc123');
      expect(rec.ts).toBe(1700000000000);
  });

  test('recordSideEffect keeps non-path targets verbatim for registration/process', () => {
      const reg = recordSideEffect({ kind: KIND.REGISTRATION, target: 'autostart:linux', action: 'unregister-autostart' }, { env: {} });
      expect(reg.target).toBe('autostart:linux');
      const proc = recordSideEffect({ kind: KIND.PROCESS, target: 'md-bridge', action: 'stop-process' }, { env: {} });
      expect(proc.target).toBe('md-bridge');
  });

  test('recordSideEffect returns null when gate off (does not record)', () => {
      const rec = recordSideEffect({ kind: KIND.FILE, target: '/tmp/x', action: 'unlink' }, { env: { KHY_INSTALL_LEDGER: 'off' } });
      expect(rec).toBe(null);
  });

  test('recordSideEffect rejects malformed / unknown-kind entries', () => {
      expect(recordSideEffect(null, { env: {} })).toBe(null);
      expect(recordSideEffect({}, { env: {} })).toBe(null);
      expect(recordSideEffect({ kind: 'bogus', target: '/tmp/x', action: 'unlink' }, { env: {} })).toBe(null);
      expect(recordSideEffect({ kind: KIND.FILE, target: '', action: 'unlink' }, { env: {} })).toBe(null);
      expect(recordSideEffect({ kind: KIND.FILE, target: '/tmp/x', action: '' }, { env: {} })).toBe(null);
  });

  test('recordSideEffect drops secret-shaped meta values; keeps allowlisted scalars', () => {
      const rec = recordSideEffect({
        kind: KIND.FILE,
        target: '/tmp/x',
        action: 'unlink',
        meta: {
          scope: 'user',
          platform: 'linux',
          token: 'sk-abcdef0123456789abcdef0123456789', // secret-shaped �?dropped
          apiKey: 'super-secret-value',                  // key name �?dropped
          random: 'notallowed',                           // not in allowlist �?dropped
          label: 'md-editor',
        },
      }, { env: {} });
      assert.deepEqual(rec.meta, { scope: 'user', platform: 'linux', label: 'md-editor' });
  });

  test('recordSideEffect never throws on hostile input', () => {
      expect(() => recordSideEffect({ kind: KIND.FILE, target: 123, action: {} }, { env: {} }).not.toThrow());
      expect(() => recordSideEffect(undefined, {}).not.toThrow());
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
      // files preserve reverse-creation order: two.js recorded after one.js �?two.js rolled back first.
      const files = steps.filter((s) => s.kind === 'file').map((s) => s.target);
      assert.deepEqual(files, ['/a/two.js', '/a/one.js']);
  });

  test('computeRollback dedupes by target, keeping the last recorded entry', () => {
      const entries = [
        { kind: 'file', target: '/a/x.js', action: 'unlink', checksum: 'old' },
        { kind: 'file', target: '/a/x.js', action: 'unlink', checksum: 'new' },
      ];
      const { steps } = computeRollback(entries, { env: {} });
      expect(steps.length).toBe(1);
      expect(steps[0].checksum).toBe('new'); // last write wins (reverse traversal hits it first)
  });

  test('computeRollback routes unknown actions to skipped (never silently executes)', () => {
      const entries = [
        { kind: 'file', target: '/a/x.js', action: 'rm -rf /' }, // unknown �?skipped
        { kind: 'file', target: '/a/y.js', action: 'unlink' },
      ];
      const { steps, skipped } = computeRollback(entries, { env: {} });
      assert.deepEqual(steps.map((s) => s.target), ['/a/y.js']);
      expect(skipped.length).toBe(1);
      expect(skipped[0].reason).toBe('unknown-action');
  });

  test('computeRollback returns empty steps when gate off / not an array', () => {
      assert.deepEqual(computeRollback([{ kind: 'file', target: '/a', action: 'unlink' }], { env: { KHY_INSTALL_LEDGER: '0' } }).steps, []);
      assert.deepEqual(computeRollback(null, { env: {} }).steps, []);
      assert.deepEqual(computeRollback('nope', { env: {} }).steps, []);
  });

  test('computeRollback tolerates malformed rows without throwing', () => {
      const entries = [null, {}, { kind: 'file' }, { kind: 'file', target: '/a/ok.js', action: 'unlink' }];
      let out;
      expect(() => { out = computeRollback(entries, { env: {} }).not.toThrow(); });
      expect(out.steps.length).toBe(1);
      expect(out.skipped.length >= 1).toBeTruthy();
  });

  test('ledgerPath joins into the data home; null on bad input', () => {
      expect(ledgerPath('/home/u/.khy')).toBe(require('path').join('/home/u/.khy', LEDGER_FILENAME));
      expect(ledgerPath('')).toBe(null);
      expect(ledgerPath(null)).toBe(null);
      expect(ledgerPath(42)).toBe(null);
  });

  test('describeInstallLedger self-reports gate + actions', () => {
      const d = describeInstallLedger();
      expect(d.gate).toBe('KHY_INSTALL_LEDGER');
      expect(d.defaultOn).toBe(true);
      expect(d.actions).toContain('unregister-md-editor');
      expect(d.kinds).toContain('runtime');
  });

});

