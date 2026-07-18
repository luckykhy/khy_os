'use strict';

/**
 * readFileSyncSafe.test.js — 锁 utils/readFileSyncSafe 口径
 *   (收敛 2 处「同步读文本·fail-soft 返 ''」helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const readFileSyncSafe = require('../src/utils/readFileSyncSafe');

test('读存在文本文件 → 原文', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfss-'));
  const fp = path.join(dir, 'a.txt');
  fs.writeFileSync(fp, 'hello\nworld', 'utf8');
  assert.strictEqual(readFileSyncSafe(fp), 'hello\nworld');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('缺失路径 → 空串(不抛)', () => {
  assert.strictEqual(readFileSyncSafe('/no/such/file/qqq.txt'), '');
});

test('目录/畸形入参 → 空串(不抛)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfss-'));
  assert.strictEqual(readFileSyncSafe(dir), ''); // 读目录抛→''
  assert.strictEqual(readFileSyncSafe(null), '');
  assert.strictEqual(readFileSyncSafe(undefined), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('逐输入等价原体 try{fs.readFileSync(p,utf8)}catch{\'\'}', () => {
  const ref = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfss-'));
  const good = path.join(dir, 'g.txt');
  fs.writeFileSync(good, 'X', 'utf8');
  for (const p of [good, '/missing.txt', dir, null]) {
    assert.strictEqual(readFileSyncSafe(p), ref(p));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
