'use strict';

/**
 * replyGuard — 空回复守卫单元测试。
 *
 * 验证 Goal「空回复主动丢弃,并要求 ai 重发新消息」的判定真源:
 *  - isEmptyReply:裸空 / whitespace-only / 诊断占位空(errorType:'empty_reply' 非空 reply)→ true;
 *    已兜底(salvaged) / NON_RESUMABLE(content_filter/refusal) / 正常非空回复 → false。
 *  - shouldDiscardAndRerequest:门控开+空+可恢复+未超预算 → true;门控关/aborted/NON_RESUMABLE/
 *    预算耗尽 → false。
 *  - 重发指令 / 状态文案确定性, 含「丢弃 / 重发 / 完整」语义, 无随机。
 *  - 绝不抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isReplyGuardEnabled,
  isEmptyReply,
  shouldDiscardAndRerequest,
  buildResendDirective,
  buildRetryStatusLabel,
  EMPTY_ERROR_TYPES,
} = require('../src/services/replyGuard');

const ON = { KHY_REPLY_GUARD: '1' };
const OFF = { KHY_REPLY_GUARD: 'off' };

describe('isReplyGuardEnabled — 默认开, 仅显式 falsy 关', () => {
  test('无 env / 空 → 开', () => {
    assert.equal(isReplyGuardEnabled({}), true);
    assert.equal(isReplyGuardEnabled({ KHY_REPLY_GUARD: '' }), true);
  });
  test('显式 falsy → 关', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      assert.equal(isReplyGuardEnabled({ KHY_REPLY_GUARD: v }), false, v);
    }
  });
});

describe('isEmptyReply — 空回复判定真源', () => {
  test('无结果 → true(裸空)', () => {
    assert.equal(isEmptyReply(null), true);
    assert.equal(isEmptyReply(undefined), true);
  });
  test('reply 空 / 仅空白 → true', () => {
    assert.equal(isEmptyReply({ reply: '' }), true);
    assert.equal(isEmptyReply({ reply: '   \n\t ' }), true);
  });
  test('诊断占位空(非空 reply + errorType:empty_reply)→ true(漏路本体)', () => {
    assert.equal(isEmptyReply({ reply: '抱歉，AI 未能生成有效回复。', errorType: 'empty_reply' }), true);
    assert.equal(isEmptyReply({ reply: 'AI 未返回有效回复 — 请重试或检查连接', errorType: 'empty_response' }), true);
    assert.equal(isEmptyReply({ reply: 'x', errorType: 'empty' }), true);
  });
  test('已兜底(salvaged)→ false(真回答, 绝不丢弃)', () => {
    assert.equal(isEmptyReply({ reply: '', salvaged: true }), false);
    assert.equal(isEmptyReply({ reply: '已检索到的数据…', errorType: 'empty_reply_salvaged' }), false);
  });
  test('NON_RESUMABLE(内容安全/拒答)→ false, 即便 reply 空', () => {
    assert.equal(isEmptyReply({ reply: '', errorType: 'content_filter' }), false);
    assert.equal(isEmptyReply({ reply: '', errorType: 'refusal' }), false);
    assert.equal(isEmptyReply({ reply: '', errorType: 'permission' }), false);
  });
  test('正常非空回复 → false', () => {
    assert.equal(isEmptyReply({ reply: '这是一个正常的完整答案。' }), false);
    assert.equal(isEmptyReply({ reply: '正常答案', errorType: 'timeout' }), false);
  });
  test('EMPTY_ERROR_TYPES 不含 salvaged / content_filter', () => {
    assert.equal(EMPTY_ERROR_TYPES.has('empty_reply'), true);
    assert.equal(EMPTY_ERROR_TYPES.has('empty_reply_salvaged'), false);
    assert.equal(EMPTY_ERROR_TYPES.has('content_filter'), false);
  });
});

describe('shouldDiscardAndRerequest — 丢弃重发裁决', () => {
  const empty = { reply: '抱歉，AI 未能生成有效回复。', errorType: 'empty_reply' };

  test('门控开 + 空 + 可恢复 + 未超预算 → true', () => {
    assert.equal(shouldDiscardAndRerequest({ aiResult: empty, attemptsUsed: 0, maxAttempts: 2, env: ON }), true);
  });
  test('门控关 → false(字节回退)', () => {
    assert.equal(shouldDiscardAndRerequest({ aiResult: empty, attemptsUsed: 0, maxAttempts: 2, env: OFF }), false);
  });
  test('aborted → false', () => {
    assert.equal(shouldDiscardAndRerequest({ aiResult: empty, attemptsUsed: 0, maxAttempts: 2, aborted: true, env: ON }), false);
  });
  test('NON_RESUMABLE(content_filter)→ false, 即便门控开', () => {
    assert.equal(shouldDiscardAndRerequest({ aiResult: { reply: '', errorType: 'content_filter' }, attemptsUsed: 0, maxAttempts: 2, env: ON }), false);
  });
  test('预算耗尽 → false(落回终端报真因)', () => {
    assert.equal(shouldDiscardAndRerequest({ aiResult: empty, attemptsUsed: 2, maxAttempts: 2, env: ON }), false);
    assert.equal(shouldDiscardAndRerequest({ aiResult: empty, attemptsUsed: 3, maxAttempts: 2, env: ON }), false);
  });
  test('正常非空回复 → false(绝不误杀)', () => {
    assert.equal(shouldDiscardAndRerequest({ aiResult: { reply: '正常答案' }, attemptsUsed: 0, maxAttempts: 2, env: ON }), false);
  });
});

describe('buildResendDirective / buildRetryStatusLabel — 确定性文案', () => {
  test('重发指令含「丢弃 / 完整 / 空白」语义, 确定性', () => {
    const a = buildResendDirective({ attempt: 1, maxAttempts: 2 });
    const b = buildResendDirective({ attempt: 1, maxAttempts: 2 });
    assert.equal(a, b, '确定性: 同输入恒等');
    assert.ok(/丢弃/.test(a) && /完整/.test(a) && /空白/.test(a), a);
  });
  test('状态文案含「空回复已丢弃 / 重新生成」+ n/max', () => {
    const s = buildRetryStatusLabel({ attempt: 1, maxAttempts: 2 });
    assert.ok(/空回复已丢弃/.test(s) && /重新生成/.test(s), s);
    assert.ok(/1\/2/.test(s), s);
  });
  test('缺 attempt/max → 不带计数但仍有效', () => {
    const s = buildRetryStatusLabel({});
    assert.ok(/空回复已丢弃/.test(s), s);
    assert.ok(!/\//.test(s), s);
  });
});

describe('绝不抛 — fail-soft', () => {
  test('异常 / 缺参输入全部 doesNotThrow', () => {
    assert.doesNotThrow(() => isEmptyReply(undefined));
    assert.doesNotThrow(() => shouldDiscardAndRerequest());
    assert.doesNotThrow(() => shouldDiscardAndRerequest({}));
    assert.doesNotThrow(() => buildResendDirective());
    assert.doesNotThrow(() => buildRetryStatusLabel());
    assert.doesNotThrow(() => isReplyGuardEnabled(null));
  });
});
