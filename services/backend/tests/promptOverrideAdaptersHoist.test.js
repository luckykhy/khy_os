'use strict';

/**
 * promptOverrideAdaptersHoist.test —— 「下游可能覆盖系统提示词」适配器判定
 * (Ch2「不要每轮重建可复用结构」;node:test)。
 *
 * _adapterMayOverridePromptDownstream 的 11 元素 Set 已从每调用现建提升为模块常量
 * _PROMPT_OVERRIDE_ADAPTERS。此提升是纯重构(逐字节等价行为、无门),本套件把成员契约钉死:
 * 防止意外增删名单,并确认判定大小写/空白不敏感、对非成员一律 false。
 */
const test = require('node:test');
const assert = require('node:assert');

const g = require('../src/services/gateway/aiGateway.js');
const f = g.__test__._adapterMayOverridePromptDownstream;

const RISKY = [
  'codex', 'claude', 'cursor', 'trae', 'windsurf',
  'vscode', 'warp', 'cursor2api', 'relay', 'clipboard', 'cli',
];

test('全部下游可覆盖提示词的适配器 → true', () => {
  for (const k of RISKY) assert.strictEqual(f(k), true, `${k} 应判定为 risky`);
});

test('非成员适配器 → false', () => {
  for (const k of ['api', 'openai', 'glm', 'deepseek', 'qwen', 'doubao', 'unknown']) {
    assert.strictEqual(f(k), false, `${k} 不应判定为 risky`);
  }
});

test('空/nullish 输入 → false(fail-soft)', () => {
  for (const k of ['', null, undefined]) {
    assert.strictEqual(f(k), false);
  }
});

test('判定大小写/首尾空白不敏感', () => {
  assert.strictEqual(f('CODEX'), true);
  assert.strictEqual(f('  Claude  '), true);
  assert.strictEqual(f('Cursor2Api'), true);
});
