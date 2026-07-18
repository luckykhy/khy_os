'use strict';

const { ensureToolResultPairing } = require('../src/services/contentBlockUtils');

describe('contentBlockUtils.ensureToolResultPairing', () => {
  test('appends placeholder tool_result blocks for missing ids in the next structured user message', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running tools.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.js' } },
          { type: 'tool_use', id: 'tool-2', name: 'Read', input: { path: 'b.js' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
        ],
      },
    ];

    ensureToolResultPairing(messages);

    expect(messages[1].content).toEqual([
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
      {
        type: 'tool_result',
        tool_use_id: 'tool-2',
        content: '[Earlier tool result omitted to save context. It completed successfully; re-run the tool only if you still need its output.]',
        is_error: false,
      },
    ]);
  });

  test('converts a plain-text user message into structured content before appending placeholders', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-3', name: 'Search', input: { query: 'khy' } },
        ],
      },
      {
        role: 'user',
        content: 'continue please',
      },
    ];

    ensureToolResultPairing(messages);

    expect(messages[1].content).toEqual([
      { type: 'text', text: 'continue please' },
      {
        type: 'tool_result',
        tool_use_id: 'tool-3',
        content: '[Earlier tool result omitted to save context. It completed successfully; re-run the tool only if you still need its output.]',
        is_error: false,
      },
    ]);
  });

  test('inserts a synthetic user message when no following user turn exists', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-4', name: 'Write', input: { path: 'out.txt' } },
        ],
      },
    ];

    ensureToolResultPairing(messages);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-4',
          content: '[Earlier tool result omitted to save context. It completed successfully; re-run the tool only if you still need its output.]',
          is_error: false,
        },
      ],
    });
  });
});
