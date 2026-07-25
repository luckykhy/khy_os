'use strict';

/**
 * queryEngine.toolLoopParity.test.js — Phase 3 Step 0 guard net.
 *
 * Purpose: lock the BEHAVIORAL CONTRACT shared by the two agent engines so the
 * upcoming convergence (queryEngine → thin generator adapter over toolUseLoop)
 * cannot silently drift. Both engines are driven with one identical scripted
 * chat scenario (tool_use → truncation(length) → final text), their outputs are
 * normalized to a common trace, and the trace is asserted equal.
 *
 * We deliberately compare the OBSERVABLE contract that repl.js consumes
 * (ordered tool names, final reply substrings, completion signal, tool/result
 * pairing) rather than incidental internals (iteration counts, thinking copy,
 * per-engine escalation phases) which legitimately differ today and are not part
 * of the consumer contract.
 *
 * This file must stay green across every Phase 3 step. Step 2 adds the adapter;
 * Step 3/4 route legacy/V2 through it — at which point both arms of the parity
 * driver exercise the same underlying loop.
 */

// ── Shared tool executor (both engines call toolCalling.executeTool) ──────────
// Declared with a `mock`-prefixed name so jest.mock's hoisted factory may close
// over it (jest forbids non-`mock` out-of-scope refs in mock factories).
const mockExecuteTool = jest.fn(async (name) => {
  if (name === 'web_search') {
    return { success: true, results: [{ title: '热点1' }, { title: '热点2' }], output: 'web ok' };
  }
  return { success: false, error: 'unexpected tool' };
});

jest.mock('../../src/services/toolCalling', () => ({
  executeTool: mockExecuteTool,
  clearPreflightContext: jest.fn(),
}));

// inputPreprocessor / securityGuard kept inert so the message is not mutated.
jest.mock('../../src/services/inputPreprocessor', () => ({
  preprocess: jest.fn((text) => ({ processed: text })),
}));
jest.mock('../../src/services/securityGuardService', () => ({
  analyzeInput: jest.fn(() => ({ safe: true })),
}));

const FINAL_MARKER = '__FINAL_REPLY_MARKER__';
const TRUNC_HEAD = '第一段：构建上下文。';
const TRUNC_TAIL = '第二段：继续生成后续内容。';

/**
 * The canonical 3-turn scenario, identical for both engines:
 *   turn 1: emit a web_search tool call
 *   turn 2: emit a truncated reply (stopReason=length)
 *   turn 3: emit the final clean reply
 *
 * Returns a fresh chat function each call so the two arms do not share counters.
 */
function makeScriptedChat() {
  let turn = 0;
  return jest.fn(async (_message, chatOptions = {}) => {
    turn += 1;
    if (turn === 1) {
      return {
        reply: '<tool_call>{"name":"web_search","params":{"query":"今天的热点新闻"}}</tool_call>',
        provider: 'mock',
        tokenUsage: { totalTokens: 10 },
      };
    }
    if (turn === 2) {
      // Truncated turn. Stream the partial text so streaming consumers see it too.
      if (typeof chatOptions.onChunk === 'function') {
        chatOptions.onChunk({ type: 'text', text: TRUNC_HEAD });
      }
      return {
        reply: TRUNC_HEAD,
        stopReason: 'length',
        provider: 'mock',
        tokenUsage: { totalTokens: 12 },
      };
    }
    // turn >= 3: final clean reply
    if (typeof chatOptions.onChunk === 'function') {
      chatOptions.onChunk({ type: 'text', text: `${TRUNC_TAIL}${FINAL_MARKER}` });
    }
    return {
      reply: `${TRUNC_TAIL}${FINAL_MARKER}`,
      stopReason: 'stop',
      provider: 'mock',
      tokenUsage: { totalTokens: 20 },
    };
  });
}

/**
 * Normalize a run into the consumer-facing contract trace.
 * @param {object} input
 * @param {string[]} input.toolNames - ordered tool names that were executed
 * @param {string} input.finalReply - the engine's final reply text
 * @returns {{ tools: string[], replyHasHead: boolean, replyHasTail: boolean, replyHasMarker: boolean }}
 */
function normalize({ toolNames, finalReply }) {
  const reply = String(finalReply || '');
  return {
    // Canonicalize tool names: the authoritative loop normalizes snake_case →
    // camelCase (web_search → webSearch); collapse both forms so the two engines
    // compare on identity, not surface spelling.
    tools: toolNames
      .filter((n) => n && !String(n).startsWith('_system_'))
      .map((n) => String(n).toLowerCase().replace(/[^a-z0-9]/g, '')),
    replyHasHead: reply.includes(TRUNC_HEAD),
    replyHasTail: reply.includes(TRUNC_TAIL),
    replyHasMarker: reply.includes(FINAL_MARKER),
  };
}

