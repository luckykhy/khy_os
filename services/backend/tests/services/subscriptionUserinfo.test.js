'use strict';

/**
 * subscriptionUserinfo.test.js — `subscription-userinfo` 头解析纯叶子单测(node:test)。
 *
 * 覆盖:标准头 → used/total/ratio/remaining/expire;缺字段容错;usedRatio 夹 [0,1];
 * expireDays 需 nowMs(不传→null);门关(自身/父)→ null;坏输入不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const S = require('../../src/services/subscriptionUserinfo');

const DAY = 86400000;

test('标准头 → used/total/remaining/ratio', () => {
  const r = S.parseSubscriptionUserinfo('upload=1000; download=2000; total=10000; expire=1710000000', {});
  assert.strictEqual(r.upload, 1000);
  assert.strictEqual(r.download, 2000);
  assert.strictEqual(r.total, 10000);
  assert.strictEqual(r.used, 3000);
  assert.strictEqual(r.remaining, 7000);
  assert.strictEqual(r.usedRatio, 0.3);
  assert.strictEqual(r.expireAt, 1710000000 * 1000);
});

test('expireDays 需 nowMs;不传 → null', () => {
  const expireSec = 1710000000;
  const noNow = S.parseSubscriptionUserinfo(`expire=${expireSec}`, {});
  assert.strictEqual(noNow.expireDays, null);
  const nowMs = expireSec * 1000 - 5 * DAY;
  const withNow = S.parseSubscriptionUserinfo(`expire=${expireSec}`, {}, { nowMs });
  assert.strictEqual(withNow.expireDays, 5);
});

test('usedRatio 夹在 [0,1](used 超 total)', () => {
  const r = S.parseSubscriptionUserinfo('upload=8000; download=8000; total=10000', {});
  assert.strictEqual(r.used, 16000);
  assert.strictEqual(r.usedRatio, 1);
  assert.strictEqual(r.remaining, 0);
});

test('缺字段容错:仅 total → used=0、ratio=0', () => {
  const r = S.parseSubscriptionUserinfo('total=10000', {});
  assert.strictEqual(r.used, 0);
  assert.strictEqual(r.total, 10000);
  assert.strictEqual(r.usedRatio, 0);
  assert.strictEqual(r.remaining, 10000);
  assert.strictEqual(r.upload, null);
  assert.strictEqual(r.expireAt, null);
});

test('total 缺失/为 0 → remaining/ratio 为 null', () => {
  const r = S.parseSubscriptionUserinfo('upload=100; download=200', {});
  assert.strictEqual(r.used, 300);
  assert.strictEqual(r.remaining, null);
  assert.strictEqual(r.usedRatio, null);
});

test('无任何可识别字段 → null', () => {
  assert.strictEqual(S.parseSubscriptionUserinfo('foo=bar; baz=qux', {}), null);
  assert.strictEqual(S.parseSubscriptionUserinfo('', {}), null);
  assert.strictEqual(S.parseSubscriptionUserinfo('   ', {}), null);
});

test('门关(自身 KHY_PROXY_SUB_USERINFO)→ null', () => {
  for (const v of ['0', 'off', 'false', 'no']) {
    assert.strictEqual(S.parseSubscriptionUserinfo('total=10000', { KHY_PROXY_SUB_USERINFO: v }), null, v);
  }
});

test('门关(父 KHY_PROXY_SUBSCRIPTION)⇒ 子恒关 → null', () => {
  assert.strictEqual(S.parseSubscriptionUserinfo('total=10000', { KHY_PROXY_SUBSCRIPTION: 'off' }), null);
  assert.strictEqual(S.isEnabled({ KHY_PROXY_SUBSCRIPTION: '0' }), false);
});

test('isEnabled:缺省开;非关闭词开', () => {
  assert.strictEqual(S.isEnabled({}), true);
  assert.strictEqual(S.isEnabled({ KHY_PROXY_SUB_USERINFO: '1' }), true);
});

test('坏值容错:非数字字段忽略,不抛', () => {
  assert.doesNotThrow(() => S.parseSubscriptionUserinfo('upload=abc; total=xyz', {}));
  const r = S.parseSubscriptionUserinfo('upload=abc; total=5000', {});
  // upload 非数字被忽略(null),total 合法
  assert.strictEqual(r.upload, null);
  assert.strictEqual(r.total, 5000);
});

test('绝不抛:null / 非字符串输入 → null', () => {
  assert.doesNotThrow(() => S.parseSubscriptionUserinfo(null, {}));
  assert.strictEqual(S.parseSubscriptionUserinfo(null, {}), null);
  assert.doesNotThrow(() => S.parseSubscriptionUserinfo(undefined, null));
  assert.doesNotThrow(() => S.parseSubscriptionUserinfo(12345, {}));
});
