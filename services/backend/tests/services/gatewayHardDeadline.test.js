'use strict';

/**
 * gatewayHardDeadline.test.js — 网关墙钟硬死线 + 级联总次数封顶纯叶子的单测(node:test)。
 *
 * 覆盖:
 *  - 门控关 → createGatewayDeadline 返 null(逐字节回退今日无硬死线路径)。
 *  - optionsTimeoutMs 优先 + clamp[5000, 1800000]。
 *  - env 覆盖 + 任务规模保守默认(small/normal/large)。
 *  - exceeded 用注入时钟到点为真,且只依赖 now(与 touch 活动无关的不变量)。
 *  - remainingMs 单调递减、下界 0。
 *  - resolveMaxTotalAttempts:默认 48、显式关闭(0/off/false/no)→ Infinity、越界 clamp。
 *  - shouldStopForAttemptCap:count>=cap 为真;不封顶恒 false;坏输入不抛。
 *
 * 运行:node --test services/backend/tests/services/gatewayHardDeadline.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const hd = require('../../src/services/gateway/_gatewayHardDeadline');

test('门控关 → createGatewayDeadline 返 null(逐字节回退今日行为)', () => {
  assert.equal(hd.createGatewayDeadline({ env: { KHY_GATEWAY_HARD_TIMEOUT: 'off' } }), null);
  assert.equal(hd.createGatewayDeadline({ env: { KHY_GATEWAY_HARD_TIMEOUT: '0' } }), null);
  assert.equal(hd.createGatewayDeadline({ env: { KHY_GATEWAY_HARD_TIMEOUT: 'false' } }), null);
  assert.equal(hd.createGatewayDeadline({ env: { KHY_GATEWAY_HARD_TIMEOUT: 'no' } }), null);
});

test('门控默认 on:createGatewayDeadline 返判定器', () => {
  const d = hd.createGatewayDeadline({ env: {} });
  assert.ok(d && typeof d.exceeded === 'function');
  assert.equal(typeof d.deadlineMs, 'number');
  assert.equal(typeof d.startedAt, 'number');
});

test('optionsTimeoutMs 优先并 clamp[5000, 1800000]', () => {
  assert.equal(hd.resolveGatewayHardTimeoutMs({ optionsTimeoutMs: 123456, env: {} }), 123456);
  // 低于下限 → 5000;高于上限 → 1800000。
  assert.equal(hd.resolveGatewayHardTimeoutMs({ optionsTimeoutMs: 10, env: {} }), 5000);
  assert.equal(hd.resolveGatewayHardTimeoutMs({ optionsTimeoutMs: 99999999, env: {} }), 1800000);
  // 非法 optionsTimeoutMs → 落到下一优先级。
  assert.equal(
    hd.resolveGatewayHardTimeoutMs({ optionsTimeoutMs: 'abc', env: {} }),
    hd.HARD_TIMEOUT_DEFAULTS.normal
  );
});

test('env KHY_GATEWAY_HARD_TIMEOUT_MS 覆盖任务规模默认', () => {
  assert.equal(
    hd.resolveGatewayHardTimeoutMs({ env: { KHY_GATEWAY_HARD_TIMEOUT_MS: '60000' } }),
    60000
  );
  // env 越界 clamp。
  assert.equal(
    hd.resolveGatewayHardTimeoutMs({ env: { KHY_GATEWAY_HARD_TIMEOUT_MS: '1' } }),
    5000
  );
});

test('任务规模保守默认:small<normal<large', () => {
  assert.equal(hd.resolveGatewayHardTimeoutMs({ taskScale: { isSmallTask: true }, env: {} }), 180000);
  assert.equal(hd.resolveGatewayHardTimeoutMs({ env: {} }), 300000);
  assert.equal(hd.resolveGatewayHardTimeoutMs({ taskScale: { isLargeTask: true }, env: {} }), 600000);
});

test('exceeded 用注入时钟:到点前 false、到点/之后 true(只依赖 now)', () => {
  let now = 1000;
  const clock = () => now;
  const d = hd.createGatewayDeadline({
    optionsTimeoutMs: 5000,
    nowFn: clock,
    env: {},
  });
  assert.equal(d.startedAt, 1000);
  assert.equal(d.deadlineMs, 5000);
  assert.equal(d.exceeded(), false); // now=1000, deadline=6000
  // 关键不变量:即便"活动持续"(叶子无 touch 概念),exceeded 只随 now 前进而翻转。
  now = 5999;
  assert.equal(d.exceeded(), false);
  now = 6000;
  assert.equal(d.exceeded(), true);
  now = 999999;
  assert.equal(d.exceeded(), true);
  // 显式注入 now 覆盖 clock。
  assert.equal(d.exceeded(3000), false);
  assert.equal(d.exceeded(7000), true);
});

test('remainingMs 单调递减、下界 0', () => {
  let now = 0;
  const d = hd.createGatewayDeadline({ optionsTimeoutMs: 10000, nowFn: () => now, env: {} });
  assert.equal(d.remainingMs(), 10000);
  now = 4000;
  assert.equal(d.remainingMs(), 6000);
  now = 10000;
  assert.equal(d.remainingMs(), 0);
  now = 20000;
  assert.equal(d.remainingMs(), 0); // 不为负
});

test('createGatewayDeadline 坏时钟 → fail-soft 返 null', () => {
  const bad = () => { throw new Error('boom'); };
  assert.equal(hd.createGatewayDeadline({ nowFn: bad, env: {} }), null);
});

test('resolveMaxTotalAttempts:默认 48', () => {
  assert.equal(hd.resolveMaxTotalAttempts({}), 48);
});

test('resolveMaxTotalAttempts:显式 0/off/false/no → Infinity(关闭封顶)', () => {
  assert.equal(hd.resolveMaxTotalAttempts({ KHY_GATEWAY_MAX_TOTAL_ATTEMPTS: '0' }), Infinity);
  assert.equal(hd.resolveMaxTotalAttempts({ KHY_GATEWAY_MAX_TOTAL_ATTEMPTS: 'off' }), Infinity);
  assert.equal(hd.resolveMaxTotalAttempts({ KHY_GATEWAY_MAX_TOTAL_ATTEMPTS: 'false' }), Infinity);
  assert.equal(hd.resolveMaxTotalAttempts({ KHY_GATEWAY_MAX_TOTAL_ATTEMPTS: 'no' }), Infinity);
});

test('resolveMaxTotalAttempts:合法值透传;越界 clamp[4,500]', () => {
  assert.equal(hd.resolveMaxTotalAttempts({ KHY_GATEWAY_MAX_TOTAL_ATTEMPTS: '100' }), 100);
  assert.equal(hd.resolveMaxTotalAttempts({ KHY_GATEWAY_MAX_TOTAL_ATTEMPTS: '99999' }), 500);
  // 低于下限 4 的数值被 clamp 到下限 4(非关闭词,故非 Infinity)。
  assert.equal(hd.resolveMaxTotalAttempts({ KHY_GATEWAY_MAX_TOTAL_ATTEMPTS: '2' }), 4);
});

test('shouldStopForAttemptCap:count>=cap 为真、以下为假', () => {
  const env = { KHY_GATEWAY_MAX_TOTAL_ATTEMPTS: '10' };
  assert.equal(hd.shouldStopForAttemptCap(9, env), false);
  assert.equal(hd.shouldStopForAttemptCap(10, env), true);
  assert.equal(hd.shouldStopForAttemptCap(11, env), true);
});

test('shouldStopForAttemptCap:不封顶(Infinity)恒 false;坏输入不抛', () => {
  const env = { KHY_GATEWAY_MAX_TOTAL_ATTEMPTS: 'off' };
  assert.equal(hd.shouldStopForAttemptCap(9999, env), false);
  assert.equal(hd.shouldStopForAttemptCap(undefined, {}), false);
  assert.equal(hd.shouldStopForAttemptCap(NaN, {}), false);
});
