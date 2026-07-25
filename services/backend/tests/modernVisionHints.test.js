'use strict';

/**
 * modernVisionHints.test.js — 纯叶子契约 + visionCapability 接线:当代原生多模态模型族的名字
 * 提示扩展(修「llama-4/gpt-4.1/glm-4.5v/grok-4/nova-* 等被误判纯文本→无谓退回 OCR」)。
 *
 * 覆盖:门控(CANON 回退)、isModernVisionModel 命中族/不命中纯文本/provider 前缀/大小写、
 * matchedModernVisionHint、fail-soft;visionCapability.isVisionCapableModel 接线(ON 认这些族、
 * OFF 逐字节回退)、不回归既有判定(deepseek 纯文本、gpt-4o 仍视觉、sensenova 图生成仍纯文本)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/gateway/modernVisionHints'));
const vc = require(path.join(__dirname, '../src/services/gateway/visionCapability'));

const ON = {};
const OFF = { KHY_MODERN_VISION_HINTS: '0' };

test('modernVisionHintsEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.modernVisionHintsEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(leaf.modernVisionHintsEnabled({ KHY_MODERN_VISION_HINTS: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.modernVisionHintsEnabled({ KHY_MODERN_VISION_HINTS: 'disable' }), true); // 非 CANON → 开
});

test('isModernVisionModel: hits modern multimodal families', () => {
  for (const m of ['llama-4-scout', 'llama-4-maverick', 'gpt-4.1', 'gpt-4.1-mini',
    'gpt-5', 'grok-4', 'grok-4-fast', 'glm-4.5v', 'nova-lite', 'nova-pro',
    'gemma-3-27b', 'mistral-small-3.1', 'phi-4-multimodal', 'doubao-1.5-vision-pro']) {
    assert.strictEqual(leaf.isModernVisionModel(m, ON), true, `should be vision: ${m}`);
  }
});

test('isModernVisionModel: does NOT hit text-only lookalikes', () => {
  for (const m of ['deepseek-v4', 'llama-3-70b', 'gpt-4', 'gpt-3.5-turbo',
    'gemma-2-9b', 'mistral-small', 'qwen2.5-7b', 'doubao-lite']) {
    assert.strictEqual(leaf.isModernVisionModel(m, ON), false, `should NOT be vision: ${m}`);
  }
});

test('isModernVisionModel: tolerates provider prefix + case', () => {
  assert.strictEqual(leaf.isModernVisionModel('openrouter/meta-llama/llama-4-scout', ON), true);
  assert.strictEqual(leaf.isModernVisionModel('GPT-4.1-MINI', ON), true);
});

test('isModernVisionModel: gate OFF → always false (byte-revert)', () => {
  assert.strictEqual(leaf.isModernVisionModel('llama-4-scout', OFF), false);
  assert.strictEqual(leaf.isModernVisionModel('gpt-4.1', OFF), false);
});

test('matchedModernVisionHint: returns the fragment / null', () => {
  assert.strictEqual(leaf.matchedModernVisionHint('llama-4-scout', ON), 'llama-4');
  assert.strictEqual(leaf.matchedModernVisionHint('deepseek-v4', ON), null);
  assert.strictEqual(leaf.matchedModernVisionHint('llama-4-scout', OFF), null);
});

test('isModernVisionModel: fail-soft on null/empty', () => {
  assert.strictEqual(leaf.isModernVisionModel(null, ON), false);
  assert.strictEqual(leaf.isModernVisionModel('', ON), false);
});

// ── visionCapability 接线 ──────────────────────────────────────────────────────
test('visionCapability: ON → recognizes modern families as vision-capable', () => {
  for (const m of ['llama-4-scout', 'gpt-4.1', 'glm-4.5v', 'grok-4', 'nova-pro']) {
    assert.strictEqual(vc.isVisionCapableModel(m, { env: ON }), true, `vision: ${m}`);
  }
});

test('visionCapability: OFF → modern families byte-revert (llama-4/gpt-4.1 → false)', () => {
  assert.strictEqual(vc.isVisionCapableModel('llama-4-scout', { env: OFF }), false);
  assert.strictEqual(vc.isVisionCapableModel('gpt-4.1', { env: OFF }), false);
  assert.strictEqual(vc.isVisionCapableModel('glm-4.5v', { env: OFF }), false);
});

test('visionCapability: no regression to existing verdicts (ON)', () => {
  // 既有视觉判定不变
  assert.strictEqual(vc.isVisionCapableModel('gpt-4o', { env: ON }), true);
  assert.strictEqual(vc.isVisionCapableModel('qwen2.5-vl', { env: ON }), true);
  // 既有纯文本判定不变
  assert.strictEqual(vc.isVisionCapableModel('deepseek-v4', { env: ON }), false);
  // KHY_TEXT_ONLY_MODELS 优先级最高:即便命中 modern 片段也被纠正回纯文本
  assert.strictEqual(
    vc.isVisionCapableModel('gpt-4.1', { env: { ...ON, KHY_TEXT_ONLY_MODELS: 'gpt-4.1' } }),
    false,
  );
});
