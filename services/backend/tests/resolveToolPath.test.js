'use strict';

/**
 * resolveToolPath.test.js — 锁 utils/resolveToolPath 口径
 *   (收敛 7 处工具路径解析 helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const resolveToolPath = require('../src/utils/resolveToolPath');

test('相对路径 → resolve 到 cwd', () => {
  assert.strictEqual(resolveToolPath('a/b.png', '/work'), path.resolve('/work', 'a/b.png'));
});

test('前导 ~ → 展开 homedir', () => {
  const got = resolveToolPath('~/pics/x.png', '/work');
  assert.strictEqual(got, path.resolve('/work', path.join(os.homedir(), '/pics/x.png')));
});

test('falsy → String(||"") → resolve(cwd, "")', () => {
  assert.strictEqual(resolveToolPath(null, '/work'), path.resolve('/work', ''));
  assert.strictEqual(resolveToolPath(undefined, '/work'), path.resolve('/work', ''));
});

test('POSIX ${VAR} / $VAR 展开(non-win32)', () => {
  if (process.platform === 'win32') return;
  const prev = process.env.KHY_TEST_PATH_SEG;
  process.env.KHY_TEST_PATH_SEG = 'seg';
  try {
    assert.strictEqual(resolveToolPath('${KHY_TEST_PATH_SEG}/f', '/w'), path.resolve('/w', 'seg/f'));
    assert.strictEqual(resolveToolPath('$KHY_TEST_PATH_SEG/f', '/w'), path.resolve('/w', 'seg/f'));
  } finally {
    if (prev === undefined) delete process.env.KHY_TEST_PATH_SEG;
    else process.env.KHY_TEST_PATH_SEG = prev;
  }
});

test('逐输入等价原体', () => {
  const ref = (rawPath, cwd) => {
    let p = String(rawPath || '');
    if (process.platform === 'win32') {
      p = p.replace(/%([^%]+)%/g, (_, key) => process.env[key] || `%${key}%`);
    } else {
      p = p.replace(/\$\{?(\w+)\}?/g, (_, key) => process.env[key] || '');
    }
    if (p.startsWith('~')) {
      p = path.join(os.homedir(), p.slice(1));
    }
    return path.resolve(cwd, p);
  };
  for (const [r, c] of [['a.png', '/w'], ['~/x', '/w'], ['', '/w'], [null, '/tmp'], ['./rel/../y', '/w']]) {
    assert.strictEqual(resolveToolPath(r, c), ref(r, c));
  }
});
