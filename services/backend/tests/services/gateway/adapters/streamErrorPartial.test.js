'use strict';

// Unit tests for streamErrorPartial pure leaf — decides whether a socket-level
// stream error that fires AFTER partial content was emitted should preserve
// that partial (→ length continuation path) instead of reject-and-discard.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const sep = require('../../../../src/services/gateway/adapters/streamErrorPartial');

const ON = {}; // 默认开
const OFF = { KHY_STREAM_ERROR_PRESERVE: '0' };

const econnreset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
const sockethang = () => new Error('socket hang up');
const aborterr = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
const genericErr = () => new Error('boom');

// ── 门控梯 ──────────────────────────────────────────────────────────────────
test('isEnabled: 默认开', () => {
  assert.equal(sep.isEnabled(ON), true);
  assert.equal(sep.isEnabled(undefined), true);
});

test('isEnabled: 0/false/off/no → 关(大小写/空白不敏感)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(sep.isEnabled({ KHY_STREAM_ERROR_PRESERVE: v }), false, `value ${v}`);
  }
});

// ── shouldPreservePartial ───────────────────────────────────────────────────
test('瞬时 socket 断 + 已吐 content → 保全(true)', () => {
  assert.equal(sep.shouldPreservePartial({ error: econnreset(), hasContent: true }, ON), true);
  assert.equal(sep.shouldPreservePartial({ error: sockethang(), hasContent: true }, ON), true);
});

test('非瞬时但非中止的普通 error + 已吐 content → 仍保全(对齐 OpenAI 路径:非中止+有进度)', () => {
  // 已经 200 + 吐出内容之后才报的 error 绝大多数是通道抖动;策略与 OpenAI parser 单源一致。
  assert.equal(sep.shouldPreservePartial({ error: genericErr(), hasContent: true }, ON), true);
});

test('无 content → 不保全(无可保全,交回 reject 让上游分类)', () => {
  assert.equal(sep.shouldPreservePartial({ error: econnreset(), hasContent: false }, ON), false);
  assert.equal(sep.shouldPreservePartial({ error: genericErr(), hasContent: false }, ON), false);
});

test('用户/stall 主动中止(AbortError)→ 不保全(意图优先)', () => {
  assert.equal(sep.shouldPreservePartial({ error: aborterr(), hasContent: true }, ON), false);
});

test('显式 aborted:true 旗标 → 不保全', () => {
  assert.equal(sep.shouldPreservePartial({ error: econnreset(), hasContent: true, aborted: true }, ON), false);
});

test('门控关 → 一律 false(逐字节回退 reject)', () => {
  assert.equal(sep.shouldPreservePartial({ error: econnreset(), hasContent: true }, OFF), false);
  assert.equal(sep.shouldPreservePartial({ error: genericErr(), hasContent: true }, OFF), false);
});

// ── isUserAbort 防呆 ─────────────────────────────────────────────────────────
test('isUserAbort: AbortError name / 文案 / aborted 旗标命中', () => {
  assert.equal(sep.isUserAbort({ error: aborterr() }), true);
  assert.equal(sep.isUserAbort({ error: new Error('aborted by the user') }), true);
  assert.equal(sep.isUserAbort({ aborted: true }), true);
  assert.equal(sep.isUserAbort({ error: econnreset() }), false);
  assert.equal(sep.isUserAbort({}), false);
  assert.equal(sep.isUserAbort(), false);
});

test('防呆:空 opts / 无 content 不抛且不保全', () => {
  assert.equal(sep.shouldPreservePartial({}, ON), false);
  assert.equal(sep.shouldPreservePartial(undefined, ON), false);
});

test('hasContent 但 error 缺失 → 视为非中止保全(实践中 handler 恒传入 err;防呆不误吞已吐文本)', () => {
  assert.equal(sep.shouldPreservePartial({ hasContent: true }, ON), true);
});
