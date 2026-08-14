'use strict';

/**
 * existsSyncSafe.test.js — 锁 utils/existsSyncSafe 口径
 *   (收敛 3 处「同步探存在·fail-soft 返 false」helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const existsSyncSafe = require('../src/utils/existsSyncSafe');

test('存在的文件/目录 → true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ess-'));
  const fp = path.join(dir, 'a.txt');
  fs.writeFileSync(fp, 'x', 'utf-8');
  assert.strictEqual(existsSyncSafe(fp), true);
  assert.strictEqual(existsSyncSafe(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('缺失路径 → false', () => {
  assert.strictEqual(existsSyncSafe('/no/such/path/zzz'), false);
});

test('畸形入参 → false(不抛)', () => {
  assert.strictEqual(existsSyncSafe(undefined), false);
  assert.strictEqual(existsSyncSafe(null), false);
  assert.strictEqual(existsSyncSafe({}), false);
});

test('逐输入等价原体 try{fs.existsSync(p)}catch{false}', () => {
  const ref = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ess-'));
  for (const p of [dir, '/missing/x', null, undefined, {}]) {
    assert.strictEqual(existsSyncSafe(p), ref(p));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
