'use strict';

/**
 * expandEnvPath.test.js — 锁 utils/expandEnvPath 口径
 *   (收敛 scaffoldFiles·unpackTool 2 处相同 body 的 _expandPath)。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');

const expandEnvPath = require('../src/utils/expandEnvPath');

test('~ → 家目录', () => {
  const out = expandEnvPath('~/docs/file.txt');
  assert.ok(out.startsWith(os.homedir()));
  assert.ok(out.endsWith('docs/file.txt') || out.endsWith('docs\\file.txt'));
});

test('普通路径原样', () => {
  assert.strictEqual(expandEnvPath('/plain/path'), '/plain/path');
});

test('空/未定义 → 空串', () => {
  assert.strictEqual(expandEnvPath(''), '');
  assert.strictEqual(expandEnvPath(), '');
});

if (process.platform !== 'win32') {
  test('POSIX $VAR / ${VAR} 展开', () => {
    process.env.KHY_TEST_EXPAND_VAR = 'VAL';
    assert.strictEqual(expandEnvPath('/a/$KHY_TEST_EXPAND_VAR/b'), '/a/VAL/b');
    assert.strictEqual(expandEnvPath('/a/${KHY_TEST_EXPAND_VAR}/b'), '/a/VAL/b');
    delete process.env.KHY_TEST_EXPAND_VAR;
  });
  test('POSIX 未定义变量 → 空', () => {
    assert.strictEqual(expandEnvPath('/a/$KHY_UNSET_XYZ/b'), '/a//b');
  });
}
