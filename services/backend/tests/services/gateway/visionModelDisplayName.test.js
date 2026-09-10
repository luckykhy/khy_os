'use strict';
/**
 * visionModelDisplayName.test.js �?视觉模型名「显示归一」去 provider 路由前缀(纯叶�?OPS-MAN-150)�?
 *
 * 锁死叶子契约:
 *   - �?KHY_VISION_MODEL_DISPLAY_NAME default-on;显式 0/false/off/no �?
 *   - 门开 �?去最后一�?'/' 前的 provider �?**保留大小�?*:
 *       `glm/glm-4.6v-flash` �?`glm-4.6v-flash`;`zhipu/GLM-4.6V` �?`GLM-4.6V`;
 *   - 无前缀 �?原样;门关 �?原样(逐字节回退,含前缀);
 *   - 前缀存在但去后为�?末尾�?'/')�?保守回退原样,绝不产出空名;
 *   - null/undefined/畸形入参不抛�?
 */
const {
  isVisionModelDisplayNameEnabled,
  toDisplayModelName,
  FLAG,
} = require('../../../src/services/gateway/visionModelDisplayName');

describe('Vision Model Display Name', () => {
  test('FLAG name is stable', () => {
      expect(FLAG).toBe('KHY_VISION_MODEL_DISPLAY_NAME');
  });

  test('gate default-on; off words close it', () => {
      expect(isVisionModelDisplayNameEnabled({})).toBe(true);
      expect(isVisionModelDisplayNameEnabled(undefined)).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No', 'FALSE']) {
        assert.strictEqual(
          isVisionModelDisplayNameEnabled({ KHY_VISION_MODEL_DISPLAY_NAME: v }),
          false,
          `off word ${v}`,
        );
      }
  });

  test('gate on �?strips provider prefix, preserves case', () => {
      expect(toDisplayModelName('glm/glm-4.6v-flash', {})).toBe('glm-4.6v-flash');
      expect(toDisplayModelName('zhipu/GLM-4.6V', {})).toBe('GLM-4.6V');
      // 多级前缀 �?只保留最后一�?�?_bareId lastIndexOf('/') 语义一�?�?
      expect(toDisplayModelName('a/b/Claude-Opus-4-6', {})).toBe('Claude-Opus-4-6');
  });

  test('gate on �?bare id (no prefix) returned unchanged, case preserved', () => {
      expect(toDisplayModelName('glm-4v-flash', {})).toBe('glm-4v-flash');
      expect(toDisplayModelName('gpt-5.3-codex-review', {})).toBe('gpt-5.3-codex-review');
      expect(toDisplayModelName('Claude-Opus-4-6', {})).toBe('Claude-Opus-4-6');
  });

  test('gate OFF �?byte-revert (prefix preserved verbatim)', () => {
      const env = { KHY_VISION_MODEL_DISPLAY_NAME: 'off' };
      expect(toDisplayModelName('glm/glm-4.6v-flash', env)).toBe('glm/glm-4.6v-flash');
      expect(toDisplayModelName('zhipu/GLM-4.6V', env)).toBe('zhipu/GLM-4.6V');
      expect(toDisplayModelName('glm-4v-flash', env)).toBe('glm-4v-flash');
  });

  test('trailing-slash prefix �?conservative fallback to original (never empty)', () => {
      expect(toDisplayModelName('glm/', {})).toBe('glm/');
  });

  test('null / undefined / malformed inputs never throw', () => {
      expect(() => toDisplayModelName().not.toThrow());
      expect(() => toDisplayModelName(null, {}).not.toThrow());
      expect(() => toDisplayModelName(undefined, null).not.toThrow());
      expect(() => toDisplayModelName(123, {}).not.toThrow());
      expect(() => isVisionModelDisplayNameEnabled(null).not.toThrow());
      // null �?空串(�?String(model==null?'':...) 一�?,不抛�?
      expect(toDisplayModelName(null, {})).toBe('');
      expect(toDisplayModelName(undefined, {})).toBe('');
  });

  test('whitespace-only / empty �?returned as-is (no crash)', () => {
      expect(toDisplayModelName('', {})).toBe('');
      // 纯空�?trim 后为�?�?保守回退原始 raw�?
      expect(toDisplayModelName('   ', {})).toBe('   ');
  });

});

