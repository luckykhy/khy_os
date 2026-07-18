'use strict';

/**
 * uninstallRoute.test.js — 卸载分档路由决策锁死(node:test)。
 *
 * 锁死三档判定:T1 包管理器标识 → T2 原生自带卸载器 → T3 诚实拒绝(绝不猜删);
 * 空 query 拒绝;多命中标记 ambiguous;绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { decideUninstallRoute } = require('../../../src/services/deviceApps/uninstallRoute');

test('empty query → refuse', () => {
  const r = decideUninstallRoute({ query: '' });
  assert.equal(r.tier, 'refuse');
});

test('T1: safe pm appId + pm available → pm', () => {
  const r = decideUninstallRoute({ query: 'Microsoft.VisualStudioCode', isPmAppId: true, pmAvailable: true });
  assert.equal(r.tier, 'pm');
});

test('T1 falls through when pm unavailable but native matches → native', () => {
  const r = decideUninstallRoute({ query: 'SomeId', isPmAppId: true, pmAvailable: false, nativeAvailable: true, nativeMatchCount: 1 });
  assert.equal(r.tier, 'native');
});

test('T2: non-pm name (spaces) with native match → native', () => {
  const r = decideUninstallRoute({ query: 'My Editor', isPmAppId: false, pmAvailable: true, nativeAvailable: true, nativeMatchCount: 1 });
  assert.equal(r.tier, 'native');
  assert.equal(r.ambiguous, false);
});

test('T2 ambiguous when multiple native matches', () => {
  const r = decideUninstallRoute({ query: 'Editor', isPmAppId: false, nativeAvailable: true, nativeMatchCount: 3 });
  assert.equal(r.tier, 'native');
  assert.equal(r.ambiguous, true);
});

test('T3: no pm route and no native match → refuse (never guess-delete)', () => {
  const r = decideUninstallRoute({ query: 'Ghost App', isPmAppId: false, pmAvailable: true, nativeAvailable: true, nativeMatchCount: 0 });
  assert.equal(r.tier, 'refuse');
  assert.match(r.reason, /拒绝盲删/);
});

test('T3: non-windows (native unavailable) + non-pm → refuse', () => {
  const r = decideUninstallRoute({ query: 'My Editor', isPmAppId: false, pmAvailable: true, nativeAvailable: false, nativeMatchCount: 0 });
  assert.equal(r.tier, 'refuse');
  assert.match(r.reason, /原生卸载器不可用|拒绝盲删/);
});

test('bad input → refuse, no throw', () => {
  assert.equal(decideUninstallRoute(undefined).tier, 'refuse');
  assert.equal(decideUninstallRoute({}).tier, 'refuse');
});
