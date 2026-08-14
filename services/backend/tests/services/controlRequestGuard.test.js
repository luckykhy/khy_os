'use strict';

/**
 * controlRequestGuard.test.js — 「一直转圈实际卡死」abort/timeout 收尾纯叶子单测(node:test)。
 *
 * 覆盖:门控(off→原 promise 透传引用)、原 promise 胜出透传值、reject 归一为 null、
 * abort 先到→null、超时先到→null(注入定时器)、无信号无超时→原样透传、
 * 已中断→立即 null、resolveTimeoutMs 优先级、绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const g = require('../../src/services/controlRequestGuard');

test('isEnabled: 默认开,仅显式 falsy 关', () => {
  assert.equal(g.isEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(g.isEnabled({ KHY_CONTROL_REQUEST_GUARD: off }), false, off);
  }
});

test('门控关 → 返回原 promise 同一引用(逐字节回退)', () => {
  const p = Promise.resolve(42);
  const out = g.guardControlRequest(p, { env: { KHY_CONTROL_REQUEST_GUARD: '0' } });
  assert.strictEqual(out, p);
});

test('无 signal 无 timeout → 返回原 promise 同一引用', () => {
  const p = Promise.resolve('x');
  const out = g.guardControlRequest(p, { env: {} });
  assert.strictEqual(out, p);
});

test('原 promise resolve 值 → 原样透传', async () => {
  const ac = new AbortController();
  const out = await g.guardControlRequest(Promise.resolve({ ok: 1 }), { signal: ac.signal, env: {} });
  assert.deepEqual(out, { ok: 1 });
});

test('原 promise reject → 归一为 null(不抛未处理拒绝)', async () => {
  const ac = new AbortController();
  const out = await g.guardControlRequest(Promise.reject(new Error('boom')), { signal: ac.signal, env: {} });
  assert.equal(out, null);
});

test('abort 先到 → resolve(null)', async () => {
  const ac = new AbortController();
  // 永不 settle 的 promise 模拟卡死的控制通道
  const never = new Promise(() => {});
  const raced = g.guardControlRequest(never, { signal: ac.signal, env: {} });
  ac.abort('user esc');
  const out = await raced;
  assert.equal(out, null);
});

test('已中断的 signal → 立即 null', async () => {
  const ac = new AbortController();
  ac.abort('already');
  const out = await g.guardControlRequest(new Promise(() => {}), { signal: ac.signal, env: {} });
  assert.equal(out, null);
});

test('超时先到 → resolve(null)(注入定时器,确定式)', async () => {
  let fired = null;
  const fakeSet = (fn) => { fired = fn; return 1; };
  const fakeClear = () => {};
  const raced = g.guardControlRequest(new Promise(() => {}), {
    env: {}, timeoutMs: 50, setTimeout: fakeSet, clearTimeout: fakeClear,
  });
  assert.equal(typeof fired, 'function');
  fired(); // 触发超时
  const out = await raced;
  assert.equal(out, null);
});

test('resolveTimeoutMs: opts>env>0;仅正有限数', () => {
  assert.equal(g.resolveTimeoutMs({}, {}), 0);
  assert.equal(g.resolveTimeoutMs({ KHY_CONTROL_REQUEST_TIMEOUT_MS: '2000' }, {}), 2000);
  assert.equal(g.resolveTimeoutMs({ KHY_CONTROL_REQUEST_TIMEOUT_MS: '2000' }, { timeoutMs: 500 }), 500);
  assert.equal(g.resolveTimeoutMs({}, { timeoutMs: -5 }), 0);
  assert.equal(g.resolveTimeoutMs({}, { timeoutMs: 'nope' }), 0);
});

test('绝不抛:非 thenable 输入原样透传', () => {
  assert.doesNotThrow(() => g.guardControlRequest(null, { env: {} }));
  assert.equal(g.guardControlRequest(null, { env: {} }), null);
  assert.doesNotThrow(() => g.guardControlRequest(123, { env: {} }));
});
