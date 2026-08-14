'use strict';

/**
 * Codex (OpenAI Responses API) protocol converter — unit safety net.
 *
 * The codex converter (toCanonical / fromCanonical) is the wire ⇄ canonical
 * bridge behind KhyOS's `/v1/responses` inbound serving and outbound client.
 * Before this suite it had ZERO direct coverage, so these tests pin the exact
 * shapes the streaming state machine and the session store depend on:
 *
 *   - toCanonical: input[] item parsing (message / function_call /
 *     function_call_output), instructions→system, max_output_tokens, tool filter.
 *   - fromCanonical: text → output[{type:'message',content:[output_text]}],
 *     toolCalls → function_call with `arguments` ALWAYS a JSON string and the
 *     call_id preserved, usage field names (input_tokens/output_tokens/
 *     total_tokens), status requires_action vs completed.
 *   - round-trip: buildCodexRequest(index.js) ⇄ toCanonical message/tool parity.
 *
 * These run against the SINGLE source of truth at
 * platform/packages/shared (the backend protocolConverter is a thin re-export
 * shim onto @khy/shared).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const converter = require('../../src/services/gateway/protocolConverter');
const { PROTOCOLS } = converter;

// The codex submodules are not individually exported by @khy/shared's exports
// map, so drive them through the public converter API (which dispatches to
// codex.toCanonical / codex.fromCanonical for the CODEX protocol).
const codex = {
  toCanonical: (body) => converter.convertRequest(body, PROTOCOLS.CODEX).canonical,
  fromCanonical: (canonical) => converter.convertResponse(canonical, PROTOCOLS.CODEX),
};
// fromCanonical only reads id/model/content/toolCalls/usage, so a plain literal
// stands in for the canonical-response factory.
const createCanonicalResponse = (overrides = {}) => ({
  id: '', model: '', role: 'assistant', content: '', thinking: null,
  toolCalls: null, stopReason: 'stop', usage: null, ...overrides,
});

describe('codex.toCanonical — Responses request → canonical', () => {
  test('instructions become the system prompt; max_output_tokens carried', () => {
    const c = codex.toCanonical({
      model: 'gpt-5',
      instructions: 'You are a helpful assistant.',
      max_output_tokens: 2048,
      temperature: 0.3,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    });
    assert.equal(c.model, 'gpt-5');
    assert.equal(c.system, 'You are a helpful assistant.');
    assert.equal(c.metadata.maxTokens, 2048);
    assert.equal(c.metadata.temperature, 0.3);
    assert.equal(c.messages.length, 1);
    assert.equal(c.messages[0].role, 'user');
    assert.equal(c.messages[0].content, 'hi');
  });

  test('message content array of parts is concatenated to a string', () => {
    const c = codex.toCanonical({
      input: [{
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'foo ' }, { type: 'input_text', text: 'bar' }],
      }],
    });
    assert.equal(c.messages[0].content, 'foo bar');
  });

  test('a plain string content is accepted as-is', () => {
    const c = codex.toCanonical({ input: [{ type: 'message', role: 'user', content: 'plain' }] });
    assert.equal(c.messages[0].content, 'plain');
  });

  test('function_call attaches to the preceding assistant message as a toolCall', () => {
    const c = codex.toCanonical({
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'calling' }] },
        { type: 'function_call', call_id: 'call_abc', name: 'get_weather', arguments: '{"city":"SF"}' },
      ],
    });
    const assistant = c.messages[0];
    assert.equal(assistant.role, 'assistant');
    assert.ok(Array.isArray(assistant.toolCalls));
    assert.equal(assistant.toolCalls.length, 1);
    assert.equal(assistant.toolCalls[0].id, 'call_abc');
    assert.equal(assistant.toolCalls[0].name, 'get_weather');
    assert.deepEqual(assistant.toolCalls[0].arguments, { city: 'SF' });
  });

  test('malformed function_call arguments do not throw (wrapped as _raw)', () => {
    const c = codex.toCanonical({
      input: [
        { type: 'message', role: 'assistant', content: 'x' },
        { type: 'function_call', call_id: 'call_x', name: 'f', arguments: '{not json' },
      ],
    });
    assert.deepEqual(c.messages[0].toolCalls[0].arguments, { _raw: '{not json' });
  });

  test('function_call_output becomes a tool-role message with toolResults', () => {
    const c = codex.toCanonical({
      input: [
        { type: 'function_call_output', call_id: 'call_abc', output: '72F sunny' },
      ],
    });
    assert.equal(c.messages[0].role, 'tool');
    assert.equal(c.messages[0].content, '72F sunny');
    assert.equal(c.messages[0].toolResults[0].toolCallId, 'call_abc');
    assert.equal(c.messages[0].toolResults[0].content, '72F sunny');
    assert.equal(c.messages[0].toolResults[0].isError, false);
  });

  test('only function-typed tools are kept and mapped to canonical tool defs', () => {
    const c = codex.toCanonical({
      input: [],
      tools: [
        { type: 'function', name: 'lookup', description: 'd', parameters: { type: 'object' } },
        { type: 'web_search' }, // built-in tool — must be dropped (no canonical equiv)
      ],
    });
    assert.equal(c.tools.length, 1);
    assert.equal(c.tools[0].name, 'lookup');
    assert.deepEqual(c.tools[0].parameters, { type: 'object' });
  });

  test('empty body yields a valid empty canonical request', () => {
    const c = codex.toCanonical({});
    assert.deepEqual(c.messages, []);
    assert.equal(c.system, null);
    assert.equal(c.metadata.maxTokens, 4096);
  });
});

describe('codex.fromCanonical — canonical response → Responses body', () => {
  test('text-only response → message item with output_text and status completed', () => {
    const out = codex.fromCanonical(createCanonicalResponse({
      id: 'resp_fixed', model: 'gpt-5', content: 'hello world',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }));
    assert.equal(out.object, 'response');
    assert.equal(out.id, 'resp_fixed');
    assert.equal(out.status, 'completed');
    assert.equal(out.model, 'gpt-5');
    assert.equal(out.output.length, 1);
    assert.equal(out.output[0].type, 'message');
    assert.equal(out.output[0].role, 'assistant');
    assert.equal(out.output[0].content[0].type, 'output_text');
    assert.equal(out.output[0].content[0].text, 'hello world');
  });

  test('usage uses input_tokens / output_tokens / total_tokens (NOT prompt_tokens)', () => {
    const out = codex.fromCanonical(createCanonicalResponse({
      content: 'x', usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
    }));
    assert.deepEqual(out.usage, { input_tokens: 3, output_tokens: 7, total_tokens: 10 });
    assert.equal('prompt_tokens' in out.usage, false);
  });

  test('no usage → usage omitted (undefined)', () => {
    const out = codex.fromCanonical(createCanonicalResponse({ content: 'x' }));
    assert.equal(out.usage, undefined);
  });

  test('tool calls → function_call items with arguments as a JSON STRING and call_id preserved', () => {
    const out = codex.fromCanonical(createCanonicalResponse({
      content: '',
      toolCalls: [{ id: 'call_42', name: 'search', arguments: { q: 'cats' } }],
    }));
    const fc = out.output.find((o) => o.type === 'function_call');
    assert.ok(fc, 'a function_call item is emitted');
    assert.equal(fc.call_id, 'call_42');
    assert.equal(fc.name, 'search');
    assert.equal(typeof fc.arguments, 'string', 'arguments MUST be a JSON string, never an object');
    assert.deepEqual(JSON.parse(fc.arguments), { q: 'cats' });
    assert.equal(fc.status, 'completed');
  });

  test('presence of tool calls flips the top-level status to requires_action', () => {
    const out = codex.fromCanonical(createCanonicalResponse({
      content: '', toolCalls: [{ id: 'c', name: 'f', arguments: {} }],
    }));
    assert.equal(out.status, 'requires_action');
  });

  test('text + tool call → both a message and a function_call item', () => {
    const out = codex.fromCanonical(createCanonicalResponse({
      content: 'let me check', toolCalls: [{ id: 'c1', name: 'f', arguments: { a: 1 } }],
    }));
    const kinds = out.output.map((o) => o.type);
    assert.deepEqual(kinds, ['message', 'function_call']);
  });
});

describe('round-trip — buildCodexRequest ⇄ toCanonical parity', () => {
  test('messages + tool calls + tool results survive a canonical→codex→canonical round trip', () => {
    const original = {
      model: 'gpt-5',
      messages: [
        { role: 'user', content: 'weather?', thinking: null, toolCalls: null, toolResults: null },
        {
          role: 'assistant', content: 'checking', thinking: null,
          toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'SF' } }], toolResults: null,
        },
        {
          role: 'tool', content: '72F', thinking: null, toolCalls: null,
          toolResults: [{ toolCallId: 'call_1', name: '', content: '72F', isError: false }],
        },
      ],
      system: 'be terse',
      metadata: { maxTokens: 1024, temperature: 0.5, topP: null, stream: false, stopSequences: null },
      tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }],
      toolChoice: null,
    };

    const body = converter.buildRequestBody(original, PROTOCOLS.CODEX);
    // The built request must be Responses-shaped.
    assert.equal(body.instructions, 'be terse');
    assert.equal(body.max_output_tokens, 1024);
    assert.ok(body.input.some((i) => i.type === 'function_call' && i.call_id === 'call_1'));
    assert.ok(body.input.some((i) => i.type === 'function_call_output' && i.call_id === 'call_1'));
    assert.equal(body.tools[0].type, 'function');
    assert.equal(body.tools[0].name, 'get_weather');

    const back = codex.toCanonical(body);
    assert.equal(back.system, 'be terse');
    assert.equal(back.metadata.maxTokens, 1024);
    assert.equal(back.messages[0].content, 'weather?');
    // assistant tool call preserved (id + parsed args)
    const asst = back.messages.find((m) => m.role === 'assistant');
    assert.equal(asst.toolCalls[0].id, 'call_1');
    assert.deepEqual(asst.toolCalls[0].arguments, { city: 'SF' });
    // tool result preserved
    const toolMsg = back.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.toolResults[0].toolCallId, 'call_1');
    assert.equal(toolMsg.toolResults[0].content, '72F');
  });
});
