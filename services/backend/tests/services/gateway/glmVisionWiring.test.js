'use strict';
/**
 * glmVisionWiring.test.js �?GLM-4.6V-Flash 接入透明视觉路由 + 显式识图工具的接线测�?
 *
 * 覆盖 3 �?wiring 的可观测契约:
 *   2a visionCapability.isVisionCapableModel 门开�?glm-4.6v-flash 为视觉、门关回退 false;
 *   2b zhipuGlmModel.knownZhipuModels 门开�?glm-4.6v-flash、门关不�?既有清单);
 *   2c decideVisionRouting 收到 glm/ 前缀兜底 pin �?switch-model + poolHint='glm'
 *      + aiGateway 源码含「有 GLM key 才注�?pin / 门控 / 尊重用户 env」的分支;
 *   Part 3 RecognizeImage 工具:门控 isEnabled、execute 经注�?stub �?glm-4.6v-flash 调网关�?
 */
const fs = require('fs');
const path = require('path');
const visionCap = require('../../../src/services/gateway/visionCapability');
const { knownZhipuModels } = require('../../../src/services/zhipuGlmModel');
const { decideVisionRouting } = require('../../../src/services/gateway/visionRouting');
// ── 2a visionCapability ──────────────────────────────────────────────────────
// ── 2b model registration ────────────────────────────────────────────────────
// ── 2c decideVisionRouting honours the glm/ pinned fallback ───────────────────
// ── Part 3 RecognizeImage tool ───────────────────────────────────────────────
function loadTool() {
  const p = require.resolve('../../../src/tools/recognizeImage.js');
  delete require.cache[p];
  return require(p);
}

describe('Glm Vision Wiring', () => {
  test('2a: isVisionCapableModel(glm-4.6v-flash) true when gate on, false when off', async () => {
      expect(visionCap.isVisionCapableModel('glm-4.6v-flash', { env: {} })).toBe(true);
      assert.strictEqual(
        visionCap.isVisionCapableModel('glm-4.6v-flash', { env: { KHY_GLM_VISION_MODEL: '0' } }),
        false,
        'gate off �?byte-revert to false',
      );
      // �?provider 前缀也认(子串判定)
      expect(visionCap.isVisionCapableModel('zhipu/glm-4.6v-flash', { env: {} })).toBe(true);
      // 不误�?glm-4 世代
      expect(visionCap.isVisionCapableModel('glm-4', { env: {} })).toBe(false);
      expect(visionCap.isVisionCapableModel('glm-4-flash', { env: {} })).toBe(false);
  });

  test('2b: knownZhipuModels includes glm-4.6v-flash when latest gate on, not when off', async () => {
      expect(knownZhipuModels({}).includes('glm-4.6v-flash')).toBeTruthy();
      expect(!knownZhipuModels({ KHY_GLM_LATEST_MODEL: '0' }).includes('glm-4.6v-flash')).toBeTruthy();
      // 不影�?glm-5.2 默认打头
      expect(knownZhipuModels({})[0]).toBe('glm-5.2');
  });

  test('2c: decideVisionRouting with glm/ pinned fallback �?switch-model + poolHint glm', async () => {
      const decision = decideVisionRouting({
        hasImage: true,
        currentModel: 'deepseek-chat', // 纯文本模型带�?
        candidateModels: [],
        env: { KHY_VISION_FALLBACK_MODEL: 'glm/glm-4.6v-flash' },
      });
      expect(decision.action).toBe('switch-model');
      expect(decision.model).toBe('glm/glm-4.6v-flash');
      expect(decision.poolHint).toBe('glm');
      expect(decision.reason).toBe('switched_to_pinned_vision_model');
  });

  test('2c: aiGateway injects the GLM default fallback only under the honest guards', async () => {
      const src = fs.readFileSync(
        path.join(__dirname, '../../../src/services/gateway/aiGateway.js'), 'utf8');
      expect(/glmVisionModel/.test(src)).toBeTruthy();
      expect(/glmVisionFallbackPin/.test(src)).toBeTruthy();
      expect(/hasAvailableKeys\('glm'\)/.test(src)).toBeTruthy();
      expect(/KHY_VISION_FALLBACK_MODEL/.test(src).toBeTruthy() && /_routingEnv/.test(src),
        'respects user-set KHY_VISION_FALLBACK_MODEL and passes env to decideVisionRouting');
  });

  test('Part 3: RecognizeImage tool metadata + gating', async () => {
      const tool = loadTool();
      expect(tool.name).toBe('RecognizeImage');
      expect(tool.category).toBe('analysis');
      // isEnabled honours the gate
      const prev = process.env.KHY_GLM_VISION_MODEL;
      try {
        delete process.env.KHY_GLM_VISION_MODEL;
        expect(tool.isEnabled()).toBe(true, 'default-on �?enabled');
        process.env.KHY_GLM_VISION_MODEL = '0';
        expect(tool.isEnabled()).toBe(false, 'gate off �?tool disabled');
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
        expect(res.success).toBe(true);
        expect(res.text).toBe('a cat');
        expect(calls.length).toBe(1);
        expect(calls[0].model).toBe('glm/glm-4.6v-flash', 'default model pinned (KHY_RECOGNIZE_IMAGE_POOL_PIN, default-on)');
        expect(calls[0].image).toEqual({ url: 'https://example.com/cat.png' }, 'URL passed through');
        expect(calls[0].prompt && calls[0].prompt.length > 0).toBeTruthy();
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
        expect(calls[0].model).toBe('glm-4.6v-flash-pro');
        expect(calls[0].prompt).toBe('图里有几个人?');
        expect(calls[0].image).toEqual({ url: 'data:image/png;base64,AAAA' });
      } finally {
        impl.recognize = origRecognize;
      }
  });

  test('Part 3: execute reports honest error for a missing local path', async () => {
      const tool = loadTool();
      const res = await tool.execute({ image: '/nonexistent/path/to/definitely-not-here.png' });
      expect(res.success).toBe(false);
      expect(/不存在|failed|出错/.test(res.error)).toBeTruthy();
  });

});

