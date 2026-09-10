'use strict';
/**
 * fableVoiceProfile.test.js — Fable 5 行为 DNA 注入的纯叶子门控与逐字节回退。
 *
 * 锁死:
 *   - 门开(default)→ 三块 items 各返回借鉴文案(散文优先 / 语气 / 认错不自贬);
 *   - 门关(0/false/off/no,大小写/空白不敏感)→ 三块各返回 [](上游 section 逐字节回退);
 *   - 返回新副本(caller mutation 隔离);绝不抛(junk env / null)。
 */
const {
  fableVoiceEnabled,
  responseFormattingItems,
  toneAndStyleItems,
  errorHandlingItems,
  RESPONSE_FORMATTING_ITEMS,
  TONE_AND_STYLE_ITEMS,
  ERROR_HANDLING_ITEMS,
} = require('../../src/services/fableVoiceProfile');

describe('Fable Voice Profile', () => {
  test('gate default-on → all three blocks carry their borrowed items', () => {
      expect(fableVoiceEnabled({})).toBe(true);
      expect(fableVoiceEnabled({ KHY_FABLE_VOICE: '1' })).toBe(true);
      expect(responseFormattingItems({})).toEqual(RESPONSE_FORMATTING_ITEMS);
      expect(toneAndStyleItems({})).toEqual(TONE_AND_STYLE_ITEMS);
      expect(errorHandlingItems({})).toEqual(ERROR_HANDLING_ITEMS);
  });

  test('gate off (0/false/off/no, case/space-insensitive) → all three return [] (byte-revert)', () => {
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
        expect(fableVoiceEnabled({ KHY_FABLE_VOICE: v })).toBe(false, v);
        expect(responseFormattingItems({ KHY_FABLE_VOICE: v })).toEqual([], v);
        expect(toneAndStyleItems({ KHY_FABLE_VOICE: v })).toEqual([], v);
        expect(errorHandlingItems({ KHY_FABLE_VOICE: v })).toEqual([], v);
      }
  });

  test('borrowed items are non-empty and prose-shaped (no leading bullet marker)', () => {
      for (const block of [RESPONSE_FORMATTING_ITEMS, TONE_AND_STYLE_ITEMS, ERROR_HANDLING_ITEMS]) {
        expect(block.length >= 1).toBeTruthy();
        for (const item of block) {
          expect(typeof item === 'string' && item.length > 0).toBeTruthy();
          expect(!/^\s*[-*]/.test(item)).toBeTruthy();
        }
      }
  });

  test('items() return fresh copies (caller mutation is isolated)', () => {
      const a = responseFormattingItems({});
      a.push('mutant');
      expect(!responseFormattingItems({})).toContain('mutant');
      expect(a).not.toBe(RESPONSE_FORMATTING_ITEMS);
  });

  test('never throws on junk env', () => {
      expect(() => fableVoiceEnabled(null).not.toThrow());
      expect(() => responseFormattingItems(null).not.toThrow());
      expect(() => toneAndStyleItems(undefined).not.toThrow());
      expect(() => errorHandlingItems({ KHY_FABLE_VOICE: {} }).not.toThrow());
  });

});
