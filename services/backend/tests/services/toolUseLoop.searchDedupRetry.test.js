'use strict';

/**
 * toolUseLoop.searchDedupRetry.test.js — task #7 regression locks for the
 * search-dedup tightening. Daniel's影响面 review flagged that capping identical
 * search repeats at 1 / blocking a search intent on its 2nd sighting would also
 * kill legitimate paging and failure retries. These three cases pin the fix so
 * all invariants hold at once, exercised through the real runToolUseLoop dedup:
 *   1. Pagination is not a repeat: same query text, page 2 still executes.
 *   2. A failed search is retryable: an identical retry after success:false runs.
 *   3. A genuine no-pagination duplicate is still deduped (the original bug).
 *
 * Tests 2 and 3 share an identical chat script (same query twice); ONLY the tool
 * result differs (fail-then-succeed vs always-succeed), isolating the retry
 * exemption from the dedup path.
 */

jest.setTimeout(60000);

const mockExecuteTool = jest.fn();

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

// Required once (not per-test) to avoid paying the hookSystem re-init cost on
// every case; dedup state is local to each runToolUseLoop call, so no leakage.
const toolUseLoop = require('../../src/services/toolUseLoop');

// Serialize a single tool call the way the loop parses it out of a reply.
const TC = (name, params) => `<tool_call>${JSON.stringify({ name, params })}</tool_call>`;
// Substantive, non-placeholder final reply so the loop concludes cleanly.
const DONE = '这是最终答复：已经完整说明了检索到的结果并给出了结论，无需再进行检索。';

const OK = { success: true, results: [{ title: 'r1' }], output: 'web ok' };

// The loop canonicalizes web_search → webSearch before calling executeTool, so
// match either spelling; ignore internal auto-verify (read_file) / system tools.
function webSearchExecCount() {
  return mockExecuteTool.mock.calls.filter((c) => /web.?search/i.test(String(c[0]))).length;
}

describe('toolUseLoop — search dedup / retry (task #7 regression)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, KHY_TASK_CAPABILITY_GATE: 'false' };
    mockExecuteTool.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  test('same query, page 1 then page 2 → page 2 still executes (paging not deduped)', async () => {
    mockExecuteTool.mockImplementation(async () => OK);
    const chat = jest.fn()
      .mockResolvedValueOnce({ reply: TC('web_search', { query: '曲靖天气', page: 1 }), provider: 'mock' })
      .mockResolvedValueOnce({ reply: TC('web_search', { query: '曲靖天气', page: 2 }), provider: 'mock' })
      .mockResolvedValue({ reply: DONE, stopReason: 'stop', provider: 'mock' });

    await toolUseLoop.runToolUseLoop('查一下曲靖天气', { chat, maxIterations: 6 });
    expect(webSearchExecCount()).toBe(2);
  });

  test('failed search is retryable: identical retry after success:false runs again', async () => {
    let n = 0;
    mockExecuteTool.mockImplementation(async () => {
      n += 1;
      return n === 1 ? { success: false, error: 'transient' } : OK;
    });
    const chat = jest.fn()
      .mockResolvedValueOnce({ reply: TC('web_search', { query: '曲靖天气' }), provider: 'mock' })
      .mockResolvedValueOnce({ reply: TC('web_search', { query: '曲靖天气' }), provider: 'mock' })
      .mockResolvedValue({ reply: DONE, stopReason: 'stop', provider: 'mock' });

    await toolUseLoop.runToolUseLoop('查一下曲靖天气', { chat, maxIterations: 6 });
    expect(webSearchExecCount()).toBe(2);
  });

  test('no-pagination identical duplicate is still deduped (original bug stays fixed)', async () => {
    mockExecuteTool.mockImplementation(async () => OK);
    const chat = jest.fn()
      .mockResolvedValueOnce({ reply: TC('web_search', { query: '曲靖天气' }), provider: 'mock' })
      .mockResolvedValueOnce({ reply: TC('web_search', { query: '曲靖天气' }), provider: 'mock' })
      .mockResolvedValue({ reply: DONE, stopReason: 'stop', provider: 'mock' });

    await toolUseLoop.runToolUseLoop('查一下曲靖天气', { chat, maxIterations: 6 });
    expect(webSearchExecCount()).toBe(1);
  });
});
