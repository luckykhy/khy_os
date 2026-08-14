'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const lock = require('../../../src/services/channels/ilinkExecutionLock');

test('runExclusive: 两个并发调用严格串行,执行区间不重叠', async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];

  const make = (id) => lock.runExclusive(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start-${id}`);
    // 让出事件循环:若锁失效,两个 fn 会在此交错。
    await new Promise((r) => setTimeout(r, 20));
    order.push(`end-${id}`);
    active -= 1;
    return id;
  });

  const [a, b] = await Promise.all([make('a'), make('b')]);
  assert.strictEqual(a, 'a');
  assert.strictEqual(b, 'b');
  assert.strictEqual(maxActive, 1, '任意时刻最多一个 fn 在执行');
  // FIFO:a 先入队,必须整段跑完 b 才开始。
  assert.deepStrictEqual(order, ['start-a', 'end-a', 'start-b', 'end-b']);
});

test('runExclusive: fn 抛错时异常向调用方透传,且锁可再次获取', async () => {
  await assert.rejects(
    () => lock.runExclusive(async () => { throw new Error('boom'); }),
    /boom/,
    '异常应原样透传',
  );
  // 锁必须已释放:后续调用能正常完成。
  const r = await lock.runExclusive(async () => 42);
  assert.strictEqual(r, 42, '前一次抛错后锁仍可再次获取');
  assert.strictEqual(lock._isBusy(), false, '结算后不应残留占用');
});

test('runExclusive: 一个调用抛错不阻塞排在其后的调用', async () => {
  const results = [];
  const p1 = lock.runExclusive(async () => { throw new Error('first-fails'); })
    .catch((e) => results.push(`err:${e.message}`));
  const p2 = lock.runExclusive(async () => { results.push('second-ok'); return 'ok'; });
  const [, r2] = await Promise.all([p1, p2]);
  // 前一个 fn 抛错不得阻断队列:两者都应完成。
  // (.catch 与后续 fn 的微任务先后不属于锁的契约,故不断言顺序。)
  assert.strictEqual(r2, 'ok', '后续调用应正常完成');
  assert.ok(results.includes('err:first-fails'), '前一个应抛错');
  assert.ok(results.includes('second-ok'), '后续应成功执行');
  assert.strictEqual(lock._isBusy(), false, '全部结算后不应残留占用');
});
