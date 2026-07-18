'use strict';

describe('toolUseLoop auto web-search injection', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('auto-injects web_search when first response has no tools for info-search request', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_AUTO_WEBSEARCH_QUERY_CANDIDATES = '3';

    const executeTool = jest.fn(async (name, params) => {
      if (name === 'web_search' || name === 'webSearch') {
        return {
          success: true,
          results: [{ title: '今日热点', url: 'https://example.com/hot' }],
          formatted: 'ok',
        };
      }
      return { success: false, error: `unexpected tool: ${name}` };
    });

    jest.doMock('../src/services/toolCalling', () => ({
      executeTool,
      clearPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest
      .fn()
      .mockResolvedValue({ reply: '已整理完成。' })
      .mockResolvedValueOnce({ reply: '我先快速看一下情况。' });

    const result = await toolUseLoop.runToolUseLoop('帮我查一下今天 AI 行业最新新闻', {
      chat,
      maxIterations: 5,
    });

    expect(chat.mock.calls.length).toBeGreaterThanOrEqual(2);
    const followUpPrompts = chat.mock.calls.slice(1).map(call => String(call[0] || ''));
    expect(followUpPrompts.some(prompt => prompt.includes('[Tool execution results]'))).toBe(true);
    const webSearchCalls = executeTool.mock.calls
      .filter(([toolName]) => toolName === 'webSearch' || toolName === 'web_search');
    expect(webSearchCalls.length).toBeGreaterThan(0);
    const queriedTexts = webSearchCalls.map(([, params]) => String(params?.query || ''));
    expect(queriedTexts.some(text => /ai|行业|新闻/i.test(text))).toBe(true);
    expect(result.finalResponse).toContain('已整理完成');
  });

  test('preserves tool-preface as running commentary by default (no suppression)', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    delete process.env.KHY_TOOL_LOOP_SUPPRESS_TOOL_PREFACE;

    const executeTool = jest.fn(async (name) => {
      if (name === 'web_search' || name === 'webSearch') {
        return { success: true, results: [], formatted: 'ok' };
      }
      return { success: false, error: `unexpected tool: ${name}` };
    });

    jest.doMock('../src/services/toolCalling', () => ({
      executeTool,
      clearPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest
      .fn()
      .mockResolvedValueOnce({
        reply: '搜索一下。<tool_call>{"name":"web_search","params":{"query":"latest ai news"}}</tool_call>',
      })
      .mockResolvedValueOnce({ reply: 'done' });

    const result = await toolUseLoop.runToolUseLoop('最近 AI 新闻', {
      chat,
      maxIterations: 4,
    });

    expect(chat).toHaveBeenCalledTimes(2);
    // v0.1.82 (CLI display-layer): the loop preserves any text the model emits
    // before <tool_call> as concise running commentary instead of suppressing
    // it. Suppression is opt-in via KHY_TOOL_LOOP_SUPPRESS_TOOL_PREFACE=1.
    // Pre-tool prose now flows as normal streaming text rather than being routed
    // to a one-line preface, so routeToolPrefaceToNarration defaults to false.
    expect(chat.mock.calls[0][1]).toMatchObject({
      suppressPrefixOnToolCall: false,
      routeToolPrefaceToNarration: false,
    });
    expect(result.finalResponse).toContain('done');
  });

  test('does not bail out when all failed tools are web lookups', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_AUTO_WEBSEARCH_QUERY_CANDIDATES = '2';

    const executeTool = jest.fn(async (name) => {
      if (name === 'web_search' || name === 'webSearch') {
        return { success: false, error: 'queue is empty' };
      }
      return { success: false, error: `unexpected tool: ${name}` };
    });

    jest.doMock('../src/services/toolCalling', () => ({
      executeTool,
      clearPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest
      .fn()
      .mockResolvedValue({ reply: '外部搜索暂不可用，我先基于已有上下文给出结论，并标注不确定项。' })
      .mockResolvedValueOnce({ reply: '我先查一下外部信息。' });

    const result = await toolUseLoop.runToolUseLoop('帮我搜索今天 AI 领域最新动态', {
      chat,
      maxIterations: 5,
    });

    expect(chat.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.consecutiveFailureBailout).not.toBe(true);
    expect(result.finalResponse).toContain('外部搜索暂不可用');
  });

  test('uses docs-oriented search candidates when docs mode is configured', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_AUTO_WEBSEARCH_QUERY_CANDIDATES = '3';
    process.env.KHY_AUTO_WEBSEARCH_MODE = 'docs';

    const executeTool = jest.fn(async (name) => {
      if (name === 'web_search' || name === 'webSearch') {
        return { success: true, results: [], formatted: 'ok' };
      }
      return { success: false, error: `unexpected tool: ${name}` };
    });

    jest.doMock('../src/services/toolCalling', () => ({
      executeTool,
      clearPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest
      .fn()
      .mockResolvedValueOnce({ reply: '我先查文档。' })
      .mockResolvedValueOnce({ reply: 'done' });

    await toolUseLoop.runToolUseLoop('请帮我查 OpenAI Responses API 的重试参数文档', {
      chat,
      maxIterations: 4,
    });

    const webSearchCalls = executeTool.mock.calls
      .filter(([toolName]) => toolName === 'webSearch' || toolName === 'web_search');
    expect(webSearchCalls.length).toBeGreaterThan(0);
    const queries = webSearchCalls.map(([, params]) => String(params?.query || ''));
    expect(queries.some(q => /official documentation|api reference/i.test(q))).toBe(true);
  });

  test('auto mode classifies academic request and builds academic queries', () => {
    const toolUseLoop = require('../src/services/toolUseLoop');

    expect(toolUseLoop._resolveAutoWebSearchMode('请找一下 transformers 最新 benchmark dataset 论文')).toBe('academic');
    const queries = toolUseLoop._buildSearchQueryCandidates(
      '请找一下 transformers 最新 benchmark dataset 论文',
      5,
      'academic',
    );
    expect(queries.some(q => /arxiv paper|benchmark dataset/i.test(q))).toBe(true);
  });

  test('treats explicit no-search constraint as higher priority than search keywords', () => {
    const toolUseLoop = require('../src/services/toolUseLoop');

    expect(toolUseLoop._extractUserToolConstraints('不要搜索，直接回答').disallowSearch).toBe(true);
    expect(toolUseLoop._looksLikeInfoSearchRequest('不要搜索，直接回答今天 AI 新闻')).toBe(false);
  });

  test('does not auto-inject web_search when user explicitly forbids search', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_AUTO_WEBSEARCH_QUERY_CANDIDATES = '3';

    const executeTool = jest.fn(async (name) => {
      if (name === 'web_search' || name === 'webSearch') {
        return { success: true, results: [], formatted: 'unexpected search' };
      }
      return { success: false, error: `unexpected tool: ${name}` };
    });

    jest.doMock('../src/services/toolCalling', () => ({
      executeTool,
      clearPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest.fn().mockResolvedValueOnce({ reply: '链路验证完成。' });

    const result = await toolUseLoop.runToolUseLoop('不要搜索，直接用中文回复：链路验证完成。', {
      chat,
      maxIterations: 3,
    });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.finalResponse).toContain('链路验证完成');
  });

  test('blocks explicit web_search tool calls when user forbids search', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';

    const executeTool = jest.fn(async () => ({
      success: true,
      results: [],
      formatted: 'unexpected search',
    }));

    jest.doMock('../src/services/toolCalling', () => ({
      executeTool,
      clearPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest
      .fn()
      .mockResolvedValueOnce({
        reply: '先搜一下。<tool_call>{"name":"web_search","params":{"query":"latest ai news"}}</tool_call>',
      })
      .mockResolvedValueOnce({ reply: '链路闭环验证完成。' });

    const result = await toolUseLoop.runToolUseLoop('不要搜索，直接回答链路状态。', {
      chat,
      maxIterations: 4,
    });

    expect(chat).toHaveBeenCalledTimes(2);
    expect(String(chat.mock.calls[1][0] || '')).toContain('Do not use search or browsing tools.');
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.finalResponse).toContain('链路闭环验证完成');
  });

  test('nudges continuation when project-structure request returns no tool call', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';

    const executeTool = jest.fn(async (name) => {
      if (name === 'scaffoldFiles') {
        return { success: true, createdFileCount: 2, createdDirectoryCount: 2, output: 'ok' };
      }
      return { success: false, error: `unexpected tool: ${name}` };
    });

    jest.doMock('../src/services/toolCalling', () => ({
      executeTool,
      clearPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest
      .fn()
      .mockResolvedValueOnce({ reply: '我先整理一下目录结构。' })
      .mockResolvedValueOnce({ reply: 'done' });

    await toolUseLoop.runToolUseLoop('请帮我批量创建项目目录和文件，并行写入提高速度', {
      chat,
      maxIterations: 4,
    });

    expect(chat.mock.calls.length).toBeGreaterThanOrEqual(2);
    const followUpPrompts = chat.mock.calls.slice(1).map(call => String(call[0] || ''));
    // A continuation prompt carrying the original request must be injected. The
    // exact guard depends on the reply shape: a planning preface like
    // "我先整理一下目录结构" now trips the tier-independent self-kickoff guard
    // (Fix C) which injects "[SYSTEM 自驱启动] … 用户原始请求:"; a non-preface
    // short reply would instead trip the earlyEndTurn nudge ("Your reply is too
    // short" / "Original request:"). Either satisfies the intent.
    expect(
      followUpPrompts.some(prompt =>
        prompt.includes('Your reply is too short')
        || prompt.includes('Original request:')
        || prompt.includes('自驱启动')
        || prompt.includes('用户原始请求:'))
    ).toBe(true);
  });

  test('auto-injects scaffoldFiles when scaffold intent is detected and structure is parseable', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_AUTO_SCAFFOLD_ON_INTENT = 'true';

    const executeTool = jest.fn(async (name, params) => {
      if (name === 'scaffoldFiles') {
        return {
          success: true,
          createdDirectoryCount: Array.isArray(params.directories) ? params.directories.length : 0,
          createdFileCount: Array.isArray(params.files) ? params.files.length : 0,
        };
      }
      return { success: false, error: `unexpected tool: ${name}` };
    });

    jest.doMock('../src/services/toolCalling', () => ({
      executeTool,
      clearPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest
      .fn()
      .mockResolvedValueOnce({ reply: '我先准备一下项目结构。' })
      .mockResolvedValueOnce({ reply: 'done' });

    await toolUseLoop.runToolUseLoop(`请创建项目结构：
- src/
- src/main.js
- package.json`, {
      chat,
      maxIterations: 4,
    });

    expect(chat.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(executeTool).toHaveBeenCalledWith('scaffoldFiles', expect.objectContaining({
      directories: expect.arrayContaining(['src']),
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'src/main.js' }),
        expect.objectContaining({ path: 'package.json' }),
      ]),
    }), expect.any(Object));
  });
});
