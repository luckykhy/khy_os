'use strict';

/**
 * nativeUninstallPolicy.test.js — 原生卸载纯叶子契约锁死(node:test)。
 *
 * 「卸干净」的核心不变量:只跑 app 自带卸载器,绝不猜删安装目录。本套件锁死:
 *   - normalizeRecord:字段归一 + 家族分类(MSI/Inno/NSIS/generic)+ **无卸载器即拒绝**;
 *   - buildNativeUninstallCommand:MSI→msiexec argv、quiet 串优先、补静默 flag、无 exe 即拒绝;
 *   - matchRecords:精确优先子串兜底;
 *   - argv 永远是数组(execFile 直传,无 shell);
 *   - 门控默认开,CANON off 值 → 关;绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
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
} = require('../../../src/services/deviceApps/nativeUninstallPolicy');

test('gate default-on; CANON off values close it (byte-revert)', () => {
  assert.equal(isEnabled({}), true);
  assert.equal(isEnabled({ KHY_DEVICE_APPS_NATIVE_UNINSTALL: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.equal(isEnabled({ KHY_DEVICE_APPS_NATIVE_UNINSTALL: off }), false);
  }
});

test('normalizeRecord: empty string + no GUID → refuse (never guess-delete)', () => {
  const r = normalizeRecord({ DisplayName: 'GhostApp', InstallLocation: 'C:/Program Files/Ghost' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /拒绝盲删|无自带卸载器/);
});

test('normalizeRecord: null/non-object → refuse, no throw', () => {
  assert.equal(normalizeRecord(null).ok, false);
  assert.equal(normalizeRecord(undefined).ok, false);
  assert.equal(normalizeRecord(42).ok, false);
});

test('normalizeRecord: MSI classified via msiexec string and via ProductCode keyName', () => {
  const a = normalizeRecord({ DisplayName: 'Foo', UninstallString: 'MsiExec.exe /I{12345678-1234-1234-1234-1234567890AB}' });
  assert.equal(a.ok, true);
  assert.equal(a.record.kind, INSTALLER_KIND.MSI);

  const b = normalizeRecord({ DisplayName: 'Bar', keyName: '{ABCDEF01-2345-6789-ABCD-EF0123456789}', UninstallString: 'MsiExec.exe /X{ABCDEF01-2345-6789-ABCD-EF0123456789}' });
  assert.equal(b.ok, true);
  assert.equal(b.record.msiProductCode, '{ABCDEF01-2345-6789-ABCD-EF0123456789}');
});

test('normalizeRecord: Inno (unins000.exe) and NSIS (uninstall.exe) classified', () => {
  const inno = normalizeRecord({ DisplayName: 'InnoApp', UninstallString: '"C:\\Program Files\\Inno\\unins000.exe"' });
  assert.equal(inno.record.kind, INSTALLER_KIND.INNO);
  const nsis = normalizeRecord({ DisplayName: 'NsisApp', UninstallString: '"C:\\Program Files\\N\\Uninstall.exe"' });
  assert.equal(nsis.record.kind, INSTALLER_KIND.NSIS);
});

test('buildNativeUninstallCommand: MSI → msiexec /x {GUID} /qn /norestart argv', () => {
  const n = normalizeRecord({ DisplayName: 'M', keyName: '{12345678-1234-1234-1234-1234567890AB}', UninstallString: 'MsiExec.exe /X{12345678-1234-1234-1234-1234567890AB}' });
  const cmd = buildNativeUninstallCommand(n.record);
  assert.equal(cmd.ok, true);
  assert.deepEqual(cmd.argv, ['msiexec', '/x', '{12345678-1234-1234-1234-1234567890AB}', '/qn', '/norestart']);
  assert.equal(cmd.silent, true);
  assert.equal(cmd.source, 'msi-productcode');
});

test('buildNativeUninstallCommand: QuietUninstallString preferred verbatim', () => {
  const n = normalizeRecord({ DisplayName: 'Q', QuietUninstallString: '"C:\\App\\unins000.exe" /VERYSILENT', UninstallString: '"C:\\App\\unins000.exe"' });
  const cmd = buildNativeUninstallCommand(n.record);
  assert.equal(cmd.ok, true);
  assert.equal(cmd.source, 'quiet-uninstall-string');
  assert.deepEqual(cmd.argv, ['C:\\App\\unins000.exe', '/VERYSILENT']);
});

test('buildNativeUninstallCommand: Inno UninstallString gets /VERYSILENT /NORESTART appended (deduped)', () => {
  const n = normalizeRecord({ DisplayName: 'I', UninstallString: '"C:\\App\\unins000.exe"' });
  const cmd = buildNativeUninstallCommand(n.record);
  assert.equal(cmd.ok, true);
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

test('buildNativeUninstallCommand: no safe exe → refuse (never rmdir)', () => {
  // A generic string that is not a resolvable exe path.
  const cmd = buildNativeUninstallCommand({ kind: INSTALLER_KIND.GENERIC, uninstallString: 'rundll32 setupapi,InstallHinfSection', quietUninstallString: '', msiProductCode: '' });
  assert.equal(cmd.ok, false);
  assert.match(cmd.reason, /拒绝盲删|无法.*解析/);
});

test('buildNativeUninstallCommand: bad input → refuse, no throw', () => {
  assert.equal(buildNativeUninstallCommand(null).ok, false);
  assert.equal(buildNativeUninstallCommand(undefined).ok, false);
});

test('_extractExePath: quoted and unquoted with spaces', () => {
  assert.equal(_extractExePath('"C:\\Program Files\\A\\unins000.exe" /x'), 'C:\\Program Files\\A\\unins000.exe');
  assert.equal(_extractExePath('C:\\Program Files\\A\\uninstall.exe /S'), 'C:\\Program Files\\A\\uninstall.exe');
  assert.equal(_extractExePath(''), null);
  assert.equal(_extractExePath('msiexec /x {GUID}'), null); // no .exe token
});

test('_splitCommandLine: respects double quotes', () => {
  assert.deepEqual(_splitCommandLine('"C:\\a b\\x.exe" /S /q'), ['C:\\a b\\x.exe', '/S', '/q']);
  assert.deepEqual(_splitCommandLine(''), []);
});

test('_MSI_GUID_RE: accepts canonical GUID, rejects malformed', () => {
  assert.match('{12345678-1234-1234-1234-1234567890AB}', _MSI_GUID_RE);
  assert.doesNotMatch('12345678-1234-1234-1234-1234567890AB', _MSI_GUID_RE); // no braces
  assert.doesNotMatch('{XYZ}', _MSI_GUID_RE);
});

test('matchRecords: exact displayName preferred over substring', () => {
  const recs = [
    { displayName: 'Node.js' },
    { displayName: 'Node.js JavaScript Runtime' },
  ];
  const m = matchRecords(recs, 'Node.js');
  assert.equal(m.length, 1);
  assert.equal(m[0].displayName, 'Node.js');
  // substring fallback when no exact hit
  const m2 = matchRecords(recs, 'runtime');
  assert.equal(m2.length, 1);
  assert.equal(m2[0].displayName, 'Node.js JavaScript Runtime');
  // empty query / non-array
  assert.deepEqual(matchRecords(recs, ''), []);
  assert.deepEqual(matchRecords(null, 'x'), []);
});

test('describeNativeUninstallPolicy: honest self-report', () => {
  const d = describeNativeUninstallPolicy({});
  assert.equal(d.flag, 'KHY_DEVICE_APPS_NATIVE_UNINSTALL');
  assert.equal(d.enabled, true);
  assert.ok(Array.isArray(d.kinds) && d.kinds.includes('msi'));
});
