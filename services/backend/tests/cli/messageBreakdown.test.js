'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  analyzeMessageBreakdown,
  messageBreakdownEnabled,
} = require('../../src/services/context/messageBreakdown');

// 确定性估算器:1 token / 4 字符。
const est = (t) => Math.ceil(String(t || '').length / 4);

test('gate off → null', () => {
  const r = analyzeMessageBreakdown(
    { messages: [{ role: 'user', content: 'hi' }], estimateTokens: est },
    { KHY_MESSAGE_BREAKDOWN: '0' },
  );
  assert.strictEqual(r, null);
  assert.strictEqual(messageBreakdownEnabled({ KHY_MESSAGE_BREAKDOWN: 'off' }), false);
  assert.strictEqual(messageBreakdownEnabled({}), true);
});

test('empty / no estimator → null', () => {
  assert.strictEqual(analyzeMessageBreakdown({ messages: [], estimateTokens: est }, {}), null);
  assert.strictEqual(analyzeMessageBreakdown({ messages: [{ role: 'user', content: 'x' }] }, {}), null);
  assert.strictEqual(analyzeMessageBreakdown(null, {}), null);
});

test('string content → user/assistant message tokens', () => {
  const r = analyzeMessageBreakdown(
    {
      messages: [
        { role: 'user', content: 'x'.repeat(40) }, // 10 tokens
        { role: 'assistant', content: 'y'.repeat(80) }, // 20 tokens
      ],
      estimateTokens: est,
    },
    {},
  );
  assert.strictEqual(r.userMessageTokens, 10);
  assert.strictEqual(r.assistantMessageTokens, 20);
  assert.strictEqual(r.toolCallTokens, 0);
  assert.deepStrictEqual(r.toolCallsByType, []);
});

test('tool_use block → toolCallsByType callTokens', () => {
  const block = { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } };
  const r = analyzeMessageBreakdown(
    { messages: [{ role: 'assistant', content: [block] }], estimateTokens: est },
    {},
  );
  const expected = est(JSON.stringify(block));
  assert.strictEqual(r.toolCallTokens, expected);
  assert.strictEqual(r.toolCallsByType.length, 1);
  assert.strictEqual(r.toolCallsByType[0].name, 'Bash');
  assert.strictEqual(r.toolCallsByType[0].callTokens, expected);
  assert.strictEqual(r.toolCallsByType[0].resultTokens, 0);
});

test('tool_result mapped to tool name via tool_use_id', () => {
  const useBlock = { type: 'tool_use', id: 'tu_42', name: 'Read', input: { file_path: '/a' } };
  const resBlock = { type: 'tool_result', tool_use_id: 'tu_42', content: 'z'.repeat(400) };
  const r = analyzeMessageBreakdown(
    {
      messages: [
        { role: 'assistant', content: [useBlock] },
        { role: 'user', content: [resBlock] },
      ],
      estimateTokens: est,
    },
    {},
  );
  const read = r.toolCallsByType.find((t) => t.name === 'Read');
  assert.ok(read);
  assert.strictEqual(read.callTokens, est(JSON.stringify(useBlock)));
  assert.strictEqual(read.resultTokens, est(JSON.stringify(resBlock)));
  assert.ok(r.toolResultTokens > 0);
});

test('tool_result with unknown id → unknown bucket', () => {
  const resBlock = { type: 'tool_result', tool_use_id: 'nope', content: 'q' };
  const r = analyzeMessageBreakdown(
    { messages: [{ role: 'user', content: [resBlock] }], estimateTokens: est },
    {},
  );
  const unk = r.toolCallsByType.find((t) => t.name === 'unknown');
  assert.ok(unk);
  assert.strictEqual(unk.callTokens, 0);
  assert.ok(unk.resultTokens > 0);
});

test('multiple tools aggregate + sorted by total desc', () => {
  const bash1 = { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'a' } };
  const bashRes = { type: 'tool_result', tool_use_id: 'b1', content: 'x'.repeat(800) }; // big
  const grep1 = { type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'x' } };
  const r = analyzeMessageBreakdown(
    {
      messages: [
        { role: 'assistant', content: [bash1, grep1] },
        { role: 'user', content: [bashRes] },
      ],
      estimateTokens: est,
    },
    {},
  );
  assert.strictEqual(r.toolCallsByType[0].name, 'Bash'); // Bash total (call+big result) > Grep
  assert.strictEqual(r.toolCallsByType.length, 2);
});

test('text block inside assistant array → assistantMessageTokens', () => {
  const r = analyzeMessageBreakdown(
    {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          ],
        },
      ],
      estimateTokens: est,
    },
    {},
  );
  assert.ok(r.assistantMessageTokens > 0);
  assert.ok(r.toolCallTokens > 0);
});

test('never throws on malformed content', () => {
  assert.doesNotThrow(() => {
    analyzeMessageBreakdown(
      {
        messages: [
          { role: 'assistant', content: [null, 42, { type: 'tool_use' }] },
          { role: 'user', content: undefined },
          null,
          { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 5 }] },
        ],
        estimateTokens: est,
      },
      {},
    );
  });
});

test('tool_use without name → unknown', () => {
  const r = analyzeMessageBreakdown(
    { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x', input: {} }] }], estimateTokens: est },
    {},
  );
  assert.strictEqual(r.toolCallsByType[0].name, 'unknown');
});
