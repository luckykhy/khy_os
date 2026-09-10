'use strict';

const pickLocale = require('../../src/utils/pickLocale');

describe('pickLocale', () => {
  test('returns "zh" for Chinese text', () => {
    expect(pickLocale('你好世界')).toBe('zh');
    expect(pickLocale('中文')).toBe('zh');
  });

  test('returns "en" for English text', () => {
    expect(pickLocale('hello world')).toBe('en');
    expect(pickLocale('The quick brown fox')).toBe('en');
  });

  test('returns "zh" when Chinese character appears anywhere', () => {
    expect(pickLocale('hello 你')).toBe('zh');
    expect(pickLocale('world 界')).toBe('zh');
  });

  test('returns "en" for empty string', () => {
    expect(pickLocale('')).toBe('en');
  });

  test('returns "en" for null', () => {
    expect(pickLocale(null)).toBe('en');
  });

  test('returns "en" for undefined', () => {
    expect(pickLocale(undefined)).toBe('en');
  });

  test('returns "en" for numbers', () => {
    expect(pickLocale(123)).toBe('en');
  });

  test('returns "en" for symbols only', () => {
    expect(pickLocale('!@#$%^&*()')).toBe('en');
  });

  test('returns "en" for mixed non-Chinese unicode', () => {
    expect(pickLocale('日本語カタカナ')).toBe('en');
    expect(pickLocale('한국어')).toBe('en');
  });

  test('handles single Chinese character', () => {
    expect(pickLocale('中')).toBe('zh');
  });

  test('handles boolean input', () => {
    expect(pickLocale(true)).toBe('en');
    expect(pickLocale(false)).toBe('en');
  });

  test('handles object input', () => {
    expect(pickLocale({})).toBe('en');
  });
});
