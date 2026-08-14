'use strict';

/**
 * inferProtocolFromModelHoist.test —— 模型名 → 协议提示推断
 * (Ch2「不要每轮重建可复用结构」;node:test)。
 *
 * inferProtocolFromModel 的前缀→协议对已从每调用 Object.entries(MODEL_PROTOCOL_HINTS) 现建
 * 提升为模块常量 _MODEL_PROTOCOL_HINT_ENTRIES。此提升是纯重构(逐字节等价、无门),本套件把
 * 推断契约钉死:各厂商前缀→正确协议、大小写不敏感、非命中/无效输入 → null。
 */
const test = require('node:test');
const assert = require('node:assert');

const r = require('../src/services/gateway/adapters/_protocolRegistry.js');
const f = r.inferProtocolFromModel;
const P = r.PROTOCOLS;

test('各厂商前缀映射到正确协议', () => {
  const cases = [
    ['claude-sonnet-4-6', P.ANTHROPIC],
    ['claude3-opus', P.ANTHROPIC],
    ['gpt-4o', P.OPENAI],
    ['o4-preview', P.OPENAI],
    ['o3-mini', P.OPENAI],
    ['o1-preview', P.OPENAI],
    ['gemini-1.5', P.OPENAI],
    ['deepseek-v3', P.OPENAI],
    ['deepseek_chat', P.OPENAI],
    ['qwen-max', P.OPENAI],
    ['glm-4.7-flash', P.OPENAI],
    ['yi-large', P.OPENAI],
    ['mistral-large', P.OPENAI],
    ['codex-mini', P.CODEX],
  ];
  for (const [model, expected] of cases) {
    assert.strictEqual(f(model), expected, `${model} → ${expected}`);
  }
});

test('大小写不敏感', () => {
  assert.strictEqual(f('CLAUDE-sonnet'), P.ANTHROPIC);
  assert.strictEqual(f('GPT-4o'), P.OPENAI);
  assert.strictEqual(f('GLM-4.7'), P.OPENAI);
});

test('非命中前缀 → null', () => {
  for (const m of ['unknown-model', 'llama-3', 'random', 'x']) {
    assert.strictEqual(f(m), null, `${m} 应无强提示`);
  }
});

test('无效输入 → null(fail-soft)', () => {
  for (const m of ['', null, undefined, 42, {}, []]) {
    assert.strictEqual(f(m), null);
  }
});
