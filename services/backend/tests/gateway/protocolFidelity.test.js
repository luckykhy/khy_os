'use strict';

/**
 * Protocol fidelity — A/B converter convergence safety net.
 *
 * Pins the cross-layer fixes that make outbound requests conform to each
 * model's native API protocol:
 *
 *   A-layer (platform/packages/shared protocolConverter, re-exported by backend):
 *     - multimodal images survive any↔any conversion (no '[Image]' loss)
 *     - malformed tool-call arguments never crash (survive as {_raw})
 *     - parallel tool_result blocks expand to one wire message each
 *     - Anthropic tool_result names are backfilled from prior tool_use
 *     - sampling / control params (top_p, penalties, seed, response_format,
 *       reasoning_effort, thinking, tool_choice) pass through to the wire
 *
 *   B-layer (_protocolPipeline handlers + _toolSchemaConverter):
 *     - OpenAI / Anthropic handlers emit sampling params from generateOptions
 *     - tool_result embedded images relay as a follow-up vision message
 *       instead of degrading to the literal '[Image]'
 *
 * All A-layer assertions run through the public converter API (single source
 * of truth at @khy/shared; backend protocolConverter is a thin re-export).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const converter = require('../../src/services/gateway/protocolConverter');
const { PROTOCOLS } = converter;
const { createProtocolHandler } = require('../../src/services/gateway/adapters/_protocolPipeline');
const { convertMessagesAnthropicToOpenAI } = require('../../src/services/gateway/adapters/_toolSchemaConverter');

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// --------------------------------------------------------------------------
// A-layer: multimodal survival
// --------------------------------------------------------------------------

describe('A-layer multimodal fidelity', () => {
  test('OpenAI base64 image → Anthropic base64 source (no [Image] loss)', () => {
    const body = {
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
        ],
      }],
    };
    const out = converter.convertRequestBetween(body, PROTOCOLS.OPENAI, PROTOCOLS.ANTHROPIC);
    const blocks = out.messages[0].content;
    const img = blocks.find((b) => b.type === 'image');
    assert.ok(img, 'image block must survive');
    assert.equal(img.source.type, 'base64');
    assert.equal(img.source.media_type, 'image/png');
    assert.equal(img.source.data, PNG_B64);
  });

  test('Anthropic URL image → OpenAI image_url passthrough', () => {
    const body = {
      model: 'claude',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
        ],
      }],
    };
    const out = converter.convertRequestBetween(body, PROTOCOLS.ANTHROPIC, PROTOCOLS.OPENAI);
    const parts = out.messages[0].content;
    const img = parts.find((p) => p.type === 'image_url');
    assert.ok(img, 'image_url must survive');
    assert.equal(img.image_url.url, 'https://example.com/cat.png');
  });

  test('OpenAI image data URL → Anthropic → back to OpenAI round-trips', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }],
      }],
    };
    const anth = converter.convertRequestBetween(body, PROTOCOLS.OPENAI, PROTOCOLS.ANTHROPIC);
    const back = converter.convertRequestBetween(anth, PROTOCOLS.ANTHROPIC, PROTOCOLS.OPENAI);
    const img = back.messages[0].content.find((p) => p.type === 'image_url');
    assert.ok(img.image_url.url.startsWith('data:image/png;base64,'));
    assert.ok(img.image_url.url.includes(PNG_B64));
  });
});

// --------------------------------------------------------------------------
// A-layer: tool-call crash safety + parallel results + name backfill
// --------------------------------------------------------------------------

describe('A-layer tool-call fidelity', () => {
  test('malformed tool_call arguments survive as {_raw} (no throw)', () => {
    const body = {
      messages: [{
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'doit', arguments: '{not valid json' },
        }],
      }],
    };
    let canonical;
    assert.doesNotThrow(() => {
      canonical = converter.convertRequest(body, PROTOCOLS.OPENAI).canonical;
    });
    const msg = canonical.messages.find((m) => Array.isArray(m.toolCalls) && m.toolCalls.length);
    assert.ok(msg, 'tool call must be carried');
    assert.equal(msg.toolCalls[0].arguments._raw, '{not valid json');
  });

  test('parallel tool_results expand to one OpenAI tool message each', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'RA' },
          { type: 'tool_result', tool_use_id: 'b', content: 'RB' },
        ],
      }],
    };
    const out = converter.convertRequestBetween(body, PROTOCOLS.ANTHROPIC, PROTOCOLS.OPENAI);
    const toolMsgs = out.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 2);
    assert.deepEqual(
      toolMsgs.map((m) => [m.tool_call_id, m.content]),
      [['a', 'RA'], ['b', 'RB']],
    );
  });

  test('Anthropic tool_result name backfilled from prior tool_use', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'x1', name: 'search', input: { q: 'hi' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'done' }],
        },
      ],
    };
    const canonical = converter.convertRequest(body, PROTOCOLS.ANTHROPIC).canonical;
    const withResult = canonical.messages.find((m) => Array.isArray(m.toolResults) && m.toolResults.length);
    assert.ok(withResult);
    assert.equal(withResult.toolResults[0].name, 'search');
  });
});

// --------------------------------------------------------------------------
// A-layer: sampling / control param passthrough
// --------------------------------------------------------------------------

describe('A-layer sampling param passthrough', () => {
  test('OpenAI control params survive into canonical and back to OpenAI', () => {
    const body = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      top_p: 0.9,
      frequency_penalty: 0.5,
      presence_penalty: 0.2,
      seed: 7,
      response_format: { type: 'json_object' },
      reasoning_effort: 'high',
    };
    const out = converter.convertRequestBetween(body, PROTOCOLS.OPENAI, PROTOCOLS.OPENAI);
    assert.equal(out.top_p, 0.9);
    assert.equal(out.frequency_penalty, 0.5);
    assert.equal(out.presence_penalty, 0.2);
    assert.equal(out.seed, 7);
    assert.deepEqual(out.response_format, { type: 'json_object' });
    assert.equal(out.reasoning_effort, 'high');
  });

  test('Anthropic thinking + stop_sequences survive round-trip', () => {
    const body = {
      model: 'claude',
      messages: [{ role: 'user', content: 'hi' }],
      top_p: 0.8,
      stop_sequences: ['STOP'],
      thinking: { type: 'enabled', budget_tokens: 1024 },
    };
    const out = converter.convertRequestBetween(body, PROTOCOLS.ANTHROPIC, PROTOCOLS.ANTHROPIC);
    assert.equal(out.top_p, 0.8);
    assert.deepEqual(out.stop_sequences, ['STOP']);
    assert.deepEqual(out.thinking, { type: 'enabled', budget_tokens: 1024 });
  });

  test('OpenAI reasoning_effort maps to codex reasoning.effort', () => {
    const body = {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
    };
    const out = converter.convertRequestBetween(body, PROTOCOLS.OPENAI, PROTOCOLS.CODEX);
    assert.ok(out.reasoning, 'codex reasoning object expected');
    assert.equal(out.reasoning.effort, 'high');
  });
});

// --------------------------------------------------------------------------
// B-layer: handler sampling param passthrough
// --------------------------------------------------------------------------

describe('B-layer handler param passthrough', () => {
  test('OpenAI handler emits all control params + tool_choice', () => {
    const h = createProtocolHandler({ protocol: 'openai', adapterName: 'test' });
    const { body } = h.buildRequestBody('hi', {
      model: 'gpt-4o', stream: false, max_tokens: 100, temperature: 0.5,
      topP: 0.9, stopSequences: ['X'], frequencyPenalty: 0.5, presencePenalty: 0.2,
      seed: 7, responseFormat: { type: 'json_object' }, reasoningEffort: 'high',
      tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }],
      toolChoice: { type: 'tool', name: 'f' },
    });
    assert.equal(body.top_p, 0.9);
    assert.deepEqual(body.stop, ['X']);
    assert.equal(body.frequency_penalty, 0.5);
    assert.equal(body.presence_penalty, 0.2);
    assert.equal(body.seed, 7);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.reasoning_effort, 'high');
    assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'f' } });
  });

  test('Anthropic handler emits top_p, stop_sequences, thinking, tool_choice', () => {
    const h = createProtocolHandler({ protocol: 'anthropic', adapterName: 'test' });
    const { body } = h.buildRequestBody('hi', {
      model: 'claude', stream: false, max_tokens: 100,
      topP: 0.9, stopSequences: ['X'], thinking: { type: 'enabled', budget_tokens: 1024 },
      tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }],
      toolChoice: 'required',
    });
    assert.equal(body.top_p, 0.9);
    assert.deepEqual(body.stop_sequences, ['X']);
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 1024 });
    assert.deepEqual(body.tool_choice, { type: 'any' });
  });

  test('tool_choice is omitted when no tools are present', () => {
    const h = createProtocolHandler({ protocol: 'openai', adapterName: 'test' });
    const { body } = h.buildRequestBody('hi', {
      model: 'gpt-4o', stream: false, toolChoice: 'required',
    });
    assert.equal(body.tool_choice, undefined);
  });
});

// --------------------------------------------------------------------------
// B-layer: tool_result embedded image preservation
// --------------------------------------------------------------------------

describe('B-layer tool_result image fidelity', () => {
  test('embedded image relays as follow-up vision message (no [Image])', () => {
    const msgs = [{
      role: 'user',
      content: [{
        type: 'tool_result', tool_use_id: 't1', content: [
          { type: 'text', text: 'screenshot' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
        ],
      }],
    }];
    const out = convertMessagesAnthropicToOpenAI(msgs, true, { useToolRole: true });
    const toolMsg = out.find((m) => m.role === 'tool');
    assert.ok(toolMsg);
    assert.equal(toolMsg.content, 'screenshot');
    assert.ok(!JSON.stringify(out).includes('[Image]'), 'must not degrade to [Image]');
    const visionMsg = out.find((m) => m.role === 'user' && Array.isArray(m.content));
    assert.ok(visionMsg, 'vision follow-up message expected');
    const img = visionMsg.content.find((p) => p.type === 'image_url');
    assert.ok(img.image_url.url.includes(PNG_B64));
  });

  test('text-only tool_result stays a single tool message', () => {
    const msgs = [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'plain text' }],
    }];
    const out = convertMessagesAnthropicToOpenAI(msgs, true, { useToolRole: true });
    assert.equal(out.length, 1);
    assert.equal(out[0].role, 'tool');
    assert.equal(out[0].content, 'plain text');
  });
});
