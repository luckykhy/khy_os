'use strict';

/**
 * queryEngine.toolLoopFeatures.test.js — Phase 3 Step 0 feature locks.
 *
 * Companion to queryEngine.toolLoopParity.test.js. Where the parity test asserts
 * the two engines agree, these tests pin individual invariants that the
 * convergence must preserve, each isolated so a regression points at one
 * behavior:
 *   1. Truncation recovery fires for BOTH 'length' and 'max_tokens' stop reasons.
 *   2. tool_call and tool_result events pair up (same tool name, in order).
 *   3. A no-tool reply triggers at most one nudge (no infinite re-prompting).
 *   4. queryEngine's event stream ends in exactly one terminal 'done'.
 *   5. control_request round-trips host decision back into the loop.
 */

const mockExecuteTool = jest.fn(async (name) => {
  if (name === 'web_search') {
    return { success: true, results: [{ title: 'r1' }], output: 'web ok' };
  }
  return { success: false, error: 'unexpected tool' };
});

jest.mock('../../src/services/toolCalling', () => ({
  executeTool: mockExecuteTool,
  clearPreflightContext: jest.fn(),
}));
jest.mock('../../src/services/inputPreprocessor', () => ({
  preprocess: jest.fn((text) => ({ processed: text })),
}));
jest.mock('../../src/services/securityGuardService', () => ({
  analyzeInput: jest.fn(() => ({ safe: true })),
}));

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('Phase 3 — feature locks (toolUseLoop authoritative behavior)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, KHY_TASK_CAPABILITY_GATE: 'false' };
    mockExecuteTool.mockClear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  // ── 1. Truncation recovery consistency ──────────────────────────────────────
  // Final reply is deliberately substantive so the no-tool nudge does not fire;
  // this keeps the test focused on truncation merge, not nudge interaction.
  test.each(['length', 'max_tokens'])(
    'recovers a truncated reply when provider returns stopReason=%s',
    async (stopReason) => {
      const toolUseLoop = require('../../src/services/toolUseLoop');
      const chat = jest.fn()
        .mockResolvedValueOnce({ reply: '第一段：模型会先构建上下文。', stopReason, provider: 'mock' })
        .mockResolvedValueOnce({
          reply: '第二段：然后基于概率分布逐步生成后续内容，至此已完整阐述清楚。',
          stopReason: 'stop',
          provider: 'mock',
        });

      const result = await toolUseLoop.runToolUseLoop('解释一下大模型思考原理', { chat, maxIterations: 4 });

      // Recovery re-invokes chat exactly once to continue; both fragments must
      // land in the merged final reply, regardless of stop-reason spelling.
      expect(chat).toHaveBeenCalledTimes(2);
      expect(result.finalResponse).toContain('第一段');
      expect(result.finalResponse).toContain('第二段');
    },
  );

  // ── 2. tool_call / tool_result pairing ──────────────────────────────────────
  test('each executed tool produces a matching result entry with the same name', async () => {
    const toolUseLoop = require('../../src/services/toolUseLoop');
    const calls = [];
    const results = [];
    const chat = jest.fn()
      .mockResolvedValueOnce({
        reply: '<tool_call>{"name":"web_search","params":{"query":"x"}}</tool_call>',
        provider: 'mock',
      })
      .mockResolvedValueOnce({ reply: '完成。', stopReason: 'stop', provider: 'mock' });

    const result = await toolUseLoop.runToolUseLoop('搜一下', {
      chat,
      maxIterations: 4,
      onToolCall: (name) => { calls.push(name); },
      onToolResult: (name) => { if (!String(name).startsWith('_system_')) results.push(name); },
    });

    // The loop canonicalizes snake_case tool names to camelCase (web_search →
    // webSearch); call, result, and log must all agree on that canonical name.
    expect(calls).toEqual(['webSearch']);
    expect(results).toEqual(['webSearch']);
    const logged = (result.toolCallLog || []).map((e) => e && e.tool).filter(Boolean);
    expect(logged).toEqual(['webSearch']);
  });

  // ── 3. Nudge is one-shot ────────────────────────────────────────────────────
  test('a no-tool reply does not loop forever (chat called a bounded number of times)', async () => {
    const toolUseLoop = require('../../src/services/toolUseLoop');
    const chat = jest.fn().mockResolvedValue({ reply: '这是直接答复，没有工具调用。', stopReason: 'stop', provider: 'mock' });

    const result = await toolUseLoop.runToolUseLoop('随便聊聊', { chat, maxIterations: 6 });

    // Without a tool call the loop must settle quickly: at most the nudge retry,
    // never the full maxIterations.
    expect(chat.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.finalResponse).toContain('直接答复');
  });

  // ── 4. Terminal 'done' contract (queryEngine stream) ────────────────────────
  test('queryEngine legacy stream ends in exactly one done event with a reply field', async () => {
    jest.resetModules();
    process.env.KHY_QUERY_ENGINE_V2 = 'false';
    process.env.KHY_QUERY_ENGINE_HARNESS = 'false';

    jest.doMock('../../src/cli/ai', () => ({
      chat: jest.fn(async (_m, opts = {}) => {
        if (typeof opts.onChunk === 'function') opts.onChunk({ type: 'text', text: '答复完毕。' });
        return { reply: '答复完毕。', stopReason: 'stop', provider: 'mock' };
      }),
      getEffort: jest.fn(() => 'medium'),
    }));

    const ai = require('../../src/cli/ai');
    require('../../src/services/aiChatPort').registerAiChat(ai.chat);
    require('../../src/services/aiConversationPort').registerAiConversation({ getEffort: ai.getEffort });
    const { QueryEngine } = require('../../src/services/queryEngine');
    const events = await collect(new QueryEngine().submitMessage('你好', { useHarness: false }));

    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].data).toHaveProperty('reply');
    expect(events[events.length - 1].type).toBe('done');
  });

  // ── 5. control_request round-trip ───────────────────────────────────────────
  test('queryEngine forwards control_request to host and surfaces it on the stream', async () => {
    jest.resetModules();
    process.env.KHY_QUERY_ENGINE_V2 = 'false';
    process.env.KHY_QUERY_ENGINE_HARNESS = 'false';

    jest.doMock('../../src/cli/ai', () => ({
      chat: jest.fn(async (_m, opts = {}) => {
        const payload = { requestId: 'req-9', request: { subtype: 'can_use_tool', tool_name: 'Bash' } };
        if (typeof opts.onControlRequest === 'function') opts.onControlRequest(payload);
        if (typeof opts.onChunk === 'function') {
          opts.onChunk({ type: 'control_request', ...payload });
          opts.onChunk({ type: 'text', text: '已处理。' });
        }
        return { reply: '已处理。', stopReason: 'stop', provider: 'mock' };
      }),
      getEffort: jest.fn(() => 'medium'),
    }));

    const hostDecision = jest.fn(() => ({ decision: 'allow' }));
    const ai = require('../../src/cli/ai');
    require('../../src/services/aiChatPort').registerAiChat(ai.chat);
    require('../../src/services/aiConversationPort').registerAiConversation({ getEffort: ai.getEffort });
    const { QueryEngine } = require('../../src/services/queryEngine');
    const events = await collect(new QueryEngine().submitMessage('删除文件', {
      useHarness: false,
      onControlRequest: hostDecision,
    }));

    expect(hostDecision).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-9' }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'control_request', data: expect.objectContaining({ requestId: 'req-9' }) }),
      expect.objectContaining({ type: 'done', data: expect.objectContaining({ reply: '已处理。' }) }),
    ]));
  });

  // ── 6. onCost / onThinking projections (Step 1) ─────────────────────────────
  test('runToolUseLoop projects token usage via onCost and progress via onThinking', async () => {
    const toolUseLoop = require('../../src/services/toolUseLoop');
    const costs = [];
    const thoughts = [];
    const chat = jest.fn().mockResolvedValue({
      reply: '这是直接答复。',
      stopReason: 'stop',
      provider: 'mock',
      tokenUsage: { totalTokens: 42 },
    });

    await toolUseLoop.runToolUseLoop('随便聊聊', {
      chat,
      maxIterations: 3,
      onCost: (usage) => { costs.push(usage); },
      onThinking: (text) => { thoughts.push(text); },
    });

    expect(costs).toContainEqual({ totalTokens: 42 });
    expect(thoughts.length).toBeGreaterThanOrEqual(1);
    expect(thoughts[0]).toMatch(/round 1\//);
  });
});
