'use strict';

/**
 * chatErrorGuard.test.js — 主循环模型调用防御纵深纯叶子(goal 2026-07-11「包括错误的处理」)。
 *
 * 网关 generate() 契约是返回 success:false 而非抛;意外异常会穿透 `await chat(...)` 杀掉整个
 * 多日 run。本叶子把意外异常归一成「诚实的本轮结束」结果。零 IO、绝不抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../../src/services/chatErrorGuard');

describe('chatErrorGuard.isEnabled — default ON, only explicit falsy disables', () => {
  test('unset → enabled (defense-in-depth default on)', () => {
    assert.equal(guard.isEnabled({}), true);
  });

  test('empty string → enabled', () => {
    assert.equal(guard.isEnabled({ KHY_TOOL_LOOP_CHAT_GUARD: '' }), true);
  });

  test('explicit falsy values → disabled (byte-identical legacy rethrow)', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
      assert.equal(guard.isEnabled({ KHY_TOOL_LOOP_CHAT_GUARD: v }), false, `value ${JSON.stringify(v)}`);
    }
  });

  test('any truthy/other value → enabled', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
      assert.equal(guard.isEnabled({ KHY_TOOL_LOOP_CHAT_GUARD: v }), true, `value ${JSON.stringify(v)}`);
    }
  });

  test('never throws even on hostile env', () => {
    const hostile = { get KHY_TOOL_LOOP_CHAT_GUARD() { throw new Error('boom'); } };
    assert.equal(guard.isEnabled(hostile), true); // conservative = on
  });
});

describe('chatErrorGuard._messageOf — extract message without throwing', () => {
  test('Error instance', () => {
    assert.equal(guard._messageOf(new Error('kaboom')), 'kaboom');
  });
  test('plain string', () => {
    assert.equal(guard._messageOf('oops'), 'oops');
  });
  test('null / undefined → empty', () => {
    assert.equal(guard._messageOf(null), '');
    assert.equal(guard._messageOf(undefined), '');
  });
  test('object without message → stringified, never throws', () => {
    assert.equal(typeof guard._messageOf({ a: 1 }), 'string');
  });
});

describe('chatErrorGuard._classifyKind — stable shape tokens', () => {
  test('timeout family', () => {
    assert.equal(guard._classifyKind('Request ETIMEDOUT after 90s'), 'timeout');
    assert.equal(guard._classifyKind('socket timed out'), 'timeout');
  });
  test('network family', () => {
    assert.equal(guard._classifyKind('read ECONNRESET'), 'network');
    assert.equal(guard._classifyKind('getaddrinfo ENOTFOUND api.example.com'), 'network');
  });
  test('cancelled family', () => {
    assert.equal(guard._classifyKind('The operation was aborted'), 'cancelled');
  });
  test('unknown → unexpected_error', () => {
    assert.equal(guard._classifyKind('Cannot read properties of undefined'), 'unexpected_error');
  });
});

describe('chatErrorGuard.buildUnexpectedChatErrorResult — honest turn-end shape', () => {
  test('carries concrete error message + continue hint + E01', () => {
    const r = guard.buildUnexpectedChatErrorResult(new Error('adapter parse crash'), { iteration: 3 });
    assert.match(r.finalResponse, /意外异常/);
    assert.match(r.finalResponse, /adapter parse crash/);
    assert.match(r.finalResponse, /继续/);
    assert.equal(r.errorCode, 'E01');
    assert.equal(r.errorType, 'unexpected_error');
    assert.equal(r.message, 'adapter parse crash');
    assert.match(r.continueHint, /继续/);
  });

  test('no message → honest "no detail" wording, still safe', () => {
    const r = guard.buildUnexpectedChatErrorResult(null, {});
    assert.match(r.finalResponse, /意外异常/);
    assert.equal(r.errorCode, 'E01');
    assert.equal(r.message, '');
  });

  test('classifies timeout into errorType', () => {
    const r = guard.buildUnexpectedChatErrorResult(new Error('ETIMEDOUT'), {});
    assert.equal(r.errorType, 'timeout');
  });

  test('never throws even when message getter throws', () => {
    const hostile = { get message() { throw new Error('nested'); } };
    const r = guard.buildUnexpectedChatErrorResult(hostile, {});
    assert.match(r.finalResponse, /意外异常/);
    assert.equal(r.errorCode, 'E01');
  });
});
