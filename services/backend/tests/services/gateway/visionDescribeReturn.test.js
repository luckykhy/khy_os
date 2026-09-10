'use strict';
/**
 * visionDescribeReturn.test.js — 「describe-and-return」纯叶子契约 SSoT。
 *
 * 用户诉求:纯文本模型收图时,视觉模型应**描述图片并回传原文本模型作答**,而非
 * switch 替换直接接管。本套件锁死叶子的纯部分:
 *   - 门控默认开;关(0/false/off/no,大小写/空格不敏感)→ 逐字节回退(false);
 *   - buildDescribePrompt 产「只描述、不作答」中性指令(逐字抄录文字);
 *   - buildDescriptionInjection 含来源模型名 + 描述;空输入 → 空串(供调用方回退);
 *   - 绝不抛(null / 非字符串 / junk env)。
 */
const {
  isVisionDescribeReturnEnabled,
  buildDescribePrompt,
  buildDescriptionInjection,
} = require('../../../src/services/gateway/visionDescribeReturn');

describe('Vision Describe Return', () => {
  test('gate default-on', () => {
      expect(isVisionDescribeReturnEnabled({})).toBe(true);
      expect(isVisionDescribeReturnEnabled(undefined)).toBe(true);
      expect(isVisionDescribeReturnEnabled({ KHY_VISION_DESCRIBE_RETURN: '1' })).toBe(true);
      expect(isVisionDescribeReturnEnabled({ KHY_VISION_DESCRIBE_RETURN: 'on' })).toBe(true);
      expect(isVisionDescribeReturnEnabled({ KHY_VISION_DESCRIBE_RETURN: 'true' })).toBe(true);
  });

  test('gate off — CANON off-words (case/space-insensitive)', () => {
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'False']) {
        assert.strictEqual(
          isVisionDescribeReturnEnabled({ KHY_VISION_DESCRIBE_RETURN: v }),
          false,
          `expected off for ${JSON.stringify(v)}`,
        );
      }
  });

  test('gate never throws on junk env', () => {
      expect(isVisionDescribeReturnEnabled({ KHY_VISION_DESCRIBE_RETURN: 123 })).toBe(true);
      expect(isVisionDescribeReturnEnabled({ KHY_VISION_DESCRIBE_RETURN: {} })).toBe(true);
      expect(isVisionDescribeReturnEnabled({ KHY_VISION_DESCRIBE_RETURN: null })).toBe(true);
  });

  test('buildDescribePrompt is a neutral describe-only instruction', () => {
      const p = buildDescribePrompt();
      expect(typeof p === 'string' && p.length > 0).toBeTruthy();
      // 只描述、不作答的核心约束
      expect(/描述/.test(p)).toBeTruthy();
      expect(/逐字/.test(p)).toBeTruthy();
      expect(/不要.*回答|不要.*提问|不要评价/.test(p)).toBeTruthy();
  });

  test('buildDescriptionInjection includes source model name and description', () => {
      const out = buildDescriptionInjection(['一张登录页截图,标题「Sign in」'], { model: 'glm/glm-4.6v-flash' });
      expect(out.includes('glm/glm-4.6v-flash')).toBeTruthy();
      expect(out.includes('据此作答')).toBeTruthy();
      expect(out.includes('Sign in')).toBeTruthy();
  });

  test('buildDescriptionInjection without model still labels source', () => {
      const out = buildDescriptionInjection(['内容 X'], {});
      expect(out.includes('视觉模型')).toBeTruthy();
      expect(out).toContain('内容 X');
      expect(!out.includes('「」')).toBeTruthy();
  });

  test('buildDescriptionInjection multi-image numbers each block', () => {
      const out = buildDescriptionInjection(['甲', '乙'], { model: 'm' });
      expect(out).toContain('【图片1 描述】');
      expect(out).toContain('【图片2 描述】');
      expect(out.includes('甲') && out).toContain('乙');
  });

  test('buildDescriptionInjection empty/blank input → empty string (caller falls back)', () => {
      expect(buildDescriptionInjection([], { model: 'm' })).toBe('');
      expect(buildDescriptionInjection(['', '   '], { model: 'm' })).toBe('');
      expect(buildDescriptionInjection([null, undefined], { model: 'm' })).toBe('');
  });

  test('buildDescriptionInjection accepts a bare string and never throws', () => {
      expect(() => buildDescriptionInjection('单段描述', { model: 'm' }).not.toThrow());
      const out = buildDescriptionInjection('单段描述', { model: 'm' });
      expect(out).toContain('单段描述');
      expect(() => buildDescriptionInjection(null).not.toThrow());
      expect(buildDescriptionInjection(null)).toBe('');
  });

});
