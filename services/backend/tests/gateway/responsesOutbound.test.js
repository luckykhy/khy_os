'use strict';

/**
 * Responses API outbound handler (KhyOS as client) — Phase D.
 *
 * Two layers under test:
 *   1. _responsesSseStream.parseResponsesSseStream — consuming a Responses SSE
 *      stream (named-event/data lines) and reducing it to
 *      { content, toolUseBlocks, usage } with correct item_id/call_id handling.
 *   2. _protocolPipeline responses handler — buildRequestBody produces the
 *      input[]+instructions shape, parseJsonResponse parses output[], and
 *      parseStreamResponse delegates to the stream parser.
 *
 * No network: a fake Readable replays a scripted SSE byte sequence.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');

const { parseResponsesSseStream } = require('../../src/services/gateway/adapters/_responsesSseStream');
const { createProtocolHandler } = require('../../src/services/gateway/adapters/_protocolPipeline');

// Build a Responses SSE wire payload from a list of events. Each event becomes
// the canonical two-line `event:`/`data:` pair the real API emits.
function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

// A Readable that yields the payload in arbitrary-sized slices to exercise the
// line-buffering across chunk boundaries.
function fakeStream(payload, sliceLen = 7) {
  const slices = [];
  for (let i = 0; i < payload.length; i += sliceLen) slices.push(payload.slice(i, i + sliceLen));
  return Readable.from(slices);
}

const TEXT_THEN_TOOL = [
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5', status: 'in_progress' } },
  { type: 'response.in_progress', response: { id: 'resp_1', model: 'gpt-5', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant' } },
  { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, part: { type: 'output_text' } },
  { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'Hel' },
  { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'lo!' },
  { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, text: 'Hello!' },
  { type: 'response.content_part.done', item_id: 'msg_1', output_index: 0 },
  { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message' } },
  { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_xyz', name: 'Bash' } },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"comm' },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: 'and":"ls"}' },
  { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 1, arguments: '{"command":"ls"}', name: null },
  { type: 'response.output_item.done', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_xyz', name: 'Bash', arguments: '{"command":"ls"}' } },
  {
    type: 'response.completed',
    response: {
      id: 'resp_1', model: 'gpt-5', status: 'completed',
      usage: { input_tokens: 11, output_tokens: 9, total_tokens: 20 },
      output: [],
    },
  },
];

describe('parseResponsesSseStream — text then a streamed function call', () => {
  test('accumulates text, tool args, usage; keeps item_id/call_id distinct', async () => {
    const chunks = [];
    const result = await parseResponsesSseStream(
      fakeStream(sse(TEXT_THEN_TOOL)),
      (c) => chunks.push(c),
    );

    assert.equal(result.content, 'Hello!');
    assert.equal(result.model, 'gpt-5');
    assert.equal(result.finishReason, 'tool_use', 'a tool call normalizes to tool_use');
    assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 9, total_tokens: 20 });

    assert.equal(result.toolUseBlocks.length, 1);
    const tool = result.toolUseBlocks[0];
    assert.equal(tool.id, 'call_xyz', 'emitted id is the call_id (what upstream wants back)');
    assert.equal(tool.name, 'Bash');
    assert.deepEqual(tool.input, { command: 'ls' }, 'arg deltas concatenate to valid JSON');
  });

  test('onChunk emits text → tool_use_start → input deltas → tool_use_end in order', async () => {
    const chunks = [];
    await parseResponsesSseStream(fakeStream(sse(TEXT_THEN_TOOL)), (c) => chunks.push(c));
    const types = chunks.map((c) => c.type);

    const firstText = types.indexOf('text');
    const start = types.indexOf('tool_use_start');
    const firstDelta = types.indexOf('tool_use_input_delta');
    const end = types.indexOf('tool_use_end');

    assert.ok(firstText >= 0 && start > firstText, 'text precedes tool_use_start');
    assert.ok(firstDelta > start, 'input deltas follow tool_use_start');
    assert.ok(end > firstDelta, 'tool_use_end is last');

    const startChunk = chunks[start];
    assert.equal(startChunk.id, 'call_xyz');
    assert.equal(startChunk.name, 'Bash');

    // text fragments are surfaced verbatim
    const textFrags = chunks.filter((c) => c.type === 'text').map((c) => c.text).join('');
    assert.equal(textFrags, 'Hello!');
  });

  test('no [DONE] sentinel is required to terminate', async () => {
    // The scripted payload deliberately omits [DONE]; resolution proves
    // response.completed alone terminates the stream.
    const result = await parseResponsesSseStream(fakeStream(sse(TEXT_THEN_TOOL)), () => {});
    assert.ok(result, 'stream resolved on response.completed without [DONE]');
  });
});

describe('parseResponsesSseStream — completed-snapshot fallback', () => {
  test('reconstructs content + tool calls when only response.completed carries output[]', async () => {
    const events = [
      { type: 'response.created', response: { id: 'resp_2', model: 'gpt-5' } },
      {
        type: 'response.completed',
        response: {
          id: 'resp_2', model: 'gpt-5', status: 'completed',
          usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'snapshot text' }] },
            { type: 'function_call', call_id: 'call_snap', name: 'Read', arguments: '{"file_path":"/x"}' },
          ],
        },
      },
    ];
    const result = await parseResponsesSseStream(fakeStream(sse(events)), () => {});
    assert.equal(result.content, 'snapshot text');
    assert.equal(result.toolUseBlocks.length, 1);
    assert.equal(result.toolUseBlocks[0].id, 'call_snap');
    assert.equal(result.toolUseBlocks[0].name, 'Read');
    assert.deepEqual(result.toolUseBlocks[0].input, { file_path: '/x' });
  });
});

describe('responses protocol handler — request/response shapes', () => {
  const handler = createProtocolHandler({ protocol: 'responses', adapterName: 'test' });

  test('buildRequestBody produces input[] + instructions (not messages[])', () => {
    const { body, system } = handler.buildRequestBody('hello world', {
      model: 'gpt-5',
      system: 'be terse',
      tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
    });
    assert.equal(system, 'be terse');
    assert.equal(body.instructions, 'be terse', 'system → instructions');
    assert.ok(Array.isArray(body.input), 'codex body uses input[]');
    assert.equal(body.messages, undefined, 'no OpenAI messages[] leaks through');
    assert.equal(body.input[0].type, 'message');
    assert.equal(body.input[0].role, 'user');
    assert.equal(body.input[0].content[0].type, 'input_text');
    assert.equal(body.input[0].content[0].text, 'hello world');
    assert.equal(body.tools[0].type, 'function');
    assert.equal(body.tools[0].name, 'Bash');
  });

  test('parseJsonResponse extracts content, toolUseBlocks (JSON-parsed args), usage', () => {
    const parsed = handler.parseJsonResponse({
      model: 'gpt-5',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
        { type: 'function_call', call_id: 'call_a', name: 'Write', arguments: '{"file_path":"/a","content":"x"}' },
      ],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });
    assert.equal(parsed.content, 'done');
    assert.equal(parsed.stopReason, 'tool_use');
    assert.equal(parsed.toolUseBlocks.length, 1);
    assert.deepEqual(parsed.toolUseBlocks[0].input, { file_path: '/a', content: 'x' });
    assert.equal(parsed.usage.total_tokens, 5);
  });

  test('parseStreamResponse delegates to the Responses SSE parser', async () => {
    const result = await handler.parseStreamResponse(fakeStream(sse(TEXT_THEN_TOOL)), () => {});
    assert.equal(result.content, 'Hello!');
    assert.equal(result.toolUseBlocks[0].id, 'call_xyz');
  });
});
