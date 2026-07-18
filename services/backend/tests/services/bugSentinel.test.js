'use strict';

/**
 * bugSentinel.test.js — 「越早暴露 + 主动监听发现 + 被动兜底」哨兵纯模块单测。
 *
 * 守护:
 *   1. invariant:strict 违反立刻抛(越早暴露)/observe 记录不抛(被动兜底)/off 纯透传不记录。
 *   2. tripwire:把静默吞咽登记成可观测信号、绝不抛;off 不记录。
 *   3. 滑窗主动预警:同一 code 在窗口内越过保守阈值才发 anomaly,且去重(越阈值期只发一次,
 *      回落后可再触发);健康会话的偶发单次吞咽零误报。
 *   4. snapshot 数据契约 + hasSignal。
 *
 * 用注入时钟使滑窗确定性、零等待。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const sentinel = require('../../src/services/bugSentinel');

// 隔离:每个用例独立时钟与状态、显式 env(避免 NODE_ENV=test 默认 strict 干扰 observe 用例)。
let _t = 1_000_000;
beforeEach(() => {
  sentinel.reset();
  _t = 1_000_000;
  sentinel.__setClock(() => _t);
});
afterEach(() => { sentinel.__setClock(null); });

const OBSERVE = { KHY_BUG_SENTINEL: 'observe' };
const STRICT = { KHY_BUG_SENTINEL: 'strict' };
const OFF = { KHY_BUG_SENTINEL: 'off' };

describe('bugSentinel.invariant — 越早暴露 vs 被动兜底', () => {
  test('strict:违反立刻抛 BugSentinelError(最早边界暴露)', () => {
    assert.throws(
      () => sentinel.invariant(false, 'loop.contract', '不该为空', STRICT),
      (e) => e instanceof sentinel.BugSentinelError && e.code === 'loop.contract',
    );
    assert.equal(sentinel.snapshot(STRICT).breaches, 1);
  });

  test('observe:违反记录但不抛,返回 false(被动兜底)', () => {
    let ret;
    assert.doesNotThrow(() => { ret = sentinel.invariant(false, 'x.y', 'd', OBSERVE); });
    assert.equal(ret, false);
    assert.equal(sentinel.snapshot(OBSERVE).breaches, 1);
  });

  test('条件为真:返回 true,不记录', () => {
    assert.equal(sentinel.invariant(1 === 1, 'ok', '', STRICT), true);
    assert.equal(sentinel.snapshot(STRICT).breaches, 0);
  });

  test('off:纯布尔透传,不抛、不记录', () => {
    assert.equal(sentinel.invariant(false, 'z', 'd', OFF), false);
    assert.equal(sentinel.invariant(true, 'z', 'd', OFF), true);
    assert.equal(sentinel.snapshot(OFF).breaches, 0);
  });
});

describe('bugSentinel.tripwire — 静默吞咽变可观测信号', () => {
  test('登记被吞错误、绝不抛,返回记录', () => {
    let rec;
    assert.doesNotThrow(() => { rec = sentinel.tripwire(new Error('boom'), { code: 'svc.opt' }, OBSERVE); });
    assert.equal(rec.code, 'svc.opt');
    assert.match(rec.detail, /boom/);
    assert.equal(sentinel.snapshot(OBSERVE).swallowed, 1);
  });

  test('无 context.code → 从 error 推导 code', () => {
    const e = new Error('x'); e.code = 'ECONNRESET';
    sentinel.tripwire(e, {}, OBSERVE);
    assert.ok(sentinel.snapshot(OBSERVE).byCode['err.ECONNRESET'] >= 1);
  });

  test('off:不记录,返回 null', () => {
    assert.equal(sentinel.tripwire(new Error('x'), { code: 'a' }, OFF), null);
    assert.equal(sentinel.snapshot(OFF).swallowed, 0);
  });
});

describe('bugSentinel — 主动监听发现(保守滑窗)', () => {
  test('同一 code 在窗口内达到阈值 → 主动发一次 anomaly;未达阈值零误报', () => {
    const seen = [];
    const off = sentinel.onAnomaly((a) => seen.push(a));
    const env = { KHY_BUG_SENTINEL: 'observe', KHY_BUG_SENTINEL_WINDOW_MS: '1000', KHY_BUG_SENTINEL_THRESHOLD: '5', KHY_BUG_SENTINEL_ACTIVE: 'off' };

    // 健康会话:4 次(< 阈值 5)在窗口内 → 不告警。
    for (let i = 0; i < 4; i += 1) { _t += 10; sentinel.tripwire(new Error('e'), { code: 'hot.path' }, env); }
    assert.equal(seen.length, 0, '未达阈值不应告警(零误报)');

    // 第 5 次越阈值 → 恰好一次 anomaly。
    _t += 10; sentinel.tripwire(new Error('e'), { code: 'hot.path' }, env);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].code, 'hot.path');
    assert.equal(seen[0].count, 5);

    // 第 6 次仍在越阈值态 → 去重,不再发。
    _t += 10; sentinel.tripwire(new Error('e'), { code: 'hot.path' }, env);
    assert.equal(seen.length, 1, '越阈值期间应去重');
    off();
  });

  test('时间流逝让旧记录滑出窗口 → 计数回落,可再次触发', () => {
    const seen = [];
    sentinel.onAnomaly((a) => seen.push(a));
    const env = { KHY_BUG_SENTINEL: 'observe', KHY_BUG_SENTINEL_WINDOW_MS: '1000', KHY_BUG_SENTINEL_THRESHOLD: '3', KHY_BUG_SENTINEL_ACTIVE: 'off' };

    for (let i = 0; i < 3; i += 1) { _t += 100; sentinel.tripwire(new Error('e'), { code: 'c' }, env); }
    assert.equal(seen.length, 1);

    // 跳过 2s,旧的全部滑出窗口 → active 解除。
    _t += 2000;
    sentinel.tripwire(new Error('e'), { code: 'c' }, env); // 窗口内仅剩 1
    assert.equal(sentinel.snapshot(env).active.includes('c'), false);

    // 再攒到阈值 → 第二次告警。
    for (let i = 0; i < 2; i += 1) { _t += 50; sentinel.tripwire(new Error('e'), { code: 'c' }, env); }
    assert.equal(seen.length, 2, '回落后应能再次触发');
  });

  const _tick = () => new Promise((r) => setImmediate(r));

  test('主动监听:越阈值瞬间经 Node 警告通道主动推一条预警(去重一次)', async () => {
    const warnings = [];
    const onWarn = (w) => { if (w && w.name === 'BugSentinelAnomaly') warnings.push(w); };
    process.on('warning', onWarn);
    try {
      // 默认 active 开(不带 KHY_BUG_SENTINEL_ACTIVE)。
      const env = { KHY_BUG_SENTINEL: 'observe', KHY_BUG_SENTINEL_WINDOW_MS: '1000', KHY_BUG_SENTINEL_THRESHOLD: '3' };
      for (let i = 0; i < 5; i += 1) { _t += 10; sentinel.tripwire(new Error('e'), { code: 'active.demo' }, env); }
      await _tick(); // process.emitWarning 在 nextTick 异步派发 'warning' 事件
      assert.equal(warnings.length, 1, '越阈值期应只主动推一条');
    } finally {
      process.removeListener('warning', onWarn);
    }
  });

  test('KHY_BUG_SENTINEL_ACTIVE=off → 不走主动通道,但 snapshot 仍可被动拉取', async () => {
    const warnings = [];
    const onWarn = (w) => { if (w && w.name === 'BugSentinelAnomaly') warnings.push(w); };
    process.on('warning', onWarn);
    try {
      const env = { KHY_BUG_SENTINEL: 'observe', KHY_BUG_SENTINEL_WINDOW_MS: '1000', KHY_BUG_SENTINEL_THRESHOLD: '3', KHY_BUG_SENTINEL_ACTIVE: 'off' };
      for (let i = 0; i < 4; i += 1) { _t += 10; sentinel.tripwire(new Error('e'), { code: 'silent.demo' }, env); }
      await _tick();
      assert.equal(warnings.length, 0, 'active=off 不应主动推送');
      assert.equal(sentinel.snapshot(env).active.includes('silent.demo'), true, '但被动 snapshot 仍记录越阈值');
    } finally {
      process.removeListener('warning', onWarn);
    }
  });

  test('invariant 违反同样喂入滑窗(observe 下不抛但会主动预警)', () => {
    const seen = [];
    sentinel.onAnomaly((a) => seen.push(a));
    const env = { KHY_BUG_SENTINEL: 'observe', KHY_BUG_SENTINEL_WINDOW_MS: '1000', KHY_BUG_SENTINEL_THRESHOLD: '3', KHY_BUG_SENTINEL_ACTIVE: 'off' };
    for (let i = 0; i < 3; i += 1) { _t += 10; sentinel.invariant(false, 'inv.repeat', 'd', env); }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, 'invariant');
  });
});

describe('bugSentinel.snapshot / hasSignal — 数据契约', () => {
  test('snapshot 暴露 mode/swallowed/breaches/byCode/anomalies/window', () => {
    sentinel.tripwire(new Error('a'), { code: 'k1' }, OBSERVE);
    sentinel.invariant(false, 'k2', 'd', OBSERVE);
    const s = sentinel.snapshot(OBSERVE);
    assert.equal(s.mode, 'observe');
    assert.equal(s.swallowed, 1);
    assert.equal(s.breaches, 1);
    assert.equal(s.byCode.k1, 1);
    assert.equal(s.byCode.k2, 1);
    assert.equal(s.window.threshold, 5);
    assert.ok(Array.isArray(s.anomalies));
  });

  test('hasSignal:无记录 false,有记录 true', () => {
    assert.equal(sentinel.hasSignal(), false);
    sentinel.tripwire(new Error('x'), { code: 'k' }, OBSERVE);
    assert.equal(sentinel.hasSignal(), true);
  });

  test('reset 清空全部状态', () => {
    sentinel.tripwire(new Error('x'), { code: 'k' }, OBSERVE);
    sentinel.reset();
    assert.equal(sentinel.hasSignal(), false);
    assert.equal(sentinel.snapshot(OBSERVE).swallowed, 0);
  });
});
