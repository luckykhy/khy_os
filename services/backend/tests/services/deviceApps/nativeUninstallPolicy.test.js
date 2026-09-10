'use strict';
/**
 * nativeUninstallPolicy.test.js �?原生卸载纯叶子契约锁�?node:test)�?
 *
 * 「卸干净」的核心不变�?只跑 app 自带卸载�?绝不猜删安装目录。本套件锁死:
 *   - normalizeRecord:字段归一 + 家族分类(MSI/Inno/NSIS/generic)+ **无卸载器即拒�?*;
 *   - buildNativeUninstallCommand:MSI→msiexec argv、quiet 串优先、补静默 flag、无 exe 即拒�?
 *   - matchRecords:精确优先子串兜底;
 *   - argv 永远是数�?execFile 直传,�?shell);
 *   - 门控默认开,CANON off �?�?�?绝不抛�?
 */
const {
  isEnabled,
  INSTALLER_KIND,
  normalizeRecord,
  buildNativeUninstallCommand,
  matchRecords,
  describeNativeUninstallPolicy,
  _extractExePath,
  _splitCommandLine,
  _MSI_GUID_RE,
} = require('../../../src/services/domain/desktop/deviceApps/nativeUninstallPolicy.js');

describe('Native Uninstall Policy', () => {
  test('gate default-on; CANON off values close it (byte-revert)', () => {
      expect(isEnabled({})).toBe(true);
      expect(isEnabled({ KHY_DEVICE_APPS_NATIVE_UNINSTALL: '1' })).toBe(true);
      for (const off of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
        expect(isEnabled({ KHY_DEVICE_APPS_NATIVE_UNINSTALL: off })).toBe(false);
      }
  });

  test('normalizeRecord: empty string + no GUID �?refuse (never guess-delete)', () => {
      const r = normalizeRecord({ DisplayName: 'GhostApp', InstallLocation: 'C:/Program Files/Ghost' });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/拒绝盲删|无自带卸载器/);
  });

  test('normalizeRecord: null/non-object �?refuse, no throw', () => {
      expect(normalizeRecord(null).ok).toBe(false);
      expect(normalizeRecord(undefined).ok).toBe(false);
      expect(normalizeRecord(42).ok).toBe(false);
  });

  test('normalizeRecord: MSI classified via msiexec string and via ProductCode keyName', () => {
      const a = normalizeRecord({ DisplayName: 'Foo', UninstallString: 'MsiExec.exe /I{12345678-1234-1234-1234-1234567890AB}' });
      expect(a.ok).toBe(true);
      expect(a.record.kind).toBe(INSTALLER_KIND.MSI);
    
      const b = normalizeRecord({ DisplayName: 'Bar', keyName: '{ABCDEF01-2345-6789-ABCD-EF0123456789}', UninstallString: 'MsiExec.exe /X{ABCDEF01-2345-6789-ABCD-EF0123456789}' });
      expect(b.ok).toBe(true);
      expect(b.record.msiProductCode).toBe('{ABCDEF01-2345-6789-ABCD-EF0123456789}');
  });

  test('normalizeRecord: Inno (unins000.exe) and NSIS (uninstall.exe) classified', () => {
      const inno = normalizeRecord({ DisplayName: 'InnoApp', UninstallString: '"C:\\Program Files\\Inno\\unins000.exe"' });
      expect(inno.record.kind).toBe(INSTALLER_KIND.INNO);
      const nsis = normalizeRecord({ DisplayName: 'NsisApp', UninstallString: '"C:\\Program Files\\N\\Uninstall.exe"' });
      expect(nsis.record.kind).toBe(INSTALLER_KIND.NSIS);
  });

  test('buildNativeUninstallCommand: MSI �?msiexec /x {GUID} /qn /norestart argv', () => {
      const n = normalizeRecord({ DisplayName: 'M', keyName: '{12345678-1234-1234-1234-1234567890AB}', UninstallString: 'MsiExec.exe /X{12345678-1234-1234-1234-1234567890AB}' });
      const cmd = buildNativeUninstallCommand(n.record);
      expect(cmd.ok).toBe(true);
      assert.deepEqual(cmd.argv, ['msiexec', '/x', '{12345678-1234-1234-1234-1234567890AB}', '/qn', '/norestart']);
      expect(cmd.silent).toBe(true);
      expect(cmd.source).toBe('msi-productcode');
  });

  test('buildNativeUninstallCommand: QuietUninstallString preferred verbatim', () => {
      const n = normalizeRecord({ DisplayName: 'Q', QuietUninstallString: '"C:\\App\\unins000.exe" /VERYSILENT', UninstallString: '"C:\\App\\unins000.exe"' });
      const cmd = buildNativeUninstallCommand(n.record);
      expect(cmd.ok).toBe(true);
      expect(cmd.source).toBe('quiet-uninstall-string');
      assert.deepEqual(cmd.argv, ['C:\\App\\unins000.exe', '/VERYSILENT']);
  });

  test('buildNativeUninstallCommand: Inno UninstallString gets /VERYSILENT /NORESTART appended (deduped)', () => {
      const n = normalizeRecord({ DisplayName: 'I', UninstallString: '"C:\\App\\unins000.exe"' });
      const cmd = buildNativeUninstallCommand(n.record);
      expect(cmd.ok).toBe(true);
      assert.deepEqual(cmd.argv, ['C:\\App\\unins000.exe', '/VERYSILENT', '/NORESTART']);
      // Already-present flag is not duplicated.
      const n2 = normalizeRecord({ DisplayName: 'I2', UninstallString: '"C:\\App\\unins000.exe" /NORESTART' });
      const cmd2 = buildNativeUninstallCommand(n2.record);
      assert.deepEqual(cmd2.argv, ['C:\\App\\unins000.exe', '/NORESTART', '/VERYSILENT']);
  });

  test('buildNativeUninstallCommand: NSIS gets /S', () => {
      const n = normalizeRecord({ DisplayName: 'N', UninstallString: 'C:\\App\\Uninstall.exe' });
      const cmd = buildNativeUninstallCommand(n.record);
      assert.deepEqual(cmd.argv, ['C:\\App\\Uninstall.exe', '/S']);
  });

  test('buildNativeUninstallCommand: no safe exe �?refuse (never rmdir)', () => {
      // A generic string that is not a resolvable exe path.
      const cmd = buildNativeUninstallCommand({ kind: INSTALLER_KIND.GENERIC, uninstallString: 'rundll32 setupapi,InstallHinfSection', quietUninstallString: '', msiProductCode: '' });
      expect(cmd.ok).toBe(false);
      expect(cmd.reason).toMatch(/拒绝盲删|无法.*解析/);
  });

  test('buildNativeUninstallCommand: bad input �?refuse, no throw', () => {
      expect(buildNativeUninstallCommand(null).ok).toBe(false);
      expect(buildNativeUninstallCommand(undefined).ok).toBe(false);
  });

  test('_extractExePath: quoted and unquoted with spaces', () => {
      expect(_extractExePath('"C:\\Program Files\\A\\unins000.exe" /x')).toBe('C:\\Program Files\\A\\unins000.exe');
      expect(_extractExePath('C:\\Program Files\\A\\uninstall.exe /S')).toBe('C:\\Program Files\\A\\uninstall.exe');
      expect(_extractExePath('')).toBe(null);
      expect(_extractExePath('msiexec /x {GUID}')).toBe(null); // no .exe token
  });

  test('_splitCommandLine: respects double quotes', () => {
      assert.deepEqual(_splitCommandLine('"C:\\a b\\x.exe" /S /q'), ['C:\\a b\\x.exe', '/S', '/q']);
      assert.deepEqual(_splitCommandLine(''), []);
  });

  test('_MSI_GUID_RE: accepts canonical GUID, rejects malformed', () => {
      expect('{12345678-1234-1234-1234-1234567890AB}').toMatch(_MSI_GUID_RE);
      expect('12345678-1234-1234-1234-1234567890AB').not.toMatch(_MSI_GUID_RE); // no braces
      expect('{XYZ}').not.toMatch(_MSI_GUID_RE);
  });

  test('matchRecords: exact displayName preferred over substring', () => {
      const recs = [
        { displayName: 'Node.js' },
        { displayName: 'Node.js JavaScript Runtime' },
      ];
      const m = matchRecords(recs, 'Node.js');
      expect(m.length).toBe(1);
      expect(m[0].displayName).toBe('Node.js');
      // substring fallback when no exact hit
      const m2 = matchRecords(recs, 'runtime');
      expect(m2.length).toBe(1);
      expect(m2[0].displayName).toBe('Node.js JavaScript Runtime');
      // empty query / non-array
      assert.deepEqual(matchRecords(recs, ''), []);
      assert.deepEqual(matchRecords(null, 'x'), []);
  });

  test('describeNativeUninstallPolicy: honest self-report', () => {
      const d = describeNativeUninstallPolicy({});
      expect(d.flag).toBe('KHY_DEVICE_APPS_NATIVE_UNINSTALL');
      expect(d.enabled).toBe(true);
      expect(Array.isArray(d.kinds) && d.kinds).toContain('msi');
  });

});

