'use strict';

/**
 * resolveUserPath.test.js — 锁 utils/resolveUserPath 口径
 *   (收敛 cli/handlers/convert·doc 2 处相同 body 的 _resolvePath·组合 expandEnvPath)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const resolveUserPath = require('../src/utils/resolveUserPath');

const CWD = '/tmp/khy-rup-test';

test('~ → 家目录(绝对)', () => {
  assert.strictEqual(resolveUserPath('~/docs', CWD), path.join(os.homedir(), 'docs'));
});

test('相对路径 → resolve 到 cwd', () => {
  assert.strictEqual(resolveUserPath('rel/y', CWD), path.resolve(CWD, 'rel/y'));
});

test('绝对路径原样', () => {
  assert.strictEqual(resolveUserPath('/abs/x', CWD), '/abs/x');
});

test('空 → cwd', () => {
  assert.strictEqual(resolveUserPath('', CWD), path.resolve(CWD));
});

if (process.platform !== 'win32') {
  test('POSIX $VAR 展开后 resolve', () => {
    process.env.KHY_RUP_VAR = 'ZZ';
    assert.strictEqual(resolveUserPath('$KHY_RUP_VAR/a', CWD), path.resolve(CWD, 'ZZ/a'));
    delete process.env.KHY_RUP_VAR;
  });
}

test('绝不抛(畸形入参)', () => {
  assert.doesNotThrow(() => resolveUserPath(null, CWD));
  assert.doesNotThrow(() => resolveUserPath(undefined, CWD));
});
