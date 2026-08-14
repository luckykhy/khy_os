'use strict';

/**
 * safeStatSync.test.js — 锁 utils/safeStatSync 口径(收敛 3 处 `_safeStat` 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const safeStatSync = require('../src/utils/safeStatSync');

test('存在的文件 → fs.Stats(size 与真值一致)', () => {
  const tmp = path.join(os.tmpdir(), `khy_safestat_${process.pid}.txt`);
  fs.writeFileSync(tmp, 'hello');
  try {
    const st = safeStatSync(tmp);
    assert.ok(st && typeof st.size === 'number');
    assert.strictEqual(st.size, 5);
    assert.ok(st.isFile());
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('不存在的路径 → null(不抛)', () => {
  assert.strictEqual(safeStatSync(path.join(os.tmpdir(), 'khy_nope_zzz_no_such')), null);
});

test('空/缺省参数 → null(不抛)', () => {
  assert.strictEqual(safeStatSync(''), null);
  assert.strictEqual(safeStatSync(), null);
});

test('目录 → Stats.isDirectory() 为真', () => {
  const st = safeStatSync(os.tmpdir());
  assert.ok(st && st.isDirectory());
});
