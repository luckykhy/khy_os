'use strict';

/**
 * dbHealth.dedupeDatabases.test.js — `_dedupeByRealPath` 去重契约。
 *
 * 背景：`khy-Trajectory` 是数据家的**可见别名**（junction / symlink，
 * `utils/dataHome._ensureVisibleAlias` 每次启动重建），所以
 * `khy-Trajectory/sessions.db` 与 `.khy/sessions.db` 是同一个 inode。
 * `_discoverDatabases()` 原先两条都收，启动时对同一个 28MB 文件连做两遍
 * `PRAGMA quick_check`（实测 ~450ms/遍，白烧近一秒）。
 *
 * 这里锁三件事：① 指向同一物理文件的两条只留第一条；② 真正不同的库一条都不能丢；
 * ③ 解析不出真实路径时保守保留（宁可多查一次，也不能漏查）。
 *
 * node:test：与 dbHealth 一族保持一致。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbHealth = require('../../src/services/dbHealthService');

let tmpRoot;

function _mktmp() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-dbdedupe-'));
  return tmpRoot;
}

describe('_dedupeByRealPath', () => {
  beforeEach(() => _mktmp());
  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('别名目录下的同名库与真身合并为一条', () => {
    const realDir = path.join(tmpRoot, '.khy');
    const aliasDir = path.join(tmpRoot, 'khy-Trajectory');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'sessions.db'), 'x');
    // junction 在 Windows 上无需管理员权限；POSIX 用 dir 类型同样可行。
    fs.symlinkSync(realDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir');

    const result = dbHealth._dedupeByRealPath([
      { name: 'sessions.db', path: path.join(realDir, 'sessions.db') },
      { name: 'khy-Trajectory/sessions.db', path: path.join(aliasDir, 'sessions.db') },
    ]);

    assert.equal(result.length, 1);
    // 保留先出现的那条（名字更贴真身），别名条目被丢弃。
    assert.equal(result[0].name, 'sessions.db');
  });

  test('真正不同的库一条都不丢', () => {
    const dir = path.join(tmpRoot, 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions.db'), 'a');
    fs.writeFileSync(path.join(dir, 'taskboard.db'), 'b');

    const result = dbHealth._dedupeByRealPath([
      { name: 'sessions.db', path: path.join(dir, 'sessions.db') },
      { name: 'taskboard.db', path: path.join(dir, 'taskboard.db') },
    ]);

    assert.equal(result.length, 2);
  });

  test('同一路径重复出现也只留一条', () => {
    const dir = path.join(tmpRoot, 'data');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'sessions.db');
    fs.writeFileSync(p, 'a');

    const result = dbHealth._dedupeByRealPath([
      { name: 'sessions.db', path: p },
      { name: 'sessions.db (dup)', path: p },
    ]);

    assert.equal(result.length, 1);
  });

  test('路径解析失败时退化为字面路径：不同路径一条不丢', () => {
    const result = dbHealth._dedupeByRealPath([
      { name: 'missing-a', path: path.join(tmpRoot, 'nope', 'sessions.db') },
      { name: 'missing-b', path: path.join(tmpRoot, 'nope2', 'sessions.db') },
    ]);

    // 解析失败 → key 退化成各自路径字符串，互不相等 → 都保留（宁可多查，不可漏查）。
    assert.equal(result.length, 2);
  });

  test('解析失败且路径字面相同 → 合并为一条', () => {
    const missing = path.join(tmpRoot, 'nope', 'sessions.db');
    const result = dbHealth._dedupeByRealPath([
      { name: 'missing-a', path: missing },
      { name: 'missing-b', path: missing },
    ]);

    assert.equal(result.length, 1);
  });
});
