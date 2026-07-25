'use strict';

/**
 * glmVisionModel.test.js — GLM 图像识别模型视觉行为 SSoT(纯叶子)。
 *
 * 「文本模型看不了图 → 路由到 GLM-4.6V-Flash 再返回」落地的第一块。本套件锁死叶子契约:
 *   - 开门(default)→ 认 glm-4.6v-flash(含带 provider 前缀)为视觉模型、给出兜底 pin、清单含它;
 *   - 关门(0/false/off/no)→ 逐字节回退(isGlmVisionModel 恒 false、pin/modelId 空、清单空);
 *   - 绝不抛(junk env / null / 非字符串 model)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  GLM_VISION_MODEL_ID,
  GLM_VISION_SECONDARY_ID,
  GLM_VISION_FALLBACK_PIN,
  GLM_VISION_FALLBACK_IDS,
  glmVisionEnabled,
  glmVisionModelId,
  glmVisionFallbackPin,
  glmVisionCandidatePins,
  isGlmVisionModel,
  builtinVisionModelIds,
} = require('../../../src/services/gateway/glmVisionModel');

test('constants match the documented GLM vision id + pin', () => {
  assert.strictEqual(GLM_VISION_MODEL_ID, 'glm-4.6v-flash');
  assert.strictEqual(GLM_VISION_FALLBACK_PIN, 'glm/glm-4.6v-flash');
});

test('degradation chain: secondary id + ordered fallback list (new-flagship → battle-tested free)', () => {
  assert.strictEqual(GLM_VISION_SECONDARY_ID, 'glm-4v-flash');
  assert.deepStrictEqual(GLM_VISION_FALLBACK_IDS, ['glm-4.6v-flash', 'glm-4v-flash']);
});

test('glmVisionCandidatePins default-on → ordered {model,poolHint} pins for the whole chain', () => {
  assert.deepStrictEqual(glmVisionCandidatePins({}), [
    { model: 'glm-4.6v-flash', poolHint: 'glm' },
    { model: 'glm-4v-flash', poolHint: 'glm' },
  ]);
});

test('glmVisionCandidatePins gate-off → [] (byte-revert: no GLM cascade candidates)', () => {
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.deepStrictEqual(glmVisionCandidatePins({ KHY_GLM_VISION_MODEL: v }), [], v);
  }
});

test('glmVisionCandidatePins returns a fresh array/objects (caller mutation isolated)', () => {
  const a = glmVisionCandidatePins({});
  a.push({ model: 'mutant', poolHint: 'x' });
  a[0].model = 'tampered';
  const b = glmVisionCandidatePins({});
  assert.strictEqual(b.length, 2);
  assert.strictEqual(b[0].model, 'glm-4.6v-flash');
});

test('gate default-on', () => {
  assert.strictEqual(glmVisionEnabled({}), true);
  assert.strictEqual(glmVisionEnabled({ KHY_GLM_VISION_MODEL: '1' }), true);
  assert.strictEqual(glmVisionEnabled({ KHY_GLM_VISION_MODEL: 'on' }), true);
});

test('gate off (0/false/off/no, case/space-insensitive) → all byte-revert', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
    const env = { KHY_GLM_VISION_MODEL: v };
    assert.strictEqual(glmVisionEnabled(env), false, v);
    assert.strictEqual(glmVisionModelId(env), '', v);
    assert.strictEqual(glmVisionFallbackPin(env), '', v);
    assert.strictEqual(isGlmVisionModel('glm-4.6v-flash', env), false, v);
    assert.deepStrictEqual(builtinVisionModelIds(env), [], v);
  }
});

test('isGlmVisionModel matches glm-4.6v-flash and provider-prefixed forms (gate on)', () => {
  for (const m of ['glm-4.6v-flash', 'GLM-4.6V-Flash', 'zhipu/glm-4.6v-flash', 'glm/glm-4.6v-flash', ' glm-4.6v-flash ']) {
    assert.strictEqual(isGlmVisionModel(m, {}), true, m);
  }
});

test('isGlmVisionModel does NOT match text models or the glm-4v generation', () => {
  // glm-4v-flash 刻意不命中本叶子的 glm-4.6v 锚点(以免误伤 glm-4v-plus 等);它的视觉判定
  // 由 visionCapability 既有 'glm-4v' 名字提示词负责,二者边界不重叠。
  for (const m of ['glm-4', 'glm-4-flash', 'glm-4-air', 'glm-5.2', 'glm-4v-plus', 'glm-4v-flash', 'deepseek-v4', 'gpt-4o', '', null, undefined]) {
    assert.strictEqual(isGlmVisionModel(m, {}), false, String(m));
  }
});

test('glmVisionModelId / glmVisionFallbackPin / builtinVisionModelIds default-on', () => {
  assert.strictEqual(glmVisionModelId({}), 'glm-4.6v-flash');
  assert.strictEqual(glmVisionFallbackPin({}), 'glm/glm-4.6v-flash');
  assert.deepStrictEqual(builtinVisionModelIds({}), ['glm-4.6v-flash']);
});

test('builtinVisionModelIds returns a fresh copy (caller mutation isolated)', () => {
  const a = builtinVisionModelIds({});
  a.push('mutant');
  assert.ok(!builtinVisionModelIds({}).includes('mutant'));
});

test('never throws on junk env / non-string model', () => {
  assert.doesNotThrow(() => glmVisionEnabled(null));
  assert.doesNotThrow(() => glmVisionEnabled(undefined));
  assert.doesNotThrow(() => isGlmVisionModel({}, { KHY_GLM_VISION_MODEL: {} }));
  assert.doesNotThrow(() => isGlmVisionModel(12345, {}));
  assert.doesNotThrow(() => builtinVisionModelIds(null));
  assert.strictEqual(isGlmVisionModel(12345, {}), false);
});
