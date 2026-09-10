'use strict';
// Unit tests for streamErrorPartial pure leaf — decides whether a socket-level
// stream error that fires AFTER partial content was emitted should preserve
// that partial (→ length continuation path) instead of reject-and-discard.
// node:test (jest is broken under rtk — run with `node --test`).
const sep = require('../../../../src/services/gateway/adapters/streamErrorPartial');
const ON = {}; // 默认开
const OFF = { KHY_STREAM_ERROR_PRESERVE: '0' };
const econnreset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
const sockethang = () => new Error('socket hang up');
const aborterr = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
const genericErr = () => new Error('boom');
// ── 门控梯 ──────────────────────────────────────────────────────────────────
// ── shouldPreservePartial ───────────────────────────────────────────────────
// ── isUserAbort 防呆 ─────────────────────────────────────────────────────────

describe('Stream Error Partial', () => {
  test('isEnabled: 默认开', () => {
      expect(sep.isEnabled(ON)).toBe(true);
      expect(sep.isEnabled(undefined)).toBe(true);
  });

  test('isEnabled: 0/false/off/no → 关(大小写/空白不敏感)', () => {
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(sep.isEnabled({ KHY_STREAM_ERROR_PRESERVE: v })).toBe(false);
      }
  });

  test('瞬时 socket 断 + 已吐 content → 保全(true)', () => {
      expect(sep.shouldPreservePartial({ error: econnreset(), hasContent: true }, ON)).toBe(true);
      expect(sep.shouldPreservePartial({ error: sockethang(), hasContent: true }, ON)).toBe(true);
  });

  test('非瞬时但非中止的普通 error + 已吐 content → 仍保全(对齐 OpenAI 路径:非中止+有进度)', () => {
      // 已经 200 + 吐出内容之后才报的 error 绝大多数是通道抖动;策略与 OpenAI parser 单源一致。
      expect(sep.shouldPreservePartial({ error: genericErr(), hasContent: true }, ON)).toBe(true);
  });

  test('无 content → 不保全(无可保全,交回 reject 让上游分类)', () => {
      expect(sep.shouldPreservePartial({ error: econnreset(), hasContent: false }, ON)).toBe(false);
      expect(sep.shouldPreservePartial({ error: genericErr(), hasContent: false }, ON)).toBe(false);
  });

  test('用户/stall 主动中止(AbortError)→ 不保全(意图优先)', () => {
      expect(sep.shouldPreservePartial({ error: aborterr(), hasContent: true }, ON)).toBe(false);
  });

  test('显式 aborted:true 旗标 → 不保全', () => {
      expect(sep.shouldPreservePartial({ error: econnreset(), hasContent: true, aborted: true }, ON)).toBe(false);
  });

  test('门控关 → 一律 false(逐字节回退 reject)', () => {
      expect(sep.shouldPreservePartial({ error: econnreset(), hasContent: true }, OFF)).toBe(false);
      expect(sep.shouldPreservePartial({ error: genericErr(), hasContent: true }, OFF)).toBe(false);
  });

  test('isUserAbort: AbortError name / 文案 / aborted 旗标命中', () => {
      expect(sep.isUserAbort({ error: aborterr() })).toBe(true);
      expect(sep.isUserAbort({ error: new Error('aborted by the user') })).toBe(true);
      expect(sep.isUserAbort({ aborted: true })).toBe(true);
      expect(sep.isUserAbort({ error: econnreset() })).toBe(false);
      expect(sep.isUserAbort({})).toBe(false);
      expect(sep.isUserAbort()).toBe(false);
  });

  test('防呆:空 opts / 无 content 不抛且不保全', () => {
      expect(sep.shouldPreservePartial({}, ON)).toBe(false);
      expect(sep.shouldPreservePartial(undefined, ON)).toBe(false);
  });

  test('hasContent 但 error 缺失 → 视为非中止保全(实践中 handler 恒传入 err;防呆不误吞已吐文本)', () => {
      expect(sep.shouldPreservePartial({ hasContent: true }, ON)).toBe(true);
  });

});
