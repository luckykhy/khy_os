'use strict';
/**
 * toolNameVariants.test.js — 锁 utils/toolNameVariants 口径
 *   (收敛 toolCalling·toolExecutionEngine 2 处 body 相同的 _toolNameVariants)。
 */
const toolNameVariants = require('../src/utils/toolNameVariants');

describe('Tool Name Variants', () => {
  test('camelCase → 含 snake_case / camelCase / 全小写 / 原样', () => {
      const v = toolNameVariants('shellCommand');
      expect(v).toContain('shellCommand');
      expect(v).toContain('shell_command');
      expect(v).toContain('shellcommand');
  });

  test('snake_case 入 → 含 camelCase 变体', () => {
      const v = toolNameVariants('open_app');
      expect(v).toContain('open_app');
      expect(v).toContain('openApp');
  });

  test('空/非串 → []', () => {
      expect(toolNameVariants('')).toEqual([]);
      expect(toolNameVariants(null)).toEqual([]);
      expect(toolNameVariants(undefined)).toEqual([]);
  });

  test('去重(原样即全小写时不重复)', () => {
      const v = toolNameVariants('read');
      expect(new Set(v).size).toBe(v.length);
  });

  test('空格/连字符 → 归一为下划线', () => {
      const v = toolNameVariants('web search');
      expect(v).toContain('web_search');
  });

  test('纯:不 mutate·同输入同输出', () => {
      const a = toolNameVariants('fooBar');
      const b = toolNameVariants('fooBar');
      expect(a).toEqual(b);
  });

});
