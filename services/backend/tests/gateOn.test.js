'use strict';

/**
 * gateOn.test.js — 锁 utils/gateOn 口径
 *   (收敛 promptCacheOrder·promptPrefixShape 2 处相同 body 的 _gateOn)。
 *
 * gateOn 委派 flagRegistry.isFlagEnabled:
 *   - 未注册门 → 保守放行(true)。
 *   - 注册的 default-on 门(off:'CANON')→ env 显式 0/false/off/no 关,其余开。
 */

const test = require('node:test');
const assert = require('node:assert');

const gateOn = require('../src/utils/gateOn');

test('未注册门 → flagRegistry 保守放行 true', () => {
  assert.strictEqual(gateOn('KHY__NONEXISTENT_TEST_FLAG__', {}), true);
  // 未注册门:flagRegistry 不认识它,env 值一律放行。
  assert.strictEqual(gateOn('KHY__NONEXISTENT_TEST_FLAG__', { KHY__NONEXISTENT_TEST_FLAG__: '0' }), true);
});

test('注册 default-on 门:env 显式关值 → false', () => {
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(gateOn('KHY_PROMPT_CACHE_ORDER', { KHY_PROMPT_CACHE_ORDER: v }), false);
  }
});

test('注册 default-on 门:缺省 / 开值 → true', () => {
  assert.strictEqual(gateOn('KHY_PROMPT_CACHE_ORDER', {}), true);
  for (const v of ['1', 'true', 'on', 'yes']) {
    assert.strictEqual(gateOn('KHY_PROMPT_CACHE_ORDER', { KHY_PROMPT_CACHE_ORDER: v }), true);
  }
});

test('env 缺省 → 取 process.env(返 boolean·不抛)', () => {
  assert.strictEqual(typeof gateOn('KHY_PROMPT_CACHE_ORDER'), 'boolean');
});

test('不 mutate 入参 env', () => {
  const env = { KHY_PROMPT_CACHE_ORDER: 'off' };
  const before = JSON.stringify(env);
  gateOn('KHY_PROMPT_CACHE_ORDER', env);
  assert.strictEqual(JSON.stringify(env), before);
});
