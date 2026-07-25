'use strict';

/**
 * growthDataDir.test.js — 锁 utils/growthDataDir 口径(收敛 4 处 growth 目录 helper 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const growthDataDir = require('../src/utils/growthDataDir');
const { getBaseDataDir } = require('../src/utils/dataHome');

test('growthDataDir() === getBaseDataDir(\'growth\')', () => {
  assert.strictEqual(growthDataDir(), getBaseDataDir('growth'));
});

test('返回路径以 growth 结尾', () => {
  const p = growthDataDir();
  assert.ok(typeof p === 'string' && p.length > 0);
  assert.ok(/[\\/]growth$/.test(p), `期望以 /growth 结尾,实际 ${p}`);
});

test('确定性:多次调用同值', () => {
  assert.strictEqual(growthDataDir(), growthDataDir());
});
