'use strict';

// _isTransientLoopErrorType — 网络抖动相关错误是否被工具循环识别为「可重试瞬态」。
// goal 2026-08-07:server_error(5xx) 与 retry_budget_exceeded 此前不在集合内,网关层
// 重试耗尽后工具循环不重试 → 一次网络抖动永久中断当前任务。本测试锁定加入后的行为。

const test = require('node:test');
const assert = require('node:assert');

const { _isTransientLoopErrorType } = require('../../src/services/toolUseLoopCore');

test('legacy transient types stay transient', () => {
  for (const t of ['timeout', 'cancelled', 'network', 'process', 'empty', 'unknown']) {
    assert.equal(_isTransientLoopErrorType(t), true, `${t} must be transient`);
  }
});

test('server_error (5xx network jitter) is now transient', () => {
  // 502/503/504 等 5xx 上游瞬时故障:网关层有冷却+重试预算增强,但预算耗尽后返回
  // server_error 给工具循环,必须识别为瞬态以便有界二次重试,而非永久中断。
  assert.equal(_isTransientLoopErrorType('server_error'), true);
  assert.equal(_isTransientLoopErrorType('SERVER_ERROR'), true);
});

test('retry_budget_exceeded is now transient', () => {
  // 网关网络抖动重试预算耗尽 ≠ 通道永久失败;工具循环的有界恢复可在延迟后再次尝试。
  assert.equal(_isTransientLoopErrorType('retry_budget_exceeded'), true);
});

test('case/whitespace tolerant', () => {
  assert.equal(_isTransientLoopErrorType('  Server_Error '), true);
  assert.equal(_isTransientLoopErrorType('Retry_Budget_Exceeded'), true);
});

test('non-transient types stay false', () => {
  for (const t of ['auth', 'permission', 'content_filter', 'model_not_found', 'rate_limit', 'refusal', '', null, undefined]) {
    assert.equal(_isTransientLoopErrorType(t), false, `${t} must NOT be transient`);
  }
});
