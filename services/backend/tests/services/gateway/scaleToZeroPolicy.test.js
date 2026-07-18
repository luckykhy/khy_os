'use strict';

/**
 * scaleToZeroPolicy.test.js — 网关 scale-to-zero 决策纯叶子(node:test)。
 *
 * 覆盖:门控(opt-in 默认关 / '1'|'true'|'on' 开 / falsy 关 / 异常不抛)、resolveIdleWindowMs
 * (默认 + clamp[60000, 86400000])、warmupOnNextStart、describeScaleDecision 决策矩阵
 * (disabled / active-requests / within-window / idle-exceeded / 确定性 / 绝不抛),以及
 * wiring-grep(daemonManager 接线 + flagRegistry 注册两 flag)。零 IO、确定性。用 `node --test` 跑。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  KHY_GATEWAY_SCALE_TO_ZERO,
  KHY_GATEWAY_SCALE_TO_ZERO_IDLE_MS,
  KHY_GATEWAY_WARMUP_ON_BOOT,
  DEFAULT_IDLE_WINDOW_MS,
  scaleToZeroEnabled,
  resolveIdleWindowMs,
  warmupOnNextStart,
  describeScaleDecision,
} = require('../../../src/services/gateway/scaleToZeroPolicy');

const BACKEND_ROOT = path.resolve(__dirname, '../../..');

// ── 门控(opt-in) ─────────────────────────────────────────────────────────
test('scaleToZeroEnabled:opt-in —— 缺省/falsy 关,仅 1/true 开', () => {
  assert.equal(scaleToZeroEnabled({}), false);
  assert.equal(scaleToZeroEnabled({ [KHY_GATEWAY_SCALE_TO_ZERO]: '0' }), false);
  assert.equal(scaleToZeroEnabled({ [KHY_GATEWAY_SCALE_TO_ZERO]: 'false' }), false);
  assert.equal(scaleToZeroEnabled({ [KHY_GATEWAY_SCALE_TO_ZERO]: '' }), false);
  assert.equal(scaleToZeroEnabled({ [KHY_GATEWAY_SCALE_TO_ZERO]: 'off' }), false);
  assert.equal(scaleToZeroEnabled({ [KHY_GATEWAY_SCALE_TO_ZERO]: 'on' }), false); // opt-in 严格:on 不算开
  for (const v of ['1', 'true']) {
    assert.equal(scaleToZeroEnabled({ [KHY_GATEWAY_SCALE_TO_ZERO]: v }), true, v);
  }
});

test('scaleToZeroEnabled:异常输入不抛', () => {
  assert.doesNotThrow(() => scaleToZeroEnabled(null));
  assert.doesNotThrow(() => scaleToZeroEnabled(42));
});

// ── 闲置窗口 ─────────────────────────────────────────────────────────────
test('resolveIdleWindowMs:默认 900000;clamp[60000, 86400000];垃圾 → 默认', () => {
  assert.equal(resolveIdleWindowMs({}), DEFAULT_IDLE_WINDOW_MS);
  assert.equal(resolveIdleWindowMs({}), 900000);
  assert.equal(resolveIdleWindowMs({ [KHY_GATEWAY_SCALE_TO_ZERO_IDLE_MS]: '120000' }), 120000);
  assert.equal(resolveIdleWindowMs({ [KHY_GATEWAY_SCALE_TO_ZERO_IDLE_MS]: '1000' }), 60000); // 过小 → min
  assert.equal(resolveIdleWindowMs({ [KHY_GATEWAY_SCALE_TO_ZERO_IDLE_MS]: '999999999' }), 86400000); // 过大 → max
  assert.equal(resolveIdleWindowMs({ [KHY_GATEWAY_SCALE_TO_ZERO_IDLE_MS]: 'abc' }), 900000); // 垃圾 → 默认
});

test('resolveIdleWindowMs:异常输入不抛', () => {
  assert.doesNotThrow(() => resolveIdleWindowMs(null));
});

// ── 预热 ─────────────────────────────────────────────────────────────────
test('warmupOnNextStart:KHY_GATEWAY_WARMUP_ON_BOOT 权威语义(默认开,仅 false 关)', () => {
  // 权威(prefetch.js:111 / bin/khy.js:924):默认 'true',仅字面量 'false' 关闭。
  assert.equal(warmupOnNextStart({}), true);
  assert.equal(warmupOnNextStart({ [KHY_GATEWAY_WARMUP_ON_BOOT]: 'false' }), false);
  assert.equal(warmupOnNextStart({ [KHY_GATEWAY_WARMUP_ON_BOOT]: 'FALSE' }), false); // 大小写不敏感
  assert.equal(warmupOnNextStart({ [KHY_GATEWAY_WARMUP_ON_BOOT]: '0' }), true); // 仅 'false' 关,'0' 不关
  assert.equal(warmupOnNextStart({ [KHY_GATEWAY_WARMUP_ON_BOOT]: 'true' }), true);
});

// ── 决策矩阵 ─────────────────────────────────────────────────────────────
test('describeScaleDecision:门关 → disabled,不降零', () => {
  const r = describeScaleDecision({ idleMs: 10 ** 9, activeRequests: 0 }, {});
  assert.equal(r.eligible, false);
  assert.equal(r.scaleDown, false);
  assert.equal(r.reason, 'disabled');
});

test('describeScaleDecision:门开 + 在途请求 → active-requests,不降零', () => {
  const env = { [KHY_GATEWAY_SCALE_TO_ZERO]: '1' };
  const r = describeScaleDecision({ idleMs: 10 ** 9, activeRequests: 2 }, env);
  assert.equal(r.eligible, true);
  assert.equal(r.scaleDown, false);
  assert.equal(r.reason, 'active-requests');
});

test('describeScaleDecision:门开 + 窗口内 → within-window,不降零', () => {
  const env = { [KHY_GATEWAY_SCALE_TO_ZERO]: '1' };
  const r = describeScaleDecision({ idleMs: 1000, activeRequests: 0 }, env);
  assert.equal(r.scaleDown, false);
  assert.equal(r.reason, 'within-window');
  assert.equal(r.idleWindowMs, 900000);
});

test('describeScaleDecision:门开 + 超窗 + 无在途 → idle-exceeded,降零 + warmupOnNext', () => {
  const env = { [KHY_GATEWAY_SCALE_TO_ZERO]: '1', [KHY_GATEWAY_SCALE_TO_ZERO_IDLE_MS]: '60000' };
  const r = describeScaleDecision({ idleMs: 120000, activeRequests: 0 }, env);
  assert.equal(r.eligible, true);
  assert.equal(r.scaleDown, true);
  assert.equal(r.reason, 'idle-exceeded');
  assert.equal(r.idleWindowMs, 60000);
  assert.equal(typeof r.warmupOnNext, 'boolean');
});

test('describeScaleDecision:确定性(同输入同输出)', () => {
  const env = { [KHY_GATEWAY_SCALE_TO_ZERO]: '1' };
  const sig = { idleMs: 950000, activeRequests: 0 };
  assert.deepEqual(describeScaleDecision(sig, env), describeScaleDecision(sig, env));
});

test('describeScaleDecision:坏输入绝不抛', () => {
  assert.doesNotThrow(() => describeScaleDecision(null, {}));
  assert.doesNotThrow(() => describeScaleDecision(undefined, undefined));
  assert.doesNotThrow(() => describeScaleDecision(42, 42));
  const r = describeScaleDecision(null, {});
  assert.equal(r.scaleDown, false);
});

// ── wiring grep ──────────────────────────────────────────────────────────
test('wiring:daemonManager 接线 + flagRegistry 注册两 flag', () => {
  const dm = fs.readFileSync(path.join(BACKEND_ROOT, 'src/services/daemonManager.js'), 'utf8');
  assert.ok(dm.includes('scaleToZeroPolicy'), 'daemonManager 应 require scaleToZeroPolicy');
  assert.ok(dm.includes('describeScaleDecision'), 'daemonManager 应调 describeScaleDecision');

  const reg = fs.readFileSync(path.join(BACKEND_ROOT, 'src/services/flagRegistry.js'), 'utf8');
  assert.ok(reg.includes('KHY_GATEWAY_SCALE_TO_ZERO:'), 'flag KHY_GATEWAY_SCALE_TO_ZERO 注册');
  assert.ok(reg.includes('KHY_GATEWAY_SCALE_TO_ZERO_IDLE_MS:'), 'flag KHY_GATEWAY_SCALE_TO_ZERO_IDLE_MS 注册');
});
