'use strict';

/**
 * _evalTimeout.test.js — 纯叶子 _evalTimeout 的单测(node:test)。
 *
 * 覆盖:总开关 on/off(默认 on;{0,false,off,no} 关);超时 ms 解析(默认 15000 + clamp[1000,300000]
 * + 非法回默认)。这是「门控关 ⇒ 调用方走字节回退分支」的 oracle:isEvalTimeoutEnabled 返 false 时
 * session.evaluate 直接 await page.evaluate(今日行为)。
 *
 * 运行:node --test services/backend/tests/services/browser/_evalTimeout.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const lt = require('../../../src/services/browser/_evalTimeout');

test('isEvalTimeoutEnabled:默认 on;显式 off/0/false/no 关', () => {
  assert.equal(lt.isEvalTimeoutEnabled({}), true);
  assert.equal(lt.isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: 'off' }), false);
  assert.equal(lt.isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: '0' }), false);
  assert.equal(lt.isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: 'false' }), false);
  assert.equal(lt.isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: 'no' }), false);
  assert.equal(lt.isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: 'on' }), true);
});

test('resolveEvalTimeoutMs:默认 15000;clamp[1000,300000];非法回默认', () => {
  assert.equal(lt.resolveEvalTimeoutMs({}), 15000);
  assert.equal(lt.resolveEvalTimeoutMs({ KHY_BROWSER_EVAL_TIMEOUT_MS: '2500' }), 2500);
  assert.equal(lt.resolveEvalTimeoutMs({ KHY_BROWSER_EVAL_TIMEOUT_MS: '10' }), 1000);        // clamp low
  assert.equal(lt.resolveEvalTimeoutMs({ KHY_BROWSER_EVAL_TIMEOUT_MS: '9999999' }), 300000); // clamp high
  assert.equal(lt.resolveEvalTimeoutMs({ KHY_BROWSER_EVAL_TIMEOUT_MS: 'abc' }), 15000);      // illegal
  assert.equal(lt.resolveEvalTimeoutMs({ KHY_BROWSER_EVAL_TIMEOUT_MS: '' }), 15000);         // empty
});