/** Drive runToolUseLoop, collecting the contract via callbacks + return value. */
async function driveToolUseLoop() {
  const toolUseLoop = require('../../src/services/toolUseLoop');
  const toolNames = [];
  const chat = makeScriptedChat();
  const result = await toolUseLoop.runToolUseLoop('搜一下今天的热点新闻', {
    chat,
    maxIterations: 6,
    onToolCall: (name) => { toolNames.push(name); },
  });
  return normalize({ toolNames, finalReply: result.finalResponse });
}

/** Drive queryEngine.submitMessage, collecting the contract from yielded events. */
async function driveQueryEngine() {
  const ai = require('../../src/cli/ai');
  const chat = makeScriptedChat();
  ai.chat.mockImplementation((message, options) => chat(message, options));
  ai.getEffort.mockReturnValue('medium');
  require('../../src/services/aiChatPort').registerAiChat(ai.chat);
  require('../../src/services/aiConversationPort').registerAiConversation({ getEffort: ai.getEffort });

  const { QueryEngine } = require('../../src/services/queryEngine');
  const engine = new QueryEngine();

  const toolNames = [];
  let finalReply = '';
  for await (const event of engine.submitMessage('搜一下今天的热点新闻', { useHarness: false })) {
    if (event.type === 'tool_call') toolNames.push(event.data?.name);
    if (event.type === 'done') finalReply = event.data?.reply || finalReply;
  }
  return normalize({ toolNames, finalReply });
}

/**
 * Drive the new generator adapter (_submitMessageViaToolLoop) DIRECTLY, before
 * it is wired into submitMessage (Step 2). Proves the adapter satisfies the same
 * contract in isolation.
 */
async function driveAdapter() {
  const ai = require('../../src/cli/ai');
  const chat = makeScriptedChat();
  ai.chat.mockImplementation((message, options) => chat(message, options));
  ai.getEffort.mockReturnValue('medium');
  require('../../src/services/aiChatPort').registerAiChat(ai.chat);
  require('../../src/services/aiConversationPort').registerAiConversation({ getEffort: ai.getEffort });

  const { QueryEngine } = require('../../src/services/queryEngine');
  const engine = new QueryEngine();
  // Seed history as submitMessage would (adapter slices off the last user msg).
  engine._messages.push({ role: 'user', content: '搜一下今天的热点新闻' });

  const toolNames = [];
  let finalReply = '';
  const stream = engine._submitMessageViaToolLoop({
    userMessage: '搜一下今天的热点新闻',
    processedMessage: '搜一下今天的热点新闻',
    options: {},
  });
  for await (const event of stream) {
    if (event.type === 'tool_call') toolNames.push(event.data?.name);
    if (event.type === 'done') finalReply = event.data?.reply || finalReply;
  }
  return normalize({ toolNames, finalReply });
}

describe('Phase 3 — dual-engine behavioral parity', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      KHY_TASK_CAPABILITY_GATE: 'false',
      KHY_QUERY_ENGINE_V2: 'false',
      KHY_QUERY_ENGINE_HARNESS: 'false',
    };
    mockExecuteTool.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  test('both engines execute web_search and produce a complete (de-truncated) final reply', async () => {
    jest.doMock('../../src/cli/ai', () => ({
      chat: jest.fn(),
      getEffort: jest.fn(() => 'medium'),
    }));

    const loopTrace = await driveToolUseLoop();
    const engineTrace = await driveQueryEngine();

    // Each engine independently satisfies the contract...
    expect(loopTrace.tools).toEqual(['websearch']);
    expect(loopTrace.replyHasTail).toBe(true);
    expect(loopTrace.replyHasMarker).toBe(true);

    expect(engineTrace.tools).toEqual(['websearch']);
    expect(engineTrace.replyHasTail).toBe(true);
    expect(engineTrace.replyHasMarker).toBe(true);

    // ...and the normalized contract traces match each other.
    expect(engineTrace).toEqual(loopTrace);
  });

  test('the (unwired) toolUseLoop adapter matches the authoritative loop contract', async () => {
    jest.doMock('../../src/cli/ai', () => ({
      chat: jest.fn(),
      getEffort: jest.fn(() => 'medium'),
    }));

    const loopTrace = await driveToolUseLoop();
    const adapterTrace = await driveAdapter();

    expect(adapterTrace.tools).toEqual(['websearch']);
    expect(adapterTrace.replyHasTail).toBe(true);
    expect(adapterTrace.replyHasMarker).toBe(true);
    expect(adapterTrace).toEqual(loopTrace);
  });
});
