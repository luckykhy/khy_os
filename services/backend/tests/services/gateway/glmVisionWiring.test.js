'use strict';

/**
 * glmVisionWiring.test.js — GLM-4.6V-Flash 接入透明视觉路由 + 显式识图工具的接线测。
 *
 * 覆盖 3 处 wiring 的可观测契约:
 *   2a visionCapability.isVisionCapableModel 门开认 glm-4.6v-flash 为视觉、门关回退 false;
 *   2b zhipuGlmModel.knownZhipuModels 门开含 glm-4.6v-flash、门关不含(既有清单);
 *   2c decideVisionRouting 收到 glm/ 前缀兜底 pin → switch-model + poolHint='glm'
 *      + aiGateway 源码含「有 GLM key 才注入 pin / 门控 / 尊重用户 env」的分支;
 *   Part 3 RecognizeImage 工具:门控 isEnabled、execute 经注入 stub 以 glm-4.6v-flash 调网关。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const visionCap = require('../../../src/services/gateway/visionCapability');
const { knownZhipuModels } = require('../../../src/services/zhipuGlmModel');
const { decideVisionRouting } = require('../../../src/services/gateway/visionRouting');

// ── 2a visionCapability ──────────────────────────────────────────────────────
test('2a: isVisionCapableModel(glm-4.6v-flash) true when gate on, false when off', () => {
  assert.strictEqual(visionCap.isVisionCapableModel('glm-4.6v-flash', { env: {} }), true);
  assert.strictEqual(
    visionCap.isVisionCapableModel('glm-4.6v-flash', { env: { KHY_GLM_VISION_MODEL: '0' } }),
    false,
    'gate off → byte-revert to false',
  );
  // 带 provider 前缀也认(子串判定)
  assert.strictEqual(visionCap.isVisionCapableModel('zhipu/glm-4.6v-flash', { env: {} }), true);
  // 不误伤 glm-4 世代
  assert.strictEqual(visionCap.isVisionCapableModel('glm-4', { env: {} }), false);
  assert.strictEqual(visionCap.isVisionCapableModel('glm-4-flash', { env: {} }), false);
});

// ── 2b model registration ────────────────────────────────────────────────────
test('2b: knownZhipuModels includes glm-4.6v-flash when latest gate on, not when off', () => {
  assert.ok(knownZhipuModels({}).includes('glm-4.6v-flash'), 'gate on → registered in pool list');
  assert.ok(!knownZhipuModels({ KHY_GLM_LATEST_MODEL: '0' }).includes('glm-4.6v-flash'), 'gate off → legacy list');
  // 不影响 glm-5.2 默认打头
  assert.strictEqual(knownZhipuModels({})[0], 'glm-5.2');
});

// ── 2c decideVisionRouting honours the glm/ pinned fallback ───────────────────
test('2c: decideVisionRouting with glm/ pinned fallback → switch-model + poolHint glm', () => {
  const decision = decideVisionRouting({
    hasImage: true,
    currentModel: 'deepseek-chat', // 纯文本模型带图
    candidateModels: [],
    env: { KHY_VISION_FALLBACK_MODEL: 'glm/glm-4.6v-flash' },
  });
  assert.strictEqual(decision.action, 'switch-model');
  assert.strictEqual(decision.model, 'glm/glm-4.6v-flash');
  assert.strictEqual(decision.poolHint, 'glm');
  assert.strictEqual(decision.reason, 'switched_to_pinned_vision_model');
});

test('2c: aiGateway injects the GLM default fallback only under the honest guards', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../../src/services/gateway/aiGateway.js'), 'utf8');
  assert.ok(/glmVisionModel/.test(src), 'aiGateway consults glmVisionModel leaf');
  assert.ok(/glmVisionFallbackPin/.test(src), 'uses the pinned fallback');
  assert.ok(/hasAvailableKeys\('glm'\)/.test(src), 'only when GLM key is available');
  assert.ok(/KHY_VISION_FALLBACK_MODEL/.test(src) && /_routingEnv/.test(src),
    'respects user-set KHY_VISION_FALLBACK_MODEL and passes env to decideVisionRouting');
});

// ── Part 3 RecognizeImage tool ───────────────────────────────────────────────
function loadTool() {
  const p = require.resolve('../../../src/tools/recognizeImage.js');
  delete require.cache[p];
  return require(p);
}

test('Part 3: RecognizeImage tool metadata + gating', () => {
  const tool = loadTool();
  assert.strictEqual(tool.name, 'RecognizeImage');
  assert.strictEqual(tool.category, 'analysis');
  // isEnabled honours the gate
  const prev = process.env.KHY_GLM_VISION_MODEL;
  try {
    delete process.env.KHY_GLM_VISION_MODEL;
    assert.strictEqual(tool.isEnabled(), true, 'default-on → enabled');
    process.env.KHY_GLM_VISION_MODEL = '0';
    assert.strictEqual(tool.isEnabled(), false, 'gate off → tool disabled');
  } finally {
    if (prev === undefined) delete process.env.KHY_GLM_VISION_MODEL;
    else process.env.KHY_GLM_VISION_MODEL = prev;
  }
});

test('Part 3: execute routes a remote-URL image to glm-4.6v-flash via injected stub', async () => {
  const tool = loadTool();
  const impl = globalThis[Symbol.for('khyos.recognizeImage.__impl')];
  const calls = [];
  const origRecognize = impl.recognize;
  impl.recognize = async (arg) => { calls.push(arg); return { success: true, text: 'a cat', model: arg.model }; };
  try {
    const res = await tool.execute({ image: 'https://example.com/cat.png' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.text, 'a cat');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].model, 'glm/glm-4.6v-flash', 'default model pinned (KHY_RECOGNIZE_IMAGE_POOL_PIN, default-on)');
    assert.deepStrictEqual(calls[0].image, { url: 'https://example.com/cat.png' }, 'URL passed through');
    assert.ok(calls[0].prompt && calls[0].prompt.length > 0, 'default prompt applied');
  } finally {
    impl.recognize = origRecognize;
  }
});

test('Part 3: execute honours explicit model override + custom prompt', async () => {
  const tool = loadTool();
  const impl = globalThis[Symbol.for('khyos.recognizeImage.__impl')];
  const calls = [];
  const origRecognize = impl.recognize;
  impl.recognize = async (arg) => { calls.push(arg); return { success: true, text: 'ok', model: arg.model }; };
  try {
    await tool.execute({ image: 'data:image/png;base64,AAAA', prompt: '图里有几个人?', model: 'glm-4.6v-flash-pro' });
    assert.strictEqual(calls[0].model, 'glm-4.6v-flash-pro');
    assert.strictEqual(calls[0].prompt, '图里有几个人?');
    assert.deepStrictEqual(calls[0].image, { url: 'data:image/png;base64,AAAA' });
  } finally {
    impl.recognize = origRecognize;
  }
});

test('Part 3: execute reports honest error for a missing local path', async () => {
  const tool = loadTool();
  const res = await tool.execute({ image: '/nonexistent/path/to/definitely-not-here.png' });
  assert.strictEqual(res.success, false);
  assert.ok(/不存在|failed|出错/.test(res.error), res.error);
});
