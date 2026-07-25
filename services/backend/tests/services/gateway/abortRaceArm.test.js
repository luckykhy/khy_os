'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createAbortRejectionArm } = require('../../../src/services/gateway/abortRaceArm');

// ── 核心行为:signal abort 时 promise reject ──────────────────────────────────
test('rejects when the signal aborts after wiring', async () => {
  const ac = new AbortController();
  const arm = createAbortRejectionArm(ac.signal, 'test abort');
  let settled = null;
  arm.promise.then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });
  // 尚未 abort → 未 settle。
  await Promise.resolve();
  assert.strictEqual(settled, null, 'arm should not settle before abort');
  ac.abort();
  await assert.rejects(arm.promise, /test abort/);
  arm.cleanup();
});

test('rejects synchronously-visible when signal already aborted at wiring time', async () => {
  const ac = new AbortController();
  ac.abort('already gone');
  const arm = createAbortRejectionArm(ac.signal, 'test abort');
  await assert.rejects(arm.promise, (err) => {
    assert.ok(/test abort/.test(err.message));
    return true;
  });
  arm.cleanup();
});

test('reject message includes signal.reason when readable', async () => {
  const ac = new AbortController();
  const arm = createAbortRejectionArm(ac.signal, 'gateway request aborted');
  ac.abort('user pressed Esc');
  await assert.rejects(arm.promise, (err) => {
    assert.ok(err.message.includes('gateway request aborted'));
    assert.ok(err.message.includes('user pressed Esc'));
    return true;
  });
  arm.cleanup();
});

// ── 在 Promise.race 中的用途:让卡住的臂被 abort 抢先决出 ─────────────────────
test('wins a race against a never-resolving arm once aborted', async () => {
  const ac = new AbortController();
  const arm = createAbortRejectionArm(ac.signal, 'race abort');
  const neverResolves = new Promise(() => {}); // 模拟卡死的适配器
  setImmediate(() => ac.abort());
  await assert.rejects(Promise.race([neverResolves, arm.promise]), /race abort/);
  arm.cleanup();
});

test('does not interfere when the work arm resolves first (no abort)', async () => {
  const ac = new AbortController();
  const arm = createAbortRejectionArm(ac.signal, 'race abort');
  const work = Promise.resolve('done');
  const winner = await Promise.race([work, arm.promise]);
  assert.strictEqual(winner, 'done');
  arm.cleanup(); // abort never fired — cleanup must be safe
});

// ── 缺失/异常 signal:退化为永不 settle 的臂,绝不抛 ──────────────────────────
test('missing signal → never-settling arm, no throw', async () => {
  for (const bad of [null, undefined, {}, { addEventListener: 'not a fn' }]) {
    const arm = createAbortRejectionArm(bad, 'x');
    let settled = false;
    arm.promise.then(() => { settled = true; }, () => { settled = true; });
    // 与「不挂臂」等价:其它臂决出胜负。
    const winner = await Promise.race([Promise.resolve('ok'), arm.promise]);
    assert.strictEqual(winner, 'ok');
    assert.strictEqual(settled, false, 'arm must not settle for invalid signal');
    arm.cleanup();
  }
});

// ── cleanup 幂等且移除 listener(防泄漏)────────────────────────────────────
test('cleanup is idempotent and detaches the listener', () => {
  const removed = [];
  const fakeSignal = {
    aborted: false,
    addEventListener() {},
    removeEventListener(name) { removed.push(name); },
  };
  const arm = createAbortRejectionArm(fakeSignal, 'x');
  arm.cleanup();
  arm.cleanup(); // 第二次调用无害
  assert.strictEqual(removed.filter((n) => n === 'abort').length, 1, 'listener removed exactly once');
});

test('addEventListener throwing → degrades to never-settling arm, no throw', async () => {
  const fakeSignal = {
    aborted: false,
    addEventListener() { throw new Error('boom'); },
    removeEventListener() {},
  };
  let arm;
  assert.doesNotThrow(() => { arm = createAbortRejectionArm(fakeSignal, 'x'); });
  const winner = await Promise.race([Promise.resolve('ok'), arm.promise]);
  assert.strictEqual(winner, 'ok');
  arm.cleanup();
});
