'use strict';

/**
 * isEnabledDefaultOn.test.js — 锁 utils/isEnabledDefaultOn 口径
 *   (收敛 11 处 body 逐字节相同的默认开门控判定)。
 *
 * 委派 flagRegistry.isFlagEnabled:未注册门→放行 true;注册 default-on 门 env 关值→false。
 */

const test = require('node:test');
const assert = require('node:assert');

const isEnabled = require('../src/utils/isEnabledDefaultOn');

test('未注册门 → flagRegistry 保守放行 true(默认开)', () => {
  assert.strictEqual(isEnabled('KHY__NONEXISTENT_TEST_FLAG__', {}), true);
  assert.strictEqual(isEnabled('KHY__NONEXISTENT_TEST_FLAG__', { KHY__NONEXISTENT_TEST_FLAG__: '0' }), true);
});

test('注册 default-on 门:env 显式关值 → false', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'False', ' no ']) {
    assert.strictEqual(isEnabled('KHY_PROMPT_CACHE_ORDER', { KHY_PROMPT_CACHE_ORDER: v }), false);
  }
});

test('注册 default-on 门:缺省 / 开值 → true', () => {
  assert.strictEqual(isEnabled('KHY_PROMPT_CACHE_ORDER', {}), true);
  for (const v of ['1', 'true', 'on', 'yes', 'whatever']) {
    assert.strictEqual(isEnabled('KHY_PROMPT_CACHE_ORDER', { KHY_PROMPT_CACHE_ORDER: v }), true);
  }
});

test('env 缺省 → 取 process.env(返 boolean·不抛)', () => {
  assert.strictEqual(typeof isEnabled('KHY_PROMPT_CACHE_ORDER'), 'boolean');
});

test('不 mutate 入参 env', () => {
  const env = { KHY_PROMPT_CACHE_ORDER: 'off' };
  const before = JSON.stringify(env);
  isEnabled('KHY_PROMPT_CACHE_ORDER', env);
  assert.strictEqual(JSON.stringify(env), before);
});
