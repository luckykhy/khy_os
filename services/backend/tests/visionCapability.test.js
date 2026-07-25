'use strict';

const test = require('node:test');
const assert = require('node:assert');

const vc = require('../src/services/gateway/visionCapability');

const EMPTY_ENV = {}; // no KHY_VISION_MODELS / KHY_TEXT_ONLY_MODELS

test('isVisionCapableModel: SenseNova 无可信赖的图像输入模型 → 一律非视觉(退回 OCR)', () => {
  // flash-lite 实测不收图像输入(带图它当作没收到、回「请上传图片」)→ 按纯文本处理。
  assert.strictEqual(vc.isVisionCapableModel('sensenova-6.7-flash-lite', { env: EMPTY_ENV }), false);
  // u1-fast 是信息图生成(独立端点、不收图)，必须判为非视觉，否则识图请求会 404。
  assert.strictEqual(vc.isVisionCapableModel('sensenova-u1-fast', { env: EMPTY_ENV }), false);
  // flash-image 名字带 image 会被启发式误判,BUILTIN_TEXT_ONLY_MODELS 必须把它纠正回纯文本。
  assert.strictEqual(vc.isVisionCapableModel('sensenova-6.7-flash-image', { env: EMPTY_ENV }), false);
  // deepseek-v4-flash 纯文本。
  assert.strictEqual(vc.isVisionCapableModel('deepseek-v4-flash', { env: EMPTY_ENV }), false);
});

test('isVisionCapableModel: BUILTIN_TEXT_ONLY 优先于名字启发式(image 片段不再误判)', () => {
  // 即便名字带 'image',内置纯文本集也把它判为非视觉(否则会把识图请求发给生成模型→404)。
  assert.strictEqual(vc.isVisionCapableModel('sensenova-6.7-flash-image', { env: EMPTY_ENV }), false);
  // 但 env KHY_VISION_MODELS 仍能强制覆盖(用户最高权限,日后确认可读图即可即时启用)。
  assert.strictEqual(
    vc.isVisionCapableModel('sensenova-6.7-flash-image', { env: { KHY_VISION_MODELS: 'sensenova-6.7-flash-image' } }),
    true,
  );
});

test('isVisionCapableModel: name heuristics catch common vision families', () => {
  for (const m of ['gpt-4o', 'gemini-2.0-flash', 'claude-3-5-sonnet', 'qwen2.5-vl-7b', 'pixtral-12b', 'llava-1.6']) {
    assert.strictEqual(vc.isVisionCapableModel(m, { env: EMPTY_ENV }), true, `${m} should be vision`);
  }
});

test('isVisionCapableModel: does not misfire on -v4 / version-like names', () => {
  assert.strictEqual(vc.isVisionCapableModel('deepseek-v4-flash', { env: EMPTY_ENV }), false);
  assert.strictEqual(vc.isVisionCapableModel('some-v2-model', { env: EMPTY_ENV }), false);
});

test('isVisionCapableModel: KHY_VISION_MODELS env adds vision models', () => {
  const env = { KHY_VISION_MODELS: 'deepseek-v4-flash, my-custom-vlm' };
  assert.strictEqual(vc.isVisionCapableModel('deepseek-v4-flash', { env }), true);
  assert.strictEqual(vc.isVisionCapableModel('my-custom-vlm', { env }), true);
});

test('isVisionCapableModel: KHY_TEXT_ONLY_MODELS overrides everything (highest priority)', () => {
  const env = { KHY_TEXT_ONLY_MODELS: 'sensenova-u1-fast, sensenova-6.7-flash-image' };
  // even builtin/image-named models forced back to text-only
  assert.strictEqual(vc.isVisionCapableModel('sensenova-u1-fast', { env }), false);
  assert.strictEqual(vc.isVisionCapableModel('sensenova-6.7-flash-image', { env }), false);
});

test('isVisionCapableModel: empty / nullish model is not vision', () => {
  assert.strictEqual(vc.isVisionCapableModel('', { env: EMPTY_ENV }), false);
  assert.strictEqual(vc.isVisionCapableModel(null, { env: EMPTY_ENV }), false);
  assert.strictEqual(vc.isVisionCapableModel(undefined, { env: EMPTY_ENV }), false);
});

test('pickVisionCandidate: picks first vision-capable in priority order', () => {
  // SenseNova 候选全是纯文本/生成型号 → 无视觉候选;经 env 显式声明的视觉型号才被选中。
  const cands = ['deepseek-v4-flash', 'sensenova-u1-fast', 'qwen2.5-vl-7b'];
  assert.strictEqual(vc.pickVisionCandidate(cands, { env: EMPTY_ENV }), 'qwen2.5-vl-7b');
});

test('pickVisionCandidate: supports object candidates and returns the original item', () => {
  const cands = [
    { id: 'sensenova-u1-fast', adapter: 'api' },
    { id: 'gpt-4o', adapter: 'api' },
  ];
  const picked = vc.pickVisionCandidate(cands, { env: EMPTY_ENV });
  assert.deepStrictEqual(picked, { id: 'gpt-4o', adapter: 'api' });
});

test('pickVisionCandidate: SenseNova-only 候选(全纯文本)→ null(交给 OCR 兜底)', () => {
  const cands = ['sensenova-6.7-flash-lite', 'sensenova-6.7-flash-image', 'sensenova-u1-fast', 'deepseek-v4-flash'];
  assert.strictEqual(vc.pickVisionCandidate(cands, { env: EMPTY_ENV }), null);
});

test('hasVisionCapableCandidate: false when all candidates are text-only', () => {
  const cands = ['sensenova-u1-fast', 'deepseek-v4-flash'];
  assert.strictEqual(vc.hasVisionCapableCandidate(cands, { env: EMPTY_ENV }), false);
  assert.strictEqual(vc.hasVisionCapableCandidate([], { env: EMPTY_ENV }), false);
  assert.strictEqual(vc.hasVisionCapableCandidate(null, { env: EMPTY_ENV }), false);
});

test('parseModelListEnv: splits on commas and whitespace, lowercases', () => {
  const set = vc.parseModelListEnv('A-Model, b-model\n c-model');
  assert.strictEqual(set.has('a-model'), true);
  assert.strictEqual(set.has('b-model'), true);
  assert.strictEqual(set.has('c-model'), true);
  assert.strictEqual(vc.parseModelListEnv('').size, 0);
  assert.strictEqual(vc.parseModelListEnv(null).size, 0);
});
