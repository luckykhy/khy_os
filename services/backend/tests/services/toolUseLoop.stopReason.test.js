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
const loop = require('../../src/services/toolUseLoop');
describe('_normalizeStopReason — 跨家归一', () => {
});
describe('_shouldTrustStopReason — native-only + 逃生阀', () => {
  afterEach(() => { delete process.env.KHY_TRUST_STOP_REASON; });
});

describe('Tool Use Loop stop Reason', () => {
  test('OpenAI tool_calls / Anthropic tool_use → tool_use', () => {
        expect(loop._normalizeStopReason('tool_calls')).toBe('tool_use');
        expect(loop._normalizeStopReason('tool_use')).toBe('tool_use');
        expect(loop._normalizeStopReason('function_call')).toBe('tool_use');
  });

  test('end_turn / stop / completed → stop', () => {
        expect(loop._normalizeStopReason('end_turn')).toBe('stop');
        expect(loop._normalizeStopReason('stop')).toBe('stop');
        expect(loop._normalizeStopReason('completed')).toBe('stop');
  });

  test('max_tokens 变体 → length', () => {
        expect(loop._normalizeStopReason('max_tokens')).toBe('length');
        expect(loop._normalizeStopReason('length')).toBe('length');
  });

  test('空 / 未知值保守处理', () => {
        expect(loop._normalizeStopReason('')).toBe('');
        expect(loop._normalizeStopReason(null)).toBe('');
        expect(loop._normalizeStopReason('eos')).toBe('eos'); // 未识别 → 原样小写,不误触发新逻辑
  });

  test('文本协议永不信任 stop_reason', () => {
        expect(loop._shouldTrustStopReason(true)).toBe(false);
  });

  test('native 协议默认信任', () => {
        delete process.env.KHY_TRUST_STOP_REASON;
        expect(loop._shouldTrustStopReason(false)).toBe(true);
  });

  test('KHY_TRUST_STOP_REASON=0 关闭信任(回退旧行为)', () => {
        process.env.KHY_TRUST_STOP_REASON = '0';
        expect(loop._shouldTrustStopReason(false)).toBe(false);
  });

  test('KHY_TRUST_STOP_REASON=off 关闭信任', () => {
        process.env.KHY_TRUST_STOP_REASON = 'off';
        expect(loop._shouldTrustStopReason(false)).toBe(false);
  });

  test('逃生阀关闭时即使 native 也不信任 → 文本协议仍恒 false', () => {
        process.env.KHY_TRUST_STOP_REASON = 'false';
        expect(loop._shouldTrustStopReason(true)).toBe(false);
        expect(loop._shouldTrustStopReason(false)).toBe(false);
  });

});
