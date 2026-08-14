'use strict';

/**
 * toolUseLoop.terminalNotice.test.js — 零静默失败缝隙闭合（DESIGN-ARCH-028）。
 *
 * 背景：CLI 在发生流式渲染后只 flush token 流缓冲，不再重渲 finalResponse。
 * 服务端在 finalText 末尾「合成追加」的终端通知（失败摘要 / 交付摘要）从未经过
 * token 流，会被静默丢弃——正是用户遇到的「工具全失败，完成后没有任何反馈」。
 *
 * 修复：runToolUseLoop 单独回传 `terminalNotice`（finalText 中模型散文之外的合成
 * 追加部分），CLI 在流式路径下据此补渲，确保失败说明必达。本测试锁定该回传契约：
 *   1. 存在失败工具且模型未自认失败 → terminalNotice 携带失败摘要，
 *      且 finalResponse 以模型散文开头（散文已走 token 流、通知未走）。
 *   2. 纯成功且模型给出完整结论 → terminalNotice 为空（不产生重复输出）。
 */

const mockExecuteTool = jest.fn(async (name) => {
  // 注意：loop 在调用 executeTool 前会把工具名归一化（web_search → webSearch），
  // 故此处按「包含 search」匹配，避免硬编码下划线名导致 mock 落到成功分支。
  if (/web.?search/i.test(String(name))) {
    // 模拟 cheerio 缺失导致的软失败（用户真实场景）。
    return { success: false, error: 'cheerio 未安装，无法解析搜索结果' };
  }
  return { success: true, output: 'ok' };
});

jest.mock('../../src/services/toolCalling', () => ({
  executeTool: mockExecuteTool,
  clearPreflightContext: jest.fn(),
  setPreflightContext: jest.fn(),
}));
jest.mock('../../src/services/inputPreprocessor', () => ({
  preprocess: jest.fn((text) => ({ processed: text })),
}));
jest.mock('../../src/services/securityGuardService', () => ({
  analyzeInput: jest.fn(() => ({ safe: true })),
}));

// 充分长且不含任何失败关键词的结论：触发 conclude，且模型「已写结论」→
// 不追加模板交付摘要，使 terminalNotice 干净等于失败摘要。
const SUBSTANTIVE = 'Here is a thorough and complete final answer to your question. '.repeat(10);

describe('toolUseLoop — terminalNotice 零静默失败回传契约', () => {
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

  test('失败工具 + 模型未自认 → terminalNotice 携失败摘要，finalResponse 以散文开头', async () => {
    const toolUseLoop = require('../../src/services/toolUseLoop');
    const chat = jest.fn()
      .mockResolvedValueOnce({
        reply: '<tool_call>{"name":"web_search","params":{"query":"最近新闻"}}</tool_call>',
        provider: 'mock',
      })
      .mockResolvedValueOnce({ reply: SUBSTANTIVE, stopReason: 'stop', provider: 'mock' });

    const result = await toolUseLoop.runToolUseLoop('最近有什么新闻', { chat, maxIterations: 4 });

    // 失败摘要必须存在于 finalResponse（整体）与 terminalNotice（合成尾巴）中。
    expect(result.finalResponse).toContain('部分操作未成功');
    expect(typeof result.terminalNotice).toBe('string');
    expect(result.terminalNotice).toContain('部分操作未成功');
    // 散文走了 token 流；通知没有 → finalResponse 以散文开头，terminalNotice 是其尾巴。
    expect(result.finalResponse.startsWith('Here is a thorough')).toBe(true);
    expect(result.finalResponse.endsWith(result.terminalNotice)).toBe(true);
    // 失败工具确实进入日志（成败权威字段在 entry.result.success）。
    const failed = (result.toolCallLog || []).filter((t) => t.result && t.result.success === false);
    expect(failed.length).toBeGreaterThan(0);
  }, 30000);

  test('纯成功 + 完整结论 → terminalNotice 为空（不重复输出）', async () => {
    mockExecuteTool.mockImplementation(async () => ({ success: true, results: [{ title: 'r1' }], output: 'web ok' }));
    const toolUseLoop = require('../../src/services/toolUseLoop');
    const chat = jest.fn()
      .mockResolvedValueOnce({
        reply: '<tool_call>{"name":"web_search","params":{"query":"x"}}</tool_call>',
        provider: 'mock',
      })
      .mockResolvedValueOnce({ reply: SUBSTANTIVE, stopReason: 'stop', provider: 'mock' });

    const result = await toolUseLoop.runToolUseLoop('搜一下', { chat, maxIterations: 4 });
    expect(result.terminalNotice).toBe('');
  }, 30000);
});
