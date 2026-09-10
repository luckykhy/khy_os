// 流式 tool_call 累积逻辑测试
// 验证：OpenAI 流式返回的 tool_call delta 能被正确累积成完整 tool_call
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const readSrc = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('流式 tool_call 累积逻辑', () => {
  it('standalone.js 包含 toolCallAccumulator', () => {
    const src = readSrc('src/api/standalone.js');
    expect(src).toMatch(/toolCallAccumulator/);
    expect(src).toMatch(/new Map\(\)/);
  });

  it('累积逻辑按 index 合并 delta', () => {
    const src = readSrc('src/api/standalone.js');
    // 验证累积逻辑：按 delta.index 合并
    expect(src).toMatch(/delta\.index/);
    expect(src).toMatch(/existing\.function\.name \+= delta\.function\.name/);
    expect(src).toMatch(/existing\.function\.arguments \+= delta\.function\.arguments/);
  });

  it('finish_reason === tool_calls 时才提交完整 tool_call', () => {
    const src = readSrc('src/api/standalone.js');
    expect(src).toMatch(/finish_reason === 'tool_calls'/);
    // completeCalls 是从 toolCallAccumulator 生成的完整 tool_call 数组
    expect(src).toMatch(/Array\.from\(toolCallAccumulator\.entries\(\)\)/);
    expect(src).toMatch(/onToolCall\?/);
  });

  it('toOpenAiMessages 正确处理 tool 消息', () => {
    const src = readSrc('src/api/standalone.js');
    // tool 消息：role: 'tool', tool_call_id
    expect(src).toMatch(/role: 'tool', tool_call_id: item\.toolCallId/);
    // assistant 带 tool_calls
    expect(src).toMatch(/role: 'assistant'/);
    expect(src).toMatch(/tool_calls: item\.toolCalls\.map/);
  });
});

describe('模拟流式 tool_call 累积', () => {
  it('应正确累积多个 delta 为完整 tool_call', () => {
    // 模拟 standalone.js 中的累积逻辑
    const toolCallAccumulator = new Map();

    // 模拟 OpenAI 流式返回的 delta
    const deltas = [
      { index: 0, id: 'call_abc', type: 'function', function: { name: 'khy.local.', arguments: '' } },
      { index: 0, id: 'call_abc', type: 'function', function: { name: 'fileRead', arguments: '{"path":' } },
      { index: 0, id: 'call_abc', type: 'function', function: { name: '', arguments: '"notes/todo.txt"}' } },
    ];

    for (const delta of deltas) {
      const idx = delta.index ?? 0;
      const existing = toolCallAccumulator.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (delta.id) existing.id = delta.id;
      if (delta.type) existing.type = delta.type;
      if (delta.function?.name) existing.function.name += delta.function.name;
      if (delta.function?.arguments) existing.function.arguments += delta.function.arguments;
      toolCallAccumulator.set(idx, existing);
    }

    // 验证累积结果
    const completeCalls = Array.from(toolCallAccumulator.entries())
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => tc);

    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0].id).toBe('call_abc');
    expect(completeCalls[0].function.name).toBe('khy.local.fileRead');
    expect(completeCalls[0].function.arguments).toBe('{"path":"notes/todo.txt"}');

    // 验证 arguments 是合法 JSON
    const args = JSON.parse(completeCalls[0].function.arguments);
    expect(args.path).toBe('notes/todo.txt');
  });

  it('应正确处理多个并行 tool_call', () => {
    const toolCallAccumulator = new Map();

    // 两个并行的 tool_call
    const deltas = [
      { index: 0, id: 'call_1', type: 'function', function: { name: 'khy.local.fileList', arguments: '{}' } },
      { index: 1, id: 'call_2', type: 'function', function: { name: 'khy.local.calculator', arguments: '{"expression":"1+1"}' } },
    ];

    for (const delta of deltas) {
      const idx = delta.index ?? 0;
      const existing = toolCallAccumulator.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (delta.id) existing.id = delta.id;
      if (delta.type) existing.type = delta.type;
      if (delta.function?.name) existing.function.name += delta.function.name;
      if (delta.function?.arguments) existing.function.arguments += delta.function.arguments;
      toolCallAccumulator.set(idx, existing);
    }

    const completeCalls = Array.from(toolCallAccumulator.entries())
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => tc);

    expect(completeCalls).toHaveLength(2);
    expect(completeCalls[0].function.name).toBe('khy.local.fileList');
    expect(completeCalls[1].function.name).toBe('khy.local.calculator');
  });
});
