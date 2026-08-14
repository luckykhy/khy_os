'use strict';

/**
 * toolUseLoop.stopReason.test.js — 批1 stop_reason 信任(循环侧纯判定)。
 *
 * 循环的续跑/收尾哲学:结构化 toolUseBlocks 的**存在性**是主信号,stop_reason 仅作**二级
 * 提示**(与 toolUseLoop.js:2491-2496 注释一致)。本批新增一道 native-only 的续跑保护:
 * 当 native 回合 stop_reason=tool_use 但 blocks 丢失且文本兜底也没捞到时,不静默收尾。
 *
 * 这里锁定两个被导出的纯函数:
 *  - _normalizeStopReason: 各家 finish/stop 值归一(tool_calls/end_turn/length 变体);
 *  - _shouldTrustStopReason: 仅 native 协议 + KHY_TRUST_STOP_REASON(默认 on)才信任。
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const loop = require('../../src/services/toolUseLoop');

describe('_normalizeStopReason — 跨家归一', () => {
  test('OpenAI tool_calls / Anthropic tool_use → tool_use', () => {
    assert.equal(loop._normalizeStopReason('tool_calls'), 'tool_use');
    assert.equal(loop._normalizeStopReason('tool_use'), 'tool_use');
    assert.equal(loop._normalizeStopReason('function_call'), 'tool_use');
  });

  test('end_turn / stop / completed → stop', () => {
    assert.equal(loop._normalizeStopReason('end_turn'), 'stop');
    assert.equal(loop._normalizeStopReason('stop'), 'stop');
    assert.equal(loop._normalizeStopReason('completed'), 'stop');
  });

  test('max_tokens 变体 → length', () => {
    assert.equal(loop._normalizeStopReason('max_tokens'), 'length');
    assert.equal(loop._normalizeStopReason('length'), 'length');
  });

  test('空 / 未知值保守处理', () => {
    assert.equal(loop._normalizeStopReason(''), '');
    assert.equal(loop._normalizeStopReason(null), '');
    assert.equal(loop._normalizeStopReason('eos'), 'eos'); // 未识别 → 原样小写,不误触发新逻辑
  });
});

describe('_shouldTrustStopReason — native-only + 逃生阀', () => {
  afterEach(() => { delete process.env.KHY_TRUST_STOP_REASON; });

  test('文本协议永不信任 stop_reason', () => {
    assert.equal(loop._shouldTrustStopReason(true), false);
  });

  test('native 协议默认信任', () => {
    delete process.env.KHY_TRUST_STOP_REASON;
    assert.equal(loop._shouldTrustStopReason(false), true);
  });

  test('KHY_TRUST_STOP_REASON=0 关闭信任(回退旧行为)', () => {
    process.env.KHY_TRUST_STOP_REASON = '0';
    assert.equal(loop._shouldTrustStopReason(false), false);
  });

  test('KHY_TRUST_STOP_REASON=off 关闭信任', () => {
    process.env.KHY_TRUST_STOP_REASON = 'off';
    assert.equal(loop._shouldTrustStopReason(false), false);
  });

  test('逃生阀关闭时即使 native 也不信任 → 文本协议仍恒 false', () => {
    process.env.KHY_TRUST_STOP_REASON = 'false';
    assert.equal(loop._shouldTrustStopReason(true), false);
    assert.equal(loop._shouldTrustStopReason(false), false);
  });
});
