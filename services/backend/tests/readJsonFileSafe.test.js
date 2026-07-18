'use strict';

/**
 * readJsonFileSafe.test.js — 锁 utils/readJsonFileSafe 口径
 *   (收敛 3 处「同步读 JSON·fail-soft 返 null」helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const readJsonFileSafe = require('../src/utils/readJsonFileSafe');

test('读合法 JSON → 解析对象', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rjfs-'));
  const fp = path.join(dir, 'ok.json');
  fs.writeFileSync(fp, JSON.stringify({ a: 1, b: ['x'] }), 'utf-8');
  assert.deepStrictEqual(readJsonFileSafe(fp), { a: 1, b: ['x'] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('文件缺失 → null(不抛)', () => {
  assert.strictEqual(readJsonFileSafe('/no/such/path/xyz.json'), null);
});

test('畸形 JSON → null(不抛)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rjfs-'));
  const fp = path.join(dir, 'bad.json');
  fs.writeFileSync(fp, '{ not valid json', 'utf-8');
  assert.strictEqual(readJsonFileSafe(fp), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('逐输入等价原体 try{JSON.parse(fs.readFileSync(p,utf-8))}catch{null}', () => {
  const ref = (filePath) => {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rjfs-'));
  const good = path.join(dir, 'g.json');
  fs.writeFileSync(good, '[1,2,3]', 'utf-8');
  for (const p of [good, '/missing.json', dir /* 目录读取抛→null */]) {
    assert.deepStrictEqual(readJsonFileSafe(p), ref(p));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
