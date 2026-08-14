'use strict';

/**
 * ensureDirSync.test.js — 锁 utils/ensureDirSync 口径(收敛 4 处 `_ensureDir(dir)` 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ensureDirSync = require('../src/utils/ensureDirSync');

test('目录不存在 → 递归创建', () => {
  const base = path.join(os.tmpdir(), `khy_ensuredir_${process.pid}_${Date.now()}`);
  const nested = path.join(base, 'a', 'b', 'c');
  try {
    assert.strictEqual(fs.existsSync(nested), false);
    ensureDirSync(nested);
    assert.ok(fs.existsSync(nested) && fs.statSync(nested).isDirectory());
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('已存在 → 幂等不抛', () => {
  const dir = path.join(os.tmpdir(), `khy_ensuredir_idem_${process.pid}_${Date.now()}`);
  try {
    ensureDirSync(dir);
    ensureDirSync(dir); // 重复调用
    assert.ok(fs.existsSync(dir) && fs.statSync(dir).isDirectory());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('返回 undefined(纯副作用)', () => {
  const dir = path.join(os.tmpdir(), `khy_ensuredir_ret_${process.pid}_${Date.now()}`);
  try {
    assert.strictEqual(ensureDirSync(dir), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('已存在的 tmpdir 根 → 不抛', () => {
  assert.doesNotThrow(() => ensureDirSync(os.tmpdir()));
});
