'use strict';

/**
 * envOnByName.test.js — 锁 utils/envOnByName 口径(收敛 3 处 search/* `_envOn(env,key)` 的单一真源护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const envOnByName = require('../src/utils/envOnByName');

test('未设(undefined)→ true(默认开)', () => {
  assert.strictEqual(envOnByName({}, 'ANY_KEY'), true);
});

test('显式关值 {0,false,off} → false', () => {
  for (const v of ['0', 'false', 'off']) {
    assert.strictEqual(envOnByName({ K: v }, 'K'), false, `for ${v}`);
  }
});

test('其余值(含大小写/空白变体)→ true(严格比较,不 trim/lowercase)', () => {
  for (const v of ['1', 'true', 'on', 'OFF', ' off ', 'FALSE', 'no', 'maybe']) {
    assert.strictEqual(envOnByName({ K: v }, 'K'), true, `for '${v}'`);
  }
});

test('env 缺省时兜底读 process.env', () => {
  const KEY = '__KHY_TEST_ENVON__';
  const prev = process.env[KEY];
  const had = Object.prototype.hasOwnProperty.call(process.env, KEY);
  try {
    process.env[KEY] = 'off';
    assert.strictEqual(envOnByName(null, KEY), false);
    process.env[KEY] = '1';
    assert.strictEqual(envOnByName(undefined, KEY), true);
  } finally {
    if (had) process.env[KEY] = prev; else delete process.env[KEY];
  }
});

test('与原 inline 形式逐输入等价', () => {
  const inline = (env, key) => {
    const v = (env || process.env || {})[key];
    return v === undefined || !(v === '0' || v === 'false' || v === 'off');
  };
  const cases = [{}, { K: '0' }, { K: 'false' }, { K: 'off' }, { K: '1' }, { K: 'OFF' }, { K: '' }];
  for (const env of cases) {
    assert.strictEqual(envOnByName(env, 'K'), inline(env, 'K'), `for ${JSON.stringify(env)}`);
  }
});
