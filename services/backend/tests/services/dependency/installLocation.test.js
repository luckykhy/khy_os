'use strict';

/**
 * installLocation.test.js — 只读底座依赖重定位（问题 #1 的 bundle 失败根因）。
 *
 * 验收：backend 根可写时零行为变更；只读（EACCES/EROFS）时 project 作用域 npm
 * 安装改投用户数据家下的可写目录，并把该 node_modules 注册进模块解析路径。
 *
 * 全程注入纯内存桩，零真实 FS / 零真实进程。
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const il = require('../../../src/services/dependency/installLocation');

function depsWith({ readonlyMarker = '__never__', dataRoot = '/home/u/.khy' } = {}) {
  return {
    accessSync: (p) => {
      if (String(p).includes(readonlyMarker)) {
        const e = new Error('EACCES: permission denied');
        e.code = 'EACCES';
        throw e;
      }
    },
    WOK: 2,
    dataDir: (...seg) => `${dataRoot}/${seg.join('/')}`,
    platform: 'linux',
  };
}

describe('installLocation — 只读底座重定位', () => {
  beforeEach(() => il._internal._resetRegistered());

  test('可写 backend 根：原样使用，零重定位', () => {
    const d = depsWith({});
    assert.equal(il.isWritableDir('/srv/khy/services/backend', d), true);
    const loc = il.resolveInstallRoot('/srv/khy/services/backend', d);
    assert.equal(loc.relocated, false);
    assert.equal(loc.root, '/srv/khy/services/backend');
    assert.equal(loc.writable, true);
  });

  test('只读 backend 根（EACCES）：改投用户数据家 deps/', () => {
    const d = depsWith({ readonlyMarker: 'site-packages', dataRoot: '/home/u/.khy' });
    const roRoot = '/usr/lib/python3/site-packages/khy_os/bundled/.khy/services/backend';
    assert.equal(il.isWritableDir(roRoot, d), false);
    const loc = il.resolveInstallRoot(roRoot, d);
    assert.equal(loc.relocated, true);
    assert.equal(loc.root, '/home/u/.khy/deps');
    assert.equal(loc.writable, true);
    assert.equal(loc.reason, 'backend-root-readonly');
  });

  test('modulePathsFor 给出重定位根的 node_modules', () => {
    assert.deepEqual(il.modulePathsFor('/home/u/.khy/deps'), ['/home/u/.khy/deps/node_modules']);
    assert.deepEqual(il.modulePathsFor(''), []);
  });

  test('不存在的目录回看父目录可写性', () => {
    // 目录不存在(ENOENT) 但父目录可写 → 视为可写（可在其下创建）
    const d = {
      accessSync: (p) => {
        if (p === '/home/u/.khy/deps') { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        // 父目录 /home/u/.khy 可写（不抛）
      },
      WOK: 2,
      dataDir: (...s) => '/x/' + s.join('/'),
      platform: 'linux',
    };
    assert.equal(il.isWritableDir('/home/u/.khy/deps', d), true);
  });

  test('数据家不可用时退回原根（不放大故障）', () => {
    const d = {
      accessSync: () => { const e = new Error('EROFS'); e.code = 'EROFS'; throw e; },
      WOK: 2,
      dataDir: () => { throw new Error('no data home'); },
      platform: 'linux',
    };
    const loc = il.resolveInstallRoot('/ro/backend', d);
    assert.equal(loc.relocated, false);
    assert.equal(loc.reason, 'datadir-unavailable');
    assert.equal(loc.root, '/ro/backend');
  });

  test('registerModulePath 幂等且不抛', () => {
    il.registerModulePath('/home/u/.khy/deps');
    il.registerModulePath('/home/u/.khy/deps'); // 第二次为 no-op
    const nm = '/home/u/.khy/deps/node_modules';
    const Module = require('module');
    assert.ok(Module.globalPaths.includes(nm) || (process.env.NODE_PATH || '').includes(nm));
  });
});
