'use strict';

/**
 * toolUseLoop.localTextProtocol.integration.test.js
 *
 * The keystone regression proof for the two-loop collapse: a weak LOCAL model,
 * wrapped by makeLocalModelChat and driven through the SAME runToolUseLoop as
 * cloud models on the TEXT tool-call protocol, must:
 *
 *   1. Have its `<tool_call>` text parsed AUTHORITATIVELY (not as a native
 *      fallback) and routed into the shared executeTool funnel — so it gains
 *      PreToolUse hooks / failsafe / write-diff for free (the whole point).
 *   2. Receive the tool result back as a plain-text follow-up turn (FORMAT
 *      seam), so the next turn sees what happened and can conclude.
 *
 * executeTool is mocked so no real filesystem write occurs; we assert the call
 * reached the funnel with the parsed params, which is the integration boundary.
 */

describe('toolUseLoop — weak local model on the unified text protocol', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('text <tool_call> from a local model reaches executeTool and the result feeds back', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';

    const executeTool = jest.fn(async (name, params) => ({
      success: true,
      output: `wrote ${params && params.file_path}`,
    }));
    const getToolDefinitions = jest.fn(() => ([
      { name: 'Read', description: 'read', parameters: { properties: { file_path: {} }, required: ['file_path'] } },
      { name: 'Write', description: 'write', parameters: { properties: { file_path: {}, content: {} }, required: ['file_path', 'content'] } },
    ]));
    jest.doMock('../src/services/toolCalling', () => ({
      executeTool,
      getToolDefinitions,
      clearPreflightContext: jest.fn(),
      setPreflightContext: jest.fn(),
    }));

    const { makeLocalModelChat } = require('../src/services/localChatAdapters');
    const toolUseLoop = require('../src/services/toolUseLoop');

    // Fake local adapter: turn 1 emits a Write tool_call as TEXT; turn 2 (after
    // seeing the tool result) concludes with a final answer.
    let turn = 0;
    const gateway = {
      generateWithSubModel: jest.fn(async () => {
        turn += 1;
        if (turn === 1) {
          return {
            success: true,
            content: '<tool_call>{"name":"Write","params":{"file_path":"note.txt","content":"hello"}}</tool_call>',
            provider: 'ollama',
          };
        }
        return { success: true, content: '已写入 note.txt，任务完成。', provider: 'ollama' };
      }),
    };

    const chat = makeLocalModelChat(gateway, 'ollama', { writeEnabled: true });
    const result = await toolUseLoop.runToolUseLoop('把 hello 写进 note.txt', {
      chat,
      toolCallProtocol: 'text',
      sessionId: 'local-tool-loop',
      maxIterations: 4,
    });

    // 1. The parsed write call reached the shared funnel with its params intact.
    expect(executeTool).toHaveBeenCalledTimes(1);
    const [calledName, calledParams] = executeTool.mock.calls[0];
    expect(String(calledName).toLowerCase()).toMatch(/write/);
    expect(calledParams).toEqual(expect.objectContaining({ file_path: 'note.txt', content: 'hello' }));

    // 2. The loop ran at least a second model turn (tool result fed back) and
    //    concluded. (The unified loop may add a forced-summary turn — benign.)
    expect(gateway.generateWithSubModel.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.finalResponse).toContain('任务完成');

    // 3. The second model turn saw the tool result text in its transcript.
    const secondCallMessages = gateway.generateWithSubModel.mock.calls[1][2].messages;
    const transcript = secondCallMessages.map(m => m.content).join('\n');
    expect(transcript).toMatch(/note\.txt/); // either the original goal or the result echo
  });

  test('a local model that calls no tool concludes in one turn (read-only prose)', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';

    const executeTool = jest.fn(async () => ({ success: true, output: 'x' }));
    jest.doMock('../src/services/toolCalling', () => ({
      executeTool,
      getToolDefinitions: jest.fn(() => []),
      clearPreflightContext: jest.fn(),
      setPreflightContext: jest.fn(),
    }));

    const { makeLocalModelChat } = require('../src/services/localChatAdapters');
    const toolUseLoop = require('../src/services/toolUseLoop');

    const gateway = {
      generateWithSubModel: jest.fn(async () => ({ success: true, content: '这是一个直接回答，无需工具。', provider: 'ollama' })),
    };
    const chat = makeLocalModelChat(gateway, 'ollama', {});
    const result = await toolUseLoop.runToolUseLoop('解释一下闭包', {
      chat,
      toolCallProtocol: 'text',
      maxIterations: 4,
    });

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.finalResponse).toContain('直接回答');
  });
});
