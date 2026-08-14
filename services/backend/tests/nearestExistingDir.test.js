'use strict';

/**
 * nearestExistingDir.test.js — 锁 utils/nearestExistingDir 口径
 *   (收敛 2 处文件监视器祖先目录回退 helper 的护栏)。非纯:用真实临时目录驱动 fs 分支。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const nearestExistingDir = require('../src/utils/nearestExistingDir');

test('文件所在目录已存在 → 返回该目录', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ned-'));
  try {
    const target = path.join(tmp, 'file.txt');
    assert.strictEqual(nearestExistingDir(target), tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('目标目录不存在 → 上溯到最近的已存在祖先', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ned-'));
  try {
    const target = path.join(tmp, 'a', 'b', 'c', 'file.txt');
    assert.strictEqual(nearestExistingDir(target), tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('已存在的中间目录 → 返回它(非最顶祖先)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ned-'));
  try {
    const mid = path.join(tmp, 'exists');
    fs.mkdirSync(mid);
    const target = path.join(mid, 'nope', 'file.txt');
    assert.strictEqual(nearestExistingDir(target), mid);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('根路径已存在 → 返回根附近(不返 null)', () => {
  const result = nearestExistingDir('/definitely/not/here/file.txt');
  assert.strictEqual(result, '/');
});
