'use strict';

/**
 * deviceAppManager.test.js — 设备应用管理器 IO 壳验收(注入桩,零真实进程)。
 *
 * 覆盖:
 *   - 门控关闭 / 无包管理器 → available:false(诚实回报)
 *   - listInstalled 经 policy 解析
 *   - uninstall/install 的 confirmed 门:未确认只回 argv 不执行、非法 appId 拒绝、
 *     确认后才调 runInherit
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { getManager } = require('../../../src/services/deviceApps/deviceAppManager');

function depsWith({ platform = 'linux', bins = ['apt-get'], listStdout = '', runResults = [] } = {}) {
  const calls = { capture: [], inherit: [] };
  const inheritQueue = runResults.slice();
  return {
    calls,
    deps: {
      platform,
      hasExecutable: (b) => bins.includes(b),
      runCapture: async (argv) => { calls.capture.push(argv); return { ok: true, stdout: listStdout, error: null }; },
      runInherit: async (argv) => { calls.inherit.push(argv); return inheritQueue.length ? inheritQueue.shift() : { ok: true, error: null }; },
    },
  };
}

describe('getManager — 可用性', () => {
  test('门控关闭 → available:false', () => {
    const m = getManager({ KHY_DEVICE_APPS: '0' });
    assert.equal(m.available, false);
    assert.match(m.reason, /关闭/);
  });

  test('无受支持包管理器 → available:false', () => {
    const { deps } = depsWith({ bins: [] });
    const m = getManager({}, deps);
    assert.equal(m.available, false);
    assert.match(m.reason, /未探测到/);
  });

  test('apt 可用 → available:true, pm.id=apt', () => {
    const { deps } = depsWith({});
    const m = getManager({}, deps);
    assert.equal(m.available, true);
    assert.equal(m.pm.id, 'apt');
  });
});

describe('listInstalled', () => {
  test('经 policy 解析 dpkg 输出', async () => {
    const { deps, calls } = depsWith({
      listStdout: 'ii  git           1:2.34.1     amd64  fast VCS\nii  curl          7.81.0       amd64  transfer tool\n',
    });
    const m = getManager({}, deps);
    const res = await m.listInstalled();
    assert.equal(res.ok, true);
    assert.deepEqual(res.apps, [
      { name: 'git', id: 'git', version: '1:2.34.1' },
      { name: 'curl', id: 'curl', version: '7.81.0' },
    ]);
    assert.deepEqual(calls.capture[0], ['dpkg', '-l']); // argv 直传
  });
});

describe('uninstall/install — confirmed 门', () => {
  test('未确认 → 只回 argv,不执行', async () => {
    const { deps, calls } = depsWith({});
    const m = getManager({}, deps);
    const res = await m.uninstall('git', { confirmed: false });
    assert.equal(res.ok, false);
    assert.deepEqual(res.argv, ['apt-get', 'remove', '-y', 'git']);
    assert.equal(calls.inherit.length, 0); // 绝未执行
  });

  test('非法 appId → 拒绝,不构造/执行', async () => {
    const { deps, calls } = depsWith({});
    const m = getManager({}, deps);
    const res = await m.uninstall('git; rm -rf /', { confirmed: true });
    assert.equal(res.ok, false);
    assert.match(res.error, /非法/);
    assert.equal(calls.inherit.length, 0);
  });

  test('确认后执行 uninstall argv', async () => {
    const { deps, calls } = depsWith({ runResults: [{ ok: true }] });
    const m = getManager({}, deps);
    const res = await m.uninstall('git', { confirmed: true });
    assert.equal(res.ok, true);
    assert.deepEqual(calls.inherit[0], ['apt-get', 'remove', '-y', 'git']);
  });

  test('确认后执行 install argv', async () => {
    const { deps, calls } = depsWith({ runResults: [{ ok: true }] });
    const m = getManager({}, deps);
    const res = await m.install('curl', { confirmed: true });
    assert.equal(res.ok, true);
    assert.deepEqual(calls.inherit[0], ['apt-get', 'install', '-y', 'curl']);
  });

  test('执行失败 → 如实回报 error', async () => {
    const { deps } = depsWith({ runResults: [{ ok: false, error: 'E: permission denied' }] });
    const m = getManager({}, deps);
    const res = await m.install('curl', { confirmed: true });
    assert.equal(res.ok, false);
    assert.match(res.error, /permission denied/);
  });
});
