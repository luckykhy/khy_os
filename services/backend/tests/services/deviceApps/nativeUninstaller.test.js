'use strict';

/**
 * nativeUninstaller.test.js — 原生卸载 IO 壳契约锁死(node:test,依赖注入,零真实 IO)。
 *
 * 锁死:
 *   - 门关 / 非 win32 → available:false(诚实回报);
 *   - _parseRegQuery 解析 reg /s 输出 → 原始记录;
 *   - listInstalled 过滤「无卸载器」条目 + 去重;
 *   - findByName 匹配;
 *   - uninstall 未确认只回计划 argv、确认才执行、无卸载器即拒绝;绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  getNativeUninstaller,
  _parseRegQuery,
  _UNINSTALL_ROOTS,
} = require('../../../src/services/deviceApps/nativeUninstaller');

// 一段仿真 reg query /s 输出:含一个 Inno 应用(有卸载器)与一个「无卸载器」幽灵条目。
const FAKE_REG = [
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MyEditor',
  '    DisplayName    REG_SZ    My Editor',
  '    DisplayVersion    REG_SZ    1.2.3',
  '    Publisher    REG_SZ    Acme',
  '    UninstallString    REG_SZ    "C:\\Program Files\\MyEditor\\unins000.exe"',
  '    InstallLocation    REG_SZ    C:\\Program Files\\MyEditor',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GhostThing',
  '    DisplayName    REG_SZ    Ghost Thing',
  '    InstallLocation    REG_SZ    C:\\Program Files\\Ghost',
  '',
].join('\r\n');

function fakeDeps(overrides = {}) {
  return {
    platform: 'win32',
    regQuery: (root) => (root === _UNINSTALL_ROOTS[0] ? FAKE_REG : ''),
    runInherit: async () => ({ ok: true }),
    ...overrides,
  };
}

test('gate off → available:false (byte-revert)', () => {
  const h = getNativeUninstaller({ KHY_DEVICE_APPS_NATIVE_UNINSTALL: '0' }, fakeDeps());
  assert.equal(h.available, false);
});

test('non-win32 → available:false, honest reason', () => {
  const h = getNativeUninstaller({}, fakeDeps({ platform: 'linux' }));
  assert.equal(h.available, false);
  assert.match(h.reason, /仅支持 Windows|包管理器/);
});

test('_parseRegQuery: extracts records with DisplayName/UninstallString', () => {
  const recs = _parseRegQuery(FAKE_REG);
  assert.equal(recs.length, 2);
  const editor = recs.find(r => r.DisplayName === 'My Editor');
  assert.ok(editor);
  assert.match(editor.UninstallString, /unins000\.exe/);
  assert.equal(editor.DisplayVersion, '1.2.3');
});

test('_parseRegQuery: empty/garbage → [] (no throw)', () => {
  assert.deepEqual(_parseRegQuery(''), []);
  assert.deepEqual(_parseRegQuery('not registry output'), []);
});

test('listInstalled: filters out entries without an uninstaller, keeps real ones', () => {
  const h = getNativeUninstaller({}, fakeDeps());
  const res = h.listInstalled();
  assert.equal(res.ok, true);
  // Ghost Thing (no UninstallString) is filtered out; only My Editor remains.
  assert.equal(res.apps.length, 1);
  assert.equal(res.apps[0].displayName, 'My Editor');
  assert.equal(res.apps[0].kind, 'inno');
});

test('listInstalled: dedupes across roots', () => {
  // Same content returned for all three roots → still 1 record.
  const h = getNativeUninstaller({}, fakeDeps({ regQuery: () => FAKE_REG }));
  const res = h.listInstalled();
  assert.equal(res.apps.length, 1);
});

test('findByName: matches installed app', () => {
  const h = getNativeUninstaller({}, fakeDeps());
  const res = h.findByName('My Editor');
  assert.equal(res.ok, true);
  assert.equal(res.matches.length, 1);
  assert.equal(res.matches[0].displayName, 'My Editor');
});

test('uninstall: unconfirmed returns plan argv, does not execute', async () => {
  let executed = false;
  const h = getNativeUninstaller({}, fakeDeps({ runInherit: async () => { executed = true; return { ok: true }; } }));
  const rec = h.listInstalled().apps[0];
  const res = await h.uninstall(rec, { confirmed: false });
  assert.equal(res.ok, false);
  assert.match(res.error, /未确认/);
  assert.deepEqual(res.argv, ['C:\\Program Files\\MyEditor\\unins000.exe', '/VERYSILENT', '/NORESTART']);
  assert.equal(executed, false);
});

test('uninstall: confirmed executes via runInherit', async () => {
  let gotArgv = null;
  const h = getNativeUninstaller({}, fakeDeps({ runInherit: async (argv) => { gotArgv = argv; return { ok: true }; } }));
  const rec = h.listInstalled().apps[0];
  const res = await h.uninstall(rec, { confirmed: true });
  assert.equal(res.ok, true);
  assert.deepEqual(gotArgv, ['C:\\Program Files\\MyEditor\\unins000.exe', '/VERYSILENT', '/NORESTART']);
});

test('uninstall: record without uninstaller → refuse (never guess-delete)', async () => {
  const h = getNativeUninstaller({}, fakeDeps());
  const res = await h.uninstall({ kind: 'generic', uninstallString: '', quietUninstallString: '', msiProductCode: '' }, { confirmed: true });
  assert.equal(res.ok, false);
  assert.match(res.error, /无自带卸载器|拒绝盲删|无法/);
});
