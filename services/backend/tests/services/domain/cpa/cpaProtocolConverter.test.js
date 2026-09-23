'use strict';
/**
 * cpaProtocolConverter — 协议转换纯函数契约测试（DESIGN-CPA-002 P1）。
 *
 * Run: node --test services/backend/tests/services/domain/cpa/cpaProtocolConverter.test.js
 *
 * 契约（纯函数、无 IO、不可转换输入返回 null）：
 *   - anthropicToOpenaiRequest：system(字符串/block 数组) → system 消息前置；
 *     文本/图片 block → content 数组（data URL）；tool_use → tool_calls；
 *     tool_result → tool 消息；tools 定义 → OpenAI tools（input_schema→parameters）
 *   - openaiToAnthropicResponse：finish_reason stop/length/tool_calls →
 *     end_turn/max_tokens/tool_use；usage 映射 input_tokens/output_tokens；
 *     tool_calls → tool_use block
 *   - geminiToOpenaiRequest：systemInstruction → system；contents/parts（text/inlineData）
 *     → messages；functionCall → tool_calls；generationConfig 映射
 *   - openaiToGeminiResponse：finish_reason → finishReason（STOP/MAX_TOKENS）；
 *     usage → usageMetadata；content → candidates[0]
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const cvt = require('../../../../src/services/domain/cpa/cpaProtocolConverter.js');

test('C1 anthropic 请求 → OpenAI：system 字符串 + 文本消息', () => {
  const body = cvt.anthropicToOpenaiRequest({
    model: 'claude-sonnet-4-5',
    max_tokens: 512,
    system: 'be brief',
    messages: [{ role: 'user', content: 'hello' }]
  });
  assert.equal(body.model, 'claude-sonnet-4-5');
  assert.equal(body.max_tokens, 512);
  assert.deepEqual(
    body.messages.map((m) => m.role),
    ['system', 'user']
  );
  assert.equal(body.messages[0].content, 'be brief');
  assert.equal(body.messages[1].content, 'hello');
});

test('C2 anthropic 请求 → OpenAI：system block 数组 + 图片 block（data URL）', () => {
  const b64 = Buffer.from('fake-image-bytes').toString('base64');
  const body = cvt.anthropicToOpenaiRequest({
    model: 'claude-sonnet-4-5',
    max_tokens: 64,
    system: [{ type: 'text', text: 'part-1' }, { type: 'text', text: 'part-2' }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }
        ]
      }
    ]
  });
  const sys = body.messages.find((m) => m.role === 'system');
  assert.ok(String(sys.content).includes('part-1') && String(sys.content).includes('part-2'), 'system block 数组拼接');
  const user = body.messages.find((m) => m.role === 'user');
  assert.ok(Array.isArray(user.content), '多模态消息 → content 数组');
  const img = user.content.find((p) => p.type === 'image_url');
  assert.ok(img, '图片 block → image_url part');
  assert.ok(img.image_url.url.startsWith('data:image/png;base64,'), 'base64 图片 → data URL');
});

test('C3 anthropic 请求 → OpenAI：tool_use / tool_result / tools 定义映射', () => {
  const body = cvt.anthropicToOpenaiRequest({
    model: 'claude-sonnet-4-5',
    max_tokens: 128,
    tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: 'weather in paris' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'paris' } }
        ]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'sunny' }]
      }
    ]
  });
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].function.name, 'get_weather');
  assert.deepEqual(body.tools[0].function.parameters, { type: 'object', properties: { city: { type: 'string' } } }, 'input_schema → parameters');
  const asst = body.messages.find((m) => m.role === 'assistant');
  assert.ok(asst.tool_calls && asst.tool_calls.length === 1, 'tool_use block → tool_calls');
  assert.equal(asst.tool_calls[0].function.name, 'get_weather');
  assert.equal(asst.tool_calls[0].function.arguments, JSON.stringify({ city: 'paris' }), 'input → arguments(JSON 字符串)');
  const toolMsg = body.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'tu_1', 'tool_result → tool 消息');
  assert.equal(toolMsg.content, 'sunny');
});

test('C4 anthropic 请求 → OpenAI：thinking block 丢弃（OpenAI 无对应物，不静默变形）', () => {
  const body = cvt.anthropicToOpenaiRequest({
    model: 'claude-sonnet-4-5',
    max_tokens: 64,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'internal' }, { type: 'text', text: 'answer' }]
      }
    ]
  });
  const asst = body.messages.find((m) => m.role === 'assistant');
  assert.equal(asst.content, 'answer', 'thinking block 丢弃、text 保留');
});

test('C5 openai 响应 → anthropic：finish_reason 三态 + usage 映射', () => {
  const stop = cvt.openaiToAnthropicResponse({
    id: 'x', model: 'claude-sonnet-4-5',
    choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 9 }
  });
  assert.equal(stop.type, 'message');
  assert.equal(stop.role, 'assistant');
  assert.equal(stop.stop_reason, 'end_turn');
  assert.equal(stop.usage.input_tokens, 7);
  assert.equal(stop.usage.output_tokens, 9);

  const len = cvt.openaiToAnthropicResponse({
    choices: [{ message: { content: 'trunc' }, finish_reason: 'length' }], usage: {}
  });
  assert.equal(len.stop_reason, 'max_tokens');

  const tool = cvt.openaiToAnthropicResponse({
    choices: [{
      message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"rome"}' } }] },
      finish_reason: 'tool_calls'
    }], usage: {}
  });
  assert.equal(tool.stop_reason, 'tool_use');
  assert.equal(tool.content.length, 1);
  assert.equal(tool.content[0].type, 'tool_use');
  assert.equal(tool.content[0].name, 'get_weather');
  assert.deepEqual(tool.content[0].input, { city: 'rome' }, 'arguments 字符串 → input 对象');
});

test('C6 openai 响应 → anthropic：无 choices / 空响应 → null（不可转换不造假）', () => {
  assert.equal(cvt.openaiToAnthropicResponse(null), null);
  assert.equal(cvt.openaiToAnthropicResponse({ choices: [] }), null);
});

test('C7 gemini 请求 → OpenAI：systemInstruction + text/inlineData parts + generationConfig', () => {
  const b64 = Buffer.from('png-bytes').toString('base64');
  const body = cvt.geminiToOpenaiRequest({
    model: 'gemini-2.5-pro',
    systemInstruction: { parts: [{ text: 'sys' }] },
    contents: [
      { role: 'user', parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/png', data: b64 } }] },
      { role: 'model', parts: [{ text: 'prev' }] }
    ],
    generationConfig: { temperature: 0.5, maxOutputTokens: 100 }
  });
  assert.equal(body.model, 'gemini-2.5-pro');
  assert.equal(body.temperature, 0.5);
  assert.equal(body.max_tokens, 100, 'maxOutputTokens → max_tokens');
  const roles = body.messages.map((m) => m.role);
  assert.ok(roles.includes('system') && roles.includes('assistant') && roles.includes('user'), 'role 映射 model→assistant');
  const user = body.messages.find((m) => m.role === 'user');
  const img = user.content.find((p) => p.type === 'image_url');
  assert.ok(img.image_url.url.startsWith('data:image/png;base64,'));
});

test('C8 gemini 请求 → OpenAI：functionCall part → tool_calls', () => {
  const body = cvt.geminiToOpenaiRequest({
    model: 'gemini-2.5-pro',
    contents: [
      { role: 'user', parts: [{ text: 'w?' }] },
      { role: 'model', parts: [{ functionCall: { id: 'fc1', name: 'get_weather', args: { city: 'oslo' } } }] }
    ]
  });
  const asst = body.messages.find((m) => m.role === 'assistant');
  assert.ok(asst.tool_calls && asst.tool_calls[0].function.name === 'get_weather');
});

test('C9 openai 响应 → gemini：finishReason + usageMetadata 映射', () => {
  const r = cvt.openaiToGeminiResponse({
    model: 'gemini-2.5-pro',
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }
  });
  assert.equal(r.candidates[0].content.parts[0].text, 'ok');
  assert.equal(r.candidates[0].finishReason, 'STOP');
  assert.equal(r.usageMetadata.promptTokenCount, 4);
  assert.equal(r.usageMetadata.candidatesTokenCount, 6);
  assert.equal(r.usageMetadata.totalTokenCount, 10);
  const mx = cvt.openaiToGeminiResponse({
    choices: [{ message: { content: 'x' }, finish_reason: 'length' }], usage: {}
  });
  assert.equal(mx.candidates[0].finishReason, 'MAX_TOKENS');
});

test('C10 边界：null / 非对象输入 → 一律 null（fail-soft 不抛）', () => {
  assert.equal(cvt.anthropicToOpenaiRequest(null), null);
  assert.equal(cvt.anthropicToOpenaiRequest('garbage'), null);
  assert.equal(cvt.geminiToOpenaiRequest({}), null);
  assert.equal(cvt.openaiToGeminiResponse({}), null);
});

test('C11 纯模块独立性：converter 无 IO 依赖，可被任意进程独立 require', () => {
  const fresh = require('../../../../src/services/domain/cpa/cpaProtocolConverter.js');
  assert.equal(typeof fresh.anthropicToOpenaiRequest, 'function');
  assert.equal(typeof fresh.openaiToGeminiResponse, 'function');
});
