'use strict';
/**
 * glmVisionApiPin 纯叶子测试(node:test)。
 * 覆盖:裸 id 剥前缀、GLM 视觉模型名匹配、门控三态、shouldPin 的与门短路语义。
 */
const pin = require('../gateway/glmVisionApiPin');

describe('Glm Vision Api Pin', () => {
  test('bareModelId 剥掉 provider 前缀并归一小写', () => {
      expect(pin.bareModelId('glm/glm-4.6v-flash')).toBe('glm-4.6v-flash');
      expect(pin.bareModelId('api:glm:glm-4.6v-flash')).toBe('glm-4.6v-flash');
      expect(pin.bareModelId('api/glm/glm-4v-flash')).toBe('glm-4v-flash');
      expect(pin.bareModelId('GLM-4.6V-Flash')).toBe('glm-4.6v-flash');
      expect(pin.bareModelId('glm-4v-flash')).toBe('glm-4v-flash');
      expect(pin.bareModelId('')).toBe('');
      expect(pin.bareModelId(null)).toBe('');
      expect(pin.bareModelId(undefined)).toBe('');
  });

  test('isGlmVisionModelName 命中降级链两成员且容忍前缀,非视觉/非-glm 不命中', () => {
      // 命中
      expect(pin.isGlmVisionModelName('glm-4.6v-flash')).toBe(true);
      expect(pin.isGlmVisionModelName('glm-4v-flash')).toBe(true);
      expect(pin.isGlmVisionModelName('glm/glm-4.6v-flash')).toBe(true);
      expect(pin.isGlmVisionModelName('api:glm:glm-4v-flash')).toBe(true);
      expect(pin.isGlmVisionModelName('glm-4.5v')).toBe(true);
      // 不命中:非视觉 GLM(无 v)、其它厂商、空
      expect(pin.isGlmVisionModelName('glm-4.6')).toBe(false);
      expect(pin.isGlmVisionModelName('glm-4-flash')).toBe(false);
      expect(pin.isGlmVisionModelName('gpt-4o')).toBe(false);
      expect(pin.isGlmVisionModelName('claude-opus-4-8')).toBe(false);
      expect(pin.isGlmVisionModelName('')).toBe(false);
  });

  test('apiPinEnabled 默认开;仅 0/false/off/no 关', () => {
      expect(pin.apiPinEnabled({})).toBe(true); // 缺省
      expect(pin.apiPinEnabled({ KHY_GLM_VISION_API_PIN: '' })).toBe(true); // 空串 → 默认开
      expect(pin.apiPinEnabled({ KHY_GLM_VISION_API_PIN: '1' })).toBe(true);
      expect(pin.apiPinEnabled({ KHY_GLM_VISION_API_PIN: 'on' })).toBe(true);
      for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False', ' no ']) {
        assert.strictEqual(
          pin.apiPinEnabled({ KHY_GLM_VISION_API_PIN: off }),
          false,
          `off word: ${off}`
        );
      }
  });

  test('shouldPinApiForGlmVision:全部前置满足 → true', () => {
      const env = { KHY_GLM_VISION_API_PIN: '1', KHY_GLM_VISION_MODEL: '1' };
      assert.strictEqual(
        pin.shouldPinApiForGlmVision({
          hasImage: true,
          model: 'glm/glm-4.6v-flash',
          hasGlmKey: true,
          env,
        }),
        true
      );
  });

  test('shouldPinApiForGlmVision:任一前置缺失 → false(与门短路)', () => {
      const env = { KHY_GLM_VISION_API_PIN: '1', KHY_GLM_VISION_MODEL: '1' };
      // 无图
      assert.strictEqual(
        pin.shouldPinApiForGlmVision({
          hasImage: false,
          model: 'glm-4.6v-flash',
          hasGlmKey: true,
          env,
        }),
        false
      );
      // 无 key
      assert.strictEqual(
        pin.shouldPinApiForGlmVision({
          hasImage: true,
          model: 'glm-4.6v-flash',
          hasGlmKey: false,
          env,
        }),
        false
      );
      // 非 GLM 视觉模型
      assert.strictEqual(
        pin.shouldPinApiForGlmVision({ hasImage: true, model: 'gpt-4o', hasGlmKey: true, env }),
        false
      );
      // 本门关
      assert.strictEqual(
        pin.shouldPinApiForGlmVision({
          hasImage: true,
          model: 'glm-4.6v-flash',
          hasGlmKey: true,
          env: { KHY_GLM_VISION_API_PIN: 'off', KHY_GLM_VISION_MODEL: '1' },
        }),
        false
      );
      // 空输入 → false(不抛)
      expect(pin.shouldPinApiForGlmVision()).toBe(false);
      expect(pin.shouldPinApiForGlmVision({})).toBe(false);
  });

  test('shouldPinApiForGlmVision:父门 KHY_GLM_VISION_MODEL 关 → false', () => {
      const env = { KHY_GLM_VISION_API_PIN: '1', KHY_GLM_VISION_MODEL: 'off' };
      assert.strictEqual(
        pin.shouldPinApiForGlmVision({
          hasImage: true,
          model: 'glm-4.6v-flash',
          hasGlmKey: true,
          env,
        }),
        false
      );
  });

});
