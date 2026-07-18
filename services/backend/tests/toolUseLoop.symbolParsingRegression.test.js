'use strict';

describe('toolUseLoop symbol-prefixed tool call parsing regressions', () => {
  afterEach(() => {
    jest.resetModules();
  });

  test('parses UI symbol prefixed tool calls like ⌕ Search() and ◆ Write(...)', () => {
    const toolUseLoop = require('../src/services/toolUseLoop');

    const calls = toolUseLoop._parseToolCalls([
      '让我先演示一下：',
      '⌕ Search()',
      '◆ Write(path="/tmp/demo.txt", content="hello")',
    ].join('\n'));

    expect(Array.isArray(calls)).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);

    const names = calls.map(c => String(c.name || '').toLowerCase());
    expect(names).toContain('search');
    expect(names.some(n => n === 'writefile' || n === 'write_file' || n === 'write')).toBe(true);
  });

  test('patches empty Search() keyword from user message context', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';

    const executeTool = jest.fn(async (name, params) => {
      if (name === 'search') {
        return { success: true, echoedKeyword: params?.keyword || '' };
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
      .mockResolvedValueOnce({ reply: '我先查一下。\n⌕ Search()' })
      .mockResolvedValueOnce({ reply: '已完成。' });

    const result = await toolUseLoop.runToolUseLoop('请搜索 KHY 工具调用能力', {
      chat,
      maxIterations: 4,
    });

    expect(result.finalResponse).toContain('已完成');
    const searchCalls = executeTool.mock.calls.filter(([toolName]) => toolName === 'search');
    expect(searchCalls.length).toBeGreaterThan(0);
    const keyword = String(searchCalls[0][1]?.keyword || '');
    expect(keyword).toContain('KHY');
  });
});
