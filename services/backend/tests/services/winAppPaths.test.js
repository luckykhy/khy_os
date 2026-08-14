'use strict';

// Unit tests for the Windows "App Paths" registry discovery pure leaf.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const wap = require('../../src/services/winAppPaths');

// ---------------------------------------------------------------------------
// isEnabled — gate ladder (default ON).
// ---------------------------------------------------------------------------

test('isEnabled: unset → on', () => {
  assert.strictEqual(wap.isEnabled({}), true);
  assert.strictEqual(wap.isEnabled(undefined), true);
});

test('isEnabled: explicit off tokens → off', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    assert.strictEqual(wap.isEnabled({ KHY_APP_PATHS_REGISTRY: v }), false, `value ${v}`);
  }
});

test('isEnabled: any other value → on', () => {
  assert.strictEqual(wap.isEnabled({ KHY_APP_PATHS_REGISTRY: '1' }), true);
  assert.strictEqual(wap.isEnabled({ KHY_APP_PATHS_REGISTRY: 'yes' }), true);
});

// ---------------------------------------------------------------------------
// parseAppPathsOutput — the real reg output the user had to dig out by hand.
// ---------------------------------------------------------------------------

// Captured shape of `reg query HKCU\…\App Paths /s` on the user's machine where
// Quark sits on the D: drive with no Start-Menu shortcut.
const REAL_REG_OUTPUT = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\quark.exe',
  '    (Default)    REG_SZ    D:\\Users\\25789\\AppData\\Local\\Programs\\Quark\\quark.exe',
  '    Path    REG_SZ    D:\\Users\\25789\\AppData\\Local\\Programs\\Quark',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  '    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '',
].join('\r\n');

test('parseAppPathsOutput: extracts exeName + (Default) path', () => {
  const out = wap.parseAppPathsOutput(REAL_REG_OUTPUT);
  assert.deepStrictEqual(out, [
    { exeName: 'quark.exe', exePath: 'D:\\Users\\25789\\AppData\\Local\\Programs\\Quark\\quark.exe' },
    { exeName: 'chrome.exe', exePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
  ]);
});

test('parseAppPathsOutput: zh-CN (默认) value name recognized', () => {
  const cn = [
    'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\quark.exe',
    '    (默认)    REG_SZ    D:\\Programs\\Quark\\quark.exe',
  ].join('\r\n');
  assert.deepStrictEqual(wap.parseAppPathsOutput(cn), [
    { exeName: 'quark.exe', exePath: 'D:\\Programs\\Quark\\quark.exe' },
  ]);
});

test('parseAppPathsOutput: REG_EXPAND_SZ path recognized', () => {
  const ex = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\foo.exe',
    '    (Default)    REG_EXPAND_SZ    %ProgramFiles%\\Foo\\foo.exe',
  ].join('\r\n');
  assert.deepStrictEqual(wap.parseAppPathsOutput(ex), [
    { exeName: 'foo.exe', exePath: '%ProgramFiles%\\Foo\\foo.exe' },
  ]);
});

test('parseAppPathsOutput: key with no (Default) is skipped', () => {
  const noDefault = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\bar.exe',
    '    Path    REG_SZ    C:\\Bar',
  ].join('\r\n');
  assert.deepStrictEqual(wap.parseAppPathsOutput(noDefault), []);
});

test('parseAppPathsOutput: non-.exe key is skipped', () => {
  const nonExe = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
    '    (Default)    REG_SZ    C:\\whatever',
  ].join('\r\n');
  assert.deepStrictEqual(wap.parseAppPathsOutput(nonExe), []);
});

test('parseAppPathsOutput: path with spaces preserved, quotes stripped', () => {
  const spaced = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\app.exe',
    '    (Default)    REG_SZ    "C:\\Program Files\\My App\\app.exe"',
  ].join('\r\n');
  assert.deepStrictEqual(wap.parseAppPathsOutput(spaced), [
    { exeName: 'app.exe', exePath: 'C:\\Program Files\\My App\\app.exe' },
  ]);
});

test('parseAppPathsOutput: garbage / empty → []', () => {
  assert.deepStrictEqual(wap.parseAppPathsOutput(''), []);
  assert.deepStrictEqual(wap.parseAppPathsOutput(null), []);
  assert.deepStrictEqual(wap.parseAppPathsOutput(undefined), []);
  assert.deepStrictEqual(wap.parseAppPathsOutput(42), []);
});

// ---------------------------------------------------------------------------
// buildAppPathRecords — Start-Menu-shaped records, deduped by bin.
// ---------------------------------------------------------------------------

test('buildAppPathRecords: quark record shape', () => {
  const recs = wap.buildAppPathRecords(REAL_REG_OUTPUT);
  const quark = recs.find(r => r.bin === 'quark');
  assert.ok(quark, 'quark record present');
  assert.strictEqual(quark.name, 'quark');
  assert.strictEqual(quark.nameCn, '');
  assert.strictEqual(quark.exec, 'D:\\Users\\25789\\AppData\\Local\\Programs\\Quark\\quark.exe');
  assert.deepStrictEqual(quark.keywords, []);
  assert.strictEqual(quark.searchText, 'quark quark.exe');
  assert.strictEqual(quark.file, 'quark.exe');
  assert.strictEqual(quark.source, 'app-paths');
});

test('buildAppPathRecords: dedup by bin, first wins', () => {
  const dup = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\quark.exe',
    '    (Default)    REG_SZ    D:\\first\\quark.exe',
    'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\quark.exe',
    '    (Default)    REG_SZ    C:\\second\\quark.exe',
  ].join('\r\n');
  const recs = wap.buildAppPathRecords(dup);
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].exec, 'D:\\first\\quark.exe');
});

test('buildAppPathRecords: empty path entry skipped', () => {
  // A (Default) line with only whitespace after the type → no path → skipped.
  const empty = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\ok.exe',
    '    (Default)    REG_SZ    C:\\ok\\ok.exe',
  ].join('\r\n');
  const recs = wap.buildAppPathRecords(empty);
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].bin, 'ok');
});

test('buildAppPathRecords: garbage → []', () => {
  assert.deepStrictEqual(wap.buildAppPathRecords(''), []);
  assert.deepStrictEqual(wap.buildAppPathRecords(null), []);
});
