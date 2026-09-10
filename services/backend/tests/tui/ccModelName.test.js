'use strict';
/**
 * ccModelName 纯叶子单测(node:test)。
 *
 * 验证「模型身份显示名派生」的单一真源:模型 slug → CC 同款友好名("Opus 4.8"),
 * 未命中 → 裸 slug 原样(忠实对齐 CC 源 utils/model/model.ts renderModelName 的
 * null→raw 兜底)。门控 KHY_MODEL_DISPLAY_NAME 关 → 逐字节回退裸 slug。
 */
const { formatModelLabel, modelDisplayNameEnabled } = require('../../src/cli/ccModelName');
const ON = {}; // 空 env → 门控默认开
const OFF = { KHY_MODEL_DISPLAY_NAME: '0' };

describe('Cc Model Name', () => {
  test('new-convention Claude slugs → friendly family + version', () => {
      expect(formatModelLabel('claude-opus-4-8', ON)).toBe('Opus 4.8');
      expect(formatModelLabel('claude-sonnet-4-6', ON)).toBe('Sonnet 4.6');
      expect(formatModelLabel('claude-haiku-4-5', ON)).toBe('Haiku 4.5');
      // dot separator for minor also parses
      expect(formatModelLabel('claude-haiku-3.5', ON)).toBe('Haiku 3.5');
  });

  test('trailing suffixes (-latest / -date) are ignored', () => {
      expect(formatModelLabel('claude-haiku-4-5-latest', ON)).toBe('Haiku 4.5');
      expect(formatModelLabel('claude-haiku-4-5-20251001', ON)).toBe('Haiku 4.5');
  });

  test('regression: major-then-8-digit-date (no explicit minor) → major only, NOT date-as-minor', () => {
      // Real canonical Anthropic ids: `claude-<family>-<major>-<date>` with no minor.
      // The date suffix must NOT be captured as the minor version.
      expect(formatModelLabel('claude-opus-4-20250514', ON)).toBe('Opus 4');
      expect(formatModelLabel('claude-sonnet-4-20250514', ON)).toBe('Sonnet 4');
      // With an explicit minor before the date, the minor is still honored.
      expect(formatModelLabel('claude-opus-4-1-20250805', ON)).toBe('Opus 4.1');
      expect(formatModelLabel('claude-sonnet-4-5-20250929', ON)).toBe('Sonnet 4.5');
      // Two-digit minor is preserved (not truncated).
      expect(formatModelLabel('claude-opus-4-10', ON)).toBe('Opus 4.10');
  });

  test('major-only slug → no minor', () => {
      expect(formatModelLabel('claude-opus-4', ON)).toBe('Opus 4');
  });

  test('legacy convention (version before family) → friendly', () => {
      expect(formatModelLabel('claude-3-5-sonnet-20241022', ON)).toBe('Sonnet 3.5');
      expect(formatModelLabel('claude-3-opus-20240229', ON)).toBe('Opus 3');
  });

  test('non-Claude / unknown / auto / empty → raw verbatim (CC null→raw parity)', () => {
      expect(formatModelLabel('agnes-2.0-flash', ON)).toBe('agnes-2.0-flash');
      expect(formatModelLabel('gpt-5-codex', ON)).toBe('gpt-5-codex');
      expect(formatModelLabel('auto', ON)).toBe('auto');
      expect(formatModelLabel('', ON)).toBe('');
      expect(formatModelLabel(null, ON)).toBe('');
      expect(formatModelLabel(undefined, ON)).toBe('');
  });

  test('gate off → raw slug byte-identical', () => {
      expect(formatModelLabel('claude-opus-4-8', OFF)).toBe('claude-opus-4-8');
      expect(formatModelLabel('claude-sonnet-4-6', OFF)).toBe('claude-sonnet-4-6');
      expect(formatModelLabel('agnes-2.0-flash', OFF)).toBe('agnes-2.0-flash');
      // empty still empty regardless of gate
      expect(formatModelLabel('', OFF)).toBe('');
  });

  test('gate predicate honors off-spellings, defaults on', () => {
      expect(modelDisplayNameEnabled({})).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
        expect(modelDisplayNameEnabled({ KHY_MODEL_DISPLAY_NAME: v })).toBe(false);
      }
      expect(modelDisplayNameEnabled({ KHY_MODEL_DISPLAY_NAME: '1' })).toBe(true);
  });

  test('whitespace around slug is trimmed', () => {
      expect(formatModelLabel('  claude-opus-4-8  ', ON)).toBe('Opus 4.8');
  });

});
