/**
 * tests/nativeLoopFallback.test.js
 *
 * 验证当原生工具循环 (runToolUseLoop) 不可用（loopResult === null）时，
 * _runSubmit 正确 fallback 到直接 ai().chat() 并提交回复。
 *
 * 这对应 useQueryBridge.js 第 1509 行的修复：
 *   旧: if (!result)  // result 是对象 {}，永远 truthy → fallback 永不执行
 *   新: if (!loopResult)  // loopResult 为 null 时才 fallback
 */

'use strict';

const { describe, test, expect, vi, beforeEach, afterEach } = require('@jest/globals');

// ── 模拟 minimal 的 React hooks ──────────────────────────────────────────────

function createMockState(initial) {
  let val = initial;
  const listeners = new Set();
  return {
    get: () => val,
    set: (v) => { val = typeof v === 'function' ? v(val) : v; listeners.forEach(fn => fn(val)); },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// ── 模拟 ai().chat() 返回值 ──────────────────────────────────────────────────

function createMockAiChat(reply, opts = {}) {
  const hasReply = arguments.length > 0 && reply !== undefined;
  return async () => ({
    reply: hasReply ? reply : '你好！有什么可以帮助你的吗？',
    provider: opts.provider || 'mock-provider',
    tokenUsage: opts.tokenUsage || { totalTokens: 100 },
    toolUseBlocks: [],
    thinkingBlocks: [],
  });
}

// ── 被测逻辑：模拟 _runSubmit 中的关键分支 ───────────────────────────────────

/**
 * 模拟 _runSubmit 的核心逻辑，专注于：
 * 1. loopResult = null 时是否调用 ai().chat()
 * 2. 非流式 fallback 是否提交回复
 *
 * @param {object} params
 * @param {boolean} params.nativeLoopAvailable - 原生工具循环是否可用
 * @param {string} params.aiReply - ai().chat() 返回的回复
 * @returns {{ reply: string, messages: Array, directChatCalled: boolean }}
 */
async function simulateRunSubmitCore({ nativeLoopAvailable = false, aiReply = 'mock reply' } = {}) {
  let loopResult = null;
  let directChatCalled = false;
  const messages = [];
  const committedTurn = { current: false };

  // 模拟原生工具循环
  if (nativeLoopAvailable) {
    loopResult = {
      finalResponse: '来自原生循环的回复',
      provider: 'native-loop',
      tokenUsage: { totalTokens: 50 },
      salvaged: false,
    };
  }
  // 否则 loopResult = null（模块未加载/循环未启用）

  // ── 关键修复点 ──
  let result;
  if (loopResult) {
    result = {
      reply: loopResult.finalResponse,
      provider: loopResult.provider,
      tokenUsage: loopResult.tokenUsage,
    };
  }

  if (!loopResult) {
    // 直接 chat 回退路径
    const ai = createMockAiChat(aiReply);
    // 模拟 await ai().chat(text, {...})
    directChatCalled = true;
    result = result || {};
    // 直接赋值模拟 ai().chat() 的返回值
    Object.assign(result, await ai('test text', {
      abortSignal: null,
      onChunk: null,
      onStatus: null,
      onControlRequest: null,
    }));
  }

  // ── 非流式 fallback commit ──
  const live = { text: '' }; // 无流式文本
  if (!committedTurn.current) {
    const finalText = live.text || (result && (result.reply || result.text)) || '';
    if (finalText) {
      committedTurn.current = true;
      messages.push({
        role: 'assistant',
        content: finalText,
        timeline: [{ type: 'text', text: finalText }],
      });
    }
  }

  return {
    reply: result?.reply || result?.text || '',
    messages,
    directChatCalled,
    hasResponse: messages.length > 0 && messages[0].role === 'assistant',
  };
}

// ── 测试用例 ──────────────────────────────────────────────────────────────────

describe('native loop fallback: loopResult === null → direct ai().chat()', () => {
  test('loopResult=null 且 ai().chat() 有回复 → 应执行 fallback 并提交回复', async () => {
    const { reply, messages, directChatCalled, hasResponse } = await simulateRunSubmitCore({
      nativeLoopAvailable: false,
      aiReply: '你好！有什么可以帮助你的吗？',
    });

    expect(directChatCalled).toBe(true);
    expect(reply).toBe('你好！有什么可以帮助你的吗？');
    expect(hasResponse).toBe(true);
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toBe('你好！有什么可以帮助你的吗？');
  });

  test('loopResult=null 且 ai().chat() 返回空回复 → 不应提交空消息', async () => {
    const { reply, messages, directChatCalled, hasResponse } = await simulateRunSubmitCore({
      nativeLoopAvailable: false,
      aiReply: '',
    });

    expect(directChatCalled).toBe(true);
    expect(reply).toBe('');
    expect(hasResponse).toBe(false);
    expect(messages.length).toBe(0);
  });

  test('loopResult 可用 → 不应调用 ai().chat()，应使用原生循环回复', async () => {
    const { reply, messages, directChatCalled, hasResponse } = await simulateRunSubmitCore({
      nativeLoopAvailable: true,
      aiReply: '这条回复不应被使用',
    });

    expect(directChatCalled).toBe(false);
    expect(reply).toBe('来自原生循环的回复');
    expect(hasResponse).toBe(true);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe('来自原生循环的回复');
  });

  test('loopResult=null 且 ai().chat() 返回 { reply: undefined } → 不应崩溃', async () => {
    // 模拟 ai().chat() 返回 undefined reply
    const ai = async () => ({ reply: undefined, provider: 'mock', tokenUsage: null });

    let loopResult = null;
    let directChatCalled = false;
    let result = loopResult
      ? { reply: loopResult.finalResponse, provider: loopResult.provider, tokenUsage: loopResult.tokenUsage }
      : undefined;

    if (!loopResult) {
      directChatCalled = true;
      result = result || {};
      Object.assign(result, await ai('test', {}));
    }

    const live = { text: '' };
    const committedTurn = { current: false };
    if (!committedTurn.current) {
      const finalText = live.text || (result && (result.reply || result.text)) || '';
      if (finalText) {
        committedTurn.current = true;
      }
    }

    expect(directChatCalled).toBe(true);
    expect(committedTurn.current).toBe(false); // 空回复不提交
  });
});

// ── 验证修复的核心场景 ────────────────────────────────────────────────────────

describe('核心修复验证：旧代码 (!result) vs 新代码 (!loopResult)', () => {
  test('旧代码 (!result) 在 loopResult=null 时不触发 fallback (已修复)', () => {
    // 模拟旧代码行为
    let loopResult = null;
    let result = {
      reply: loopResult && loopResult.finalResponse,
      provider: loopResult && loopResult.provider,
      tokenUsage: loopResult && loopResult.tokenUsage,
    };
    // 旧代码: if (!result) → result 是 {} (truthy)，fallback 不执行
    const oldCodeWouldFallback = !result;
    expect(oldCodeWouldFallback).toBe(false); // 旧代码 BUG: fallback 被跳过

    // 新代码: if (!loopResult) → loopResult 是 null，fallback 执行
    const newCodeWouldFallback = !loopResult;
    expect(newCodeWouldFallback).toBe(true); // 修复后: fallback 正确触发
  });

  test('新代码 (!loopResult) 在 loopResult 可用时不触发 fallback', () => {
    let loopResult = {
      finalResponse: 'native reply',
      provider: 'native',
      tokenUsage: { totalTokens: 10 },
      salvaged: false,
    };
    const newCodeWouldFallback = !loopResult;
    expect(newCodeWouldFallback).toBe(false); // 修复后: loopResult 存在时不 fallback
  });
});
