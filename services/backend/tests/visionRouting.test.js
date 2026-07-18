'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { decideVisionRouting, _modelProviderPrefix } = require('../src/services/gateway/visionRouting');

const EMPTY_ENV = {};

test('无图片输入 → keep', () => {
  const d = decideVisionRouting({ hasImage: false, currentModel: 'deepseek-v4-flash', env: EMPTY_ENV });
  assert.strictEqual(d.action, 'keep');
  assert.strictEqual(d.reason, 'no_image_input');
});

test('当前模型已支持视觉 → keep（不改选）', () => {
  const d = decideVisionRouting({ hasImage: true, currentModel: 'gpt-4o', env: EMPTY_ENV });
  assert.strictEqual(d.action, 'keep');
  assert.strictEqual(d.reason, 'current_model_supports_vision');
});

test('纯文本模型 + 候选含视觉模型 → 改选该视觉候选', () => {
  const d = decideVisionRouting({
    hasImage: true,
    currentModel: 'sensenova-u1-fast',
    candidateModels: ['gpt-4o', 'deepseek-v4-flash', 'sensenova-u1-fast'],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d.action, 'switch-model');
  assert.strictEqual(d.model, 'gpt-4o');
  assert.strictEqual(d.reason, 'switched_to_vision_candidate');
});

// 回归锁:用户实测 flash-lite 不收图,SenseNova 通道已无视觉模型(flash-lite/flash-image/
// u1-fast 全判为纯文本)→ 带图请求必须确定性退回本地 OCR,绝不再把图发给假装能识图的模型。
test('SenseNova 通道(flash-lite 当前 + 兄弟全纯文本)带图 → 确定性 OCR 兜底', () => {
  const d = decideVisionRouting({
    hasImage: true,
    currentModel: 'sensenova-6.7-flash-lite',
    candidateModels: ['sensenova-6.7-flash-lite', 'sensenova-6.7-flash-image', 'sensenova-u1-fast', 'deepseek-v4-flash'],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d.action, 'ocr-fallback');
  assert.strictEqual(d.reason, 'no_vision_candidate_available');
});

test('纯文本模型 + 候选全为纯文本 → OCR 兜底', () => {
  const d = decideVisionRouting({
    hasImage: true,
    currentModel: 'deepseek-v4-flash',
    candidateModels: ['sensenova-u1-fast', 'deepseek-v4-flash'],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d.action, 'ocr-fallback');
  assert.strictEqual(d.reason, 'no_vision_candidate_available');
});

test('纯文本模型 + 无候选 → OCR 兜底', () => {
  const d = decideVisionRouting({
    hasImage: true,
    currentModel: 'deepseek-v4-flash',
    candidateModels: [],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d.action, 'ocr-fallback');
});

test('KHY_VISION_FALLBACK_MODEL 显式钉位优先于候选挑选', () => {
  const d = decideVisionRouting({
    hasImage: true,
    currentModel: 'sensenova-u1-fast',
    candidateModels: ['sensenova-6.7-flash-lite'],
    env: { KHY_VISION_FALLBACK_MODEL: 'gpt-4o' },
  });
  assert.strictEqual(d.action, 'switch-model');
  assert.strictEqual(d.model, 'gpt-4o');
  assert.strictEqual(d.reason, 'switched_to_pinned_vision_model');
});

test('跨 pool 钉位(relay/gpt-4o-mini)→ 切换并携带 poolHint=relay 供 aiGateway 重导端点', () => {
  const d = decideVisionRouting({
    hasImage: true,
    currentModel: 'sensenova-6.7-flash-lite',
    candidateModels: ['sensenova-6.7-flash-image', 'sensenova-u1-fast'],
    env: { KHY_VISION_FALLBACK_MODEL: 'relay/gpt-4o-mini' },
  });
  assert.strictEqual(d.action, 'switch-model');
  assert.strictEqual(d.model, 'relay/gpt-4o-mini');
  assert.strictEqual(d.reason, 'switched_to_pinned_vision_model');
  assert.strictEqual(d.poolHint, 'relay');
});

test('裸名钉位(gpt-4o)→ poolHint=null(默认同 pool,aiGateway 清空 scope 不钉回旧 pool)', () => {
  const d = decideVisionRouting({
    hasImage: true,
    currentModel: 'sensenova-6.7-flash-lite',
    candidateModels: [],
    env: { KHY_VISION_FALLBACK_MODEL: 'gpt-4o' },
  });
  assert.strictEqual(d.action, 'switch-model');
  assert.strictEqual(d.model, 'gpt-4o');
  assert.strictEqual(d.poolHint, null);
});

test('_modelProviderPrefix 解析各种带前缀形态', () => {
  assert.strictEqual(_modelProviderPrefix('relay/gpt-4o-mini'), 'relay');
  assert.strictEqual(_modelProviderPrefix('relay:gpt-4o-mini'), 'relay');
  assert.strictEqual(_modelProviderPrefix('api:relay:gpt-4o-mini'), 'relay');
  assert.strictEqual(_modelProviderPrefix('api/relay/gpt-4o-mini'), 'relay');
  assert.strictEqual(_modelProviderPrefix('gpt-4o'), null);
  assert.strictEqual(_modelProviderPrefix(''), null);
  assert.strictEqual(_modelProviderPrefix(null), null);
});

test('钉位模型本身非视觉 → 忽略钉位，回退候选挑选', () => {
  const d = decideVisionRouting({
    hasImage: true,
    currentModel: 'sensenova-u1-fast',
    candidateModels: ['gpt-4o'],
    env: { KHY_VISION_FALLBACK_MODEL: 'deepseek-v4-flash' },
  });
  assert.strictEqual(d.action, 'switch-model');
  assert.strictEqual(d.model, 'gpt-4o');
  assert.strictEqual(d.reason, 'switched_to_vision_candidate');
});

test('候选含当前模型自身 → 不会改选回自己', () => {
  const d = decideVisionRouting({
    hasImage: true,
    currentModel: 'deepseek-v4-flash',
    candidateModels: ['deepseek-v4-flash'],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d.action, 'ocr-fallback');
});

test('KHY_VISION_MODELS 注册自定义视觉模型后可被挑中', () => {
  const d = decideVisionRouting({
    hasImage: true,
    currentModel: 'deepseek-v4-flash',
    candidateModels: ['my-custom-text', 'my-custom-vis'],
    env: { KHY_VISION_MODELS: 'my-custom-vis' },
  });
  assert.strictEqual(d.action, 'switch-model');
  assert.strictEqual(d.model, 'my-custom-vis');
});

test('候选对象形态 {id} 也可被识别与挑选', () => {
  const d = decideVisionRouting({
    hasImage: true,
    currentModel: 'sensenova-u1-fast',
    candidateModels: [{ id: 'gpt-4o' }, { id: 'deepseek-v4-flash' }],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d.action, 'switch-model');
  assert.strictEqual(d.model, 'gpt-4o');
});
