'use strict';

function loadCreateInterceptor() {
  jest.doMock('../src/services/khyUpgradeRuntime', () => ({
    makeSystemPrompt: jest.fn(() => ''),
  }));
  jest.doMock('../src/cli/toolDisplayPolicy', () => ({
    foldOutput: jest.fn((lines) => ({ lines, folded: false })),
  }));
  const ai = require('../src/cli/ai');
  return ai.__test__._createStreamToolInterceptor;
}

describe('ai tool-preface streaming', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('emits assistant_preface before inline tool_call when suppression is disabled', () => {
    const createInterceptor = loadCreateInterceptor();
    const chunks = [];
    const interceptor = createInterceptor((chunk) => chunks.push(chunk), {
      suppressPrefixOnToolCall: false,
      routeToolPrefaceToNarration: true,
    });

    interceptor.onChunk({
      type: 'text',
      text: 'I will inspect repl.js first.\n<tool_call>{"name":"Read","params":{"file_path":"backend/src/cli/repl.js"}}</tool_call>',
    });

    expect(chunks).toEqual([
      { type: 'assistant_preface', text: 'I will inspect repl.js first.' },
    ]);
  });

  test('emits assistant_preface before structured tool_use when suppression is disabled', () => {
    const createInterceptor = loadCreateInterceptor();
    const chunks = [];
    const interceptor = createInterceptor((chunk) => chunks.push(chunk), {
      suppressPrefixOnToolCall: false,
      routeToolPrefaceToNarration: true,
    });

    interceptor.onChunk({ type: 'text', text: 'I will inspect repl.js first.' });
    interceptor.onChunk({
      type: 'tool_use',
      tool: 'Read',
      input: 'backend/src/cli/repl.js',
      id: 'tool-1',
    });

    expect(chunks).toEqual([
      { type: 'assistant_preface', text: 'I will inspect repl.js first.' },
      { type: 'tool_use', tool: 'Read', input: 'backend/src/cli/repl.js', rawInput: 'backend/src/cli/repl.js', id: 'tool-1' },
    ]);
  });

  test('normalizes name-based tool_use chunks from anthropic/openai style streams', () => {
    const createInterceptor = loadCreateInterceptor();
    const chunks = [];
    const interceptor = createInterceptor((chunk) => chunks.push(chunk), {
      suppressPrefixOnToolCall: false,
      routeToolPrefaceToNarration: true,
    });

    interceptor.onChunk({ type: 'text', text: 'I will inspect repl.js first.' });
    interceptor.onChunk({
      type: 'tool_use',
      name: 'Read',
      input: { file_path: 'backend/src/cli/repl.js' },
      id: 'tool-oa-1',
    });

    expect(chunks).toEqual([
      { type: 'assistant_preface', text: 'I will inspect repl.js first.' },
      { type: 'tool_use', name: 'Read', tool: 'Read', input: 'backend/src/cli/repl.js', rawInput: { file_path: 'backend/src/cli/repl.js' }, id: 'tool-oa-1' },
    ]);
  });

  test('normalizes tool_use_end chunks from incremental adapter streams', () => {
    const createInterceptor = loadCreateInterceptor();
    const chunks = [];
    const interceptor = createInterceptor((chunk) => chunks.push(chunk), {
      suppressPrefixOnToolCall: false,
      routeToolPrefaceToNarration: true,
    });

    interceptor.onChunk({ type: 'text', text: 'I will inspect repl.js first.' });
    interceptor.onChunk({
      type: 'tool_use_end',
      name: 'Read',
      input: { file_path: 'backend/src/cli/repl.js' },
      toolUseId: 'tool-kiro-1',
    });

    expect(chunks).toEqual([
      { type: 'assistant_preface', text: 'I will inspect repl.js first.' },
      { type: 'tool_use', name: 'Read', tool: 'Read', input: 'backend/src/cli/repl.js', rawInput: { file_path: 'backend/src/cli/repl.js' }, toolUseId: 'tool-kiro-1', id: 'tool-kiro-1' },
    ]);
  });

  test('normalizes tool_result error metadata into explicit success=false', () => {
    const createInterceptor = loadCreateInterceptor();
    const chunks = [];
    const interceptor = createInterceptor((chunk) => chunks.push(chunk), {
      suppressPrefixOnToolCall: false,
      routeToolPrefaceToNarration: true,
    });

    interceptor.onChunk({
      type: 'tool_result',
      id: 'tool-err-1',
      content: 'exit 1',
      isError: true,
    });
    interceptor.onChunk({
      type: 'tool_result',
      id: 'tool-err-2',
      content: 'permission denied',
      is_error: true,
    });

    expect(chunks).toEqual([
      { type: 'tool_result', id: 'tool-err-1', content: 'exit 1', isError: true, success: false },
      { type: 'tool_result', id: 'tool-err-2', content: 'permission denied', is_error: true, success: false },
    ]);
  });

  test('suppresses tool preface when suppression is enabled', () => {
    const createInterceptor = loadCreateInterceptor();
    const chunks = [];
    const interceptor = createInterceptor((chunk) => chunks.push(chunk), {
      suppressPrefixOnToolCall: true,
      routeToolPrefaceToNarration: true,
    });

    interceptor.onChunk({
      type: 'text',
      text: 'I will inspect repl.js first.\n<tool_call>{"name":"Read","params":{"file_path":"backend/src/cli/repl.js"}}</tool_call>',
    });

    expect(chunks).toEqual([]);
  });
});
