'use strict';

/**
 * mkdirpSync.test.js — 锁 utils/mkdirpSync 口径
 *   (收敛 4 处裸 `fs.mkdirSync(dirPath,{recursive:true})` helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mkdirpSync = require('../src/utils/mkdirpSync');

test('创建缺失目录(含多层)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdirp-'));
  const target = path.join(base, 'a', 'b', 'c');
  mkdirpSync(target);
  assert.strictEqual(fs.existsSync(target), true);
  fs.rmSync(base, { recursive: true, force: true });
});

test('目录已存在不抛(mkdir -p 语义)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdirp-'));
  mkdirpSync(base); // 已存在
  assert.strictEqual(fs.existsSync(base), true);
  fs.rmSync(base, { recursive: true, force: true });
});

test('返回 undefined(纯副作用)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdirp-'));
  const r = mkdirpSync(path.join(base, 'x'));
  assert.strictEqual(r, undefined);
  fs.rmSync(base, { recursive: true, force: true });
});
