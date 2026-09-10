'use strict';
/**
 * uninstallLedgerWiring.test.js �?uninstall handler 台账接线契约(node:test)�?
 *
 * 锁死块B行为(�?spawn 真进程、不碰真数据�?用临时目�?+ KHY_DATA_HOME 注入):
 *   - _readLedgerEntries:�?~/.khy/.install-ledger.jsonl 逐行解析,坏行跳过,缺失→[];
 *   - _rollbackLedger dryRun:computeRollback 排序正确 + 不真删文�?
 *   - _rollbackLedger 执行:真删 runtime/file,checksum 不匹配则保留(用户改动不误�?;
 *   - _executeRollbackStep:autostart/stop-process �?skipped 不谎报成�?
 *   - �?KHY_INSTALL_LEDGER �?�?台账不读(_rollbackLedger 空步�?�?
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const handler = require('../../src/cli/handlers/uninstall');
/** 建一个临时数据家 + 台账文件,返回 {dataHome, cleanup}�?*/
function _mkLedgerHome(lines) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ledger-test-'));
  const dataHome = path.join(base, '.khy');
  fs.mkdirSync(dataHome, { recursive: true });
  const file = path.join(dataHome, '.install-ledger.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return { base, dataHome, file, cleanup: () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

describe('Uninstall Ledger Wiring', () => {
  test('_readLedgerEntries parses jsonl, skips malformed lines, empty on missing', () => {
      const env0 = { KHY_DATA_HOME: path.join(os.tmpdir(), 'khy-nope-' + process.pid) };
      assert.deepEqual(handler._readLedgerEntries(env0), []); // missing �?[]
    
      const h = _mkLedgerHome([
        JSON.stringify({ v: 1, kind: 'file', target: '/a/x', action: 'unlink' }),
        'this is not json',
        JSON.stringify({ v: 1, kind: 'runtime', target: '/a/rt', action: 'remove-runtime' }),
      ]);
      try {
        const entries = handler._readLedgerEntries({ KHY_DATA_HOME: h.dataHome });
        expect(entries.length).toBe(2); // malformed line skipped
        expect(entries[0].target).toBe('/a/x');
        expect(entries[1].kind).toBe('runtime');
      } finally { h.cleanup(); }
  });

  test('_rollbackLedger dryRun previews without deleting', () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-rt-'));
      const dataHome = path.join(base, '.khy');
      fs.mkdirSync(dataHome, { recursive: true });
      const runtimeFile = path.join(base, 'portable-node-bin');
      fs.writeFileSync(runtimeFile, 'binary', 'utf8');
      fs.writeFileSync(path.join(dataHome, '.install-ledger.jsonl'),
        JSON.stringify({ v: 1, kind: 'runtime', target: runtimeFile, action: 'remove-runtime' }) + '\n', 'utf8');
      try {
        const out = handler._rollbackLedger({ KHY_DATA_HOME: dataHome }, { dryRun: true });
        expect(out.steps.length).toBe(1);
        expect(out.results[0].status).toBe('executed');
        expect(fs.existsSync(runtimeFile)).toBeTruthy();
      } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('_rollbackLedger execute deletes runtime + files; ordering registration before file', () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-exec-'));
      const dataHome = path.join(base, '.khy');
      fs.mkdirSync(dataHome, { recursive: true });
      const f1 = path.join(base, 'created-one.js');
      const dir1 = path.join(base, 'created-dir');
      fs.writeFileSync(f1, 'x', 'utf8');
      fs.mkdirSync(dir1, { recursive: true });
      fs.writeFileSync(path.join(dataHome, '.install-ledger.jsonl'), [
        JSON.stringify({ v: 1, kind: 'file', target: f1, action: 'unlink' }),
        JSON.stringify({ v: 1, kind: 'dir', target: dir1, action: 'rmdir' }),
        JSON.stringify({ v: 1, kind: 'registration', target: 'autostart:linux', action: 'unregister-autostart' }),
      ].join('\n') + '\n', 'utf8');
      try {
        const out = handler._rollbackLedger({ KHY_DATA_HOME: dataHome }, { dryRun: false });
        // registration first in step order.
        expect(out.steps[0].kind).toBe('registration');
        expect(fs.existsSync(f1)).toBe(false);
        expect(fs.existsSync(dir1)).toBe(false);
        // autostart on Node side is not falsely claimed done.
        const autostart = out.results.find((r) => r.step.action === 'unregister-autostart');
        expect(autostart.status).toBe('skipped');
      } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('_executeRollbackStep keeps user-modified files (checksum mismatch)', () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cksum-'));
      const f = path.join(base, 'user-edited.js');
      fs.writeFileSync(f, 'user changed this', 'utf8');
      const staleChecksum = crypto.createHash('sha256').update('original content').digest('hex');
      try {
        const r = handler._executeRollbackStep(
          { kind: 'file', target: f, action: 'unlink', checksum: staleChecksum }, { dryRun: false });
        expect(r.status).toBe('kept');
        expect(fs.existsSync(f)).toBeTruthy();
      } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('_executeRollbackStep deletes file whose checksum still matches', () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cksum2-'));
      const f = path.join(base, 'untouched.js');
      const content = 'exact installed bytes';
      fs.writeFileSync(f, content, 'utf8');
      const ck = crypto.createHash('sha256').update(content).digest('hex');
      try {
        const r = handler._executeRollbackStep(
          { kind: 'file', target: f, action: 'unlink', checksum: ck }, { dryRun: false });
        expect(r.status).toBe('executed');
        expect(fs.existsSync(f)).toBe(false);
      } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('gate off �?_rollbackLedger yields no steps (byte-revert to allowlist-only)', () => {
      const h = _mkLedgerHome([JSON.stringify({ v: 1, kind: 'file', target: '/a/x', action: 'unlink' })]);
      try {
        const out = handler._rollbackLedger({ KHY_DATA_HOME: h.dataHome, KHY_INSTALL_LEDGER: '0' }, { dryRun: true });
        expect(out.steps.length).toBe(0);
      } finally { h.cleanup(); }
  });

  test('_stopResidentProcesses dryRun does not spawn', () => {
      const r = handler._stopResidentProcesses({}, { dryRun: true });
      assert.deepEqual(r, { dryRun: true });
  });

});

