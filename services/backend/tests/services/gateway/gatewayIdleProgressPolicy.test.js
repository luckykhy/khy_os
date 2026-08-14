'use strict';

const test = require('node:test');
const assert = require('node:assert');

const policy = require('../../../src/services/gateway/gatewayIdleProgressPolicy');
const { shouldResetIdle, idleProgressOnlyEnabled, GATE_FLAG } = policy;

// 网关 idle 看门狗:只有「真实推进」重置 idle;门关逐字节回退今日「任何心跳都重置」。
// 四组组合矩阵:门开/门关 × 真实推进/网关自言自语。

test('GATE_FLAG 是稳定的门名', () => {
  assert.strictEqual(GATE_FLAG, 'KHY_GATEWAY_IDLE_PROGRESS_ONLY');
});

test('门开(默认) + 真实推进 → 重置 idle(慢任务不误杀)', () => {
  const env = {}; // 缺省即默认开
  assert.strictEqual(idleProgressOnlyEnabled(env), true);
  assert.strictEqual(shouldResetIdle(true, env), true);
});

test('门开(默认) + 网关自言自语 → 不重置(卡死可被兜底 abort)', () => {
  const env = {};
  assert.strictEqual(shouldResetIdle(false, env), false);
});

test('门显式开 ON + 真实推进 → 重置', () => {
  const env = { KHY_GATEWAY_IDLE_PROGRESS_ONLY: 'on' };
  assert.strictEqual(idleProgressOnlyEnabled(env), true);
  assert.strictEqual(shouldResetIdle(true, env), true);
});

test('门显式开 ON + 网关自言自语 → 不重置', () => {
  const env = { KHY_GATEWAY_IDLE_PROGRESS_ONLY: 'on' };
  assert.strictEqual(shouldResetIdle(false, env), false);
});

test('门关 OFF + 真实推进 → 重置(今日行为)', () => {
  const env = { KHY_GATEWAY_IDLE_PROGRESS_ONLY: 'off' };
  assert.strictEqual(idleProgressOnlyEnabled(env), false);
  assert.strictEqual(shouldResetIdle(true, env), true);
});

test('门关 OFF + 网关自言自语 → 仍重置(逐字节回退:任何心跳都续命)', () => {
  const env = { KHY_GATEWAY_IDLE_PROGRESS_ONLY: 'off' };
  assert.strictEqual(shouldResetIdle(false, env), true);
});

test('门关的各种拼写(0/false/no)都回退今日行为', () => {
  for (const raw of ['0', 'false', 'no', 'FALSE', 'Off']) {
    const env = { KHY_GATEWAY_IDLE_PROGRESS_ONLY: raw };
    assert.strictEqual(
      idleProgressOnlyEnabled(env),
      false,
      `raw=${raw} 应判为门关`
    );
    // 门关 → 网关自言自语也重置(今日行为)
    assert.strictEqual(shouldResetIdle(false, env), true, `raw=${raw} 门关应恒重置`);
  }
});

test('isRealProgress 非严格 true(如 truthy 对象/1/"yes")在门开时不被当作真实推进', () => {
  // 契约:只有 === true 才算真实推进,避免调用方误传 truthy 值绕过兜底。
  const env = {};
  assert.strictEqual(shouldResetIdle(1, env), false);
  assert.strictEqual(shouldResetIdle('yes', env), false);
  assert.strictEqual(shouldResetIdle({}, env), false);
});

test('绝不抛:异常输入(env 取值 throw)→ 保守回退重置 idle', () => {
  const hostileEnv = {
    get KHY_GATEWAY_IDLE_PROGRESS_ONLY() {
      throw new Error('boom');
    },
  };
  // idleProgressOnlyEnabled 内部 _envOn 异常 → false(门关)→ shouldResetIdle 恒 true
  assert.strictEqual(shouldResetIdle(false, hostileEnv), true);
});
