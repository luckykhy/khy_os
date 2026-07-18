'use strict';

/**
 * relayModelGuard.test.js — relay_api 通道外来模型防护(纯叶子)。
 *
 * 用户实测复现:选「auto」讲个笑话 → auto 选中 api/agnes(自定义 provider,经代理正确服务
 * agnes-2.0-flash)→ 通道降级 → 级联把 agnes-2.0-flash 带到 relay_api(直连 api.trae.ai)→
 * trae 不认识 agnes → 404 model_not_found → 缓存 cooldown。本套件锁死叶子契约:
 *   - isRelayServableModel:relay/trae 主流家族(claude/gpt/gemini/deepseek/glm/…)→ true;
 *     自定义 provider 模型(agnes-*)/垃圾/非字符串 → false;
 *   - 门控 KHY_RELAY_MODEL_GUARD 默认开,off 值(0/false/off/no)→ 关(调用方原样透传);
 *   - 绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  isEnabled,
  isRelayServableModel,
  describeRelayModelGuard,
} = require('../../../src/services/gateway/relayModelGuard');

test('gate default-on; CANON off values close it (byte-revert)', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_RELAY_MODEL_GUARD: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.strictEqual(isEnabled({ KHY_RELAY_MODEL_GUARD: v }), false, v);
  }
});

test('isRelayServableModel: relay/trae families → true', () => {
  for (const m of [
    'claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022', 'gpt-5.3-codex',
    'gpt-4o', 'gemini-2.5-flash', 'deepseek-chat', 'qwen-max', 'glm-4.6',
    'doubao-1.5-vision', 'kimi-k2', 'grok-4', 'sonnet', 'haiku', 'opus',
    'llama-4-scout', 'mistral-large', 'o3',
  ]) {
    assert.strictEqual(isRelayServableModel(m), true, m);
  }
});

test('isRelayServableModel: custom-provider (agnes-*) → false (the actual bug)', () => {
  assert.strictEqual(isRelayServableModel('agnes-2.0-flash'), false);
  assert.strictEqual(isRelayServableModel('agnes-image-2.1-flash'), false);
  assert.strictEqual(isRelayServableModel('agnes-video-v2.0'), false);
});

test('isRelayServableModel: junk / empty / non-string → false (never throws)', () => {
  for (const m of ['', '   ', 'totally-unknown-thing', null, undefined, 42, {}, []]) {
    assert.strictEqual(isRelayServableModel(m), false, String(m));
  }
  assert.doesNotThrow(() => isRelayServableModel());
});

test('describeRelayModelGuard: self-describing metadata', () => {
  const d = describeRelayModelGuard();
  assert.strictEqual(d.gate, 'KHY_RELAY_MODEL_GUARD');
  assert.strictEqual(d.defaultOn, true);
  assert.match(d.summary, /relay/i);
});
