'use strict';

/**
 * Tests for gateway/_modelIdParse.js — 模型 ID 规范化纯函数原子层(Batch 2)。
 * A 组契约锚定 proxyServer.js / cli/handlers/proxy.js 的原 normalizeModelId；
 * B 组契约锚定 modelDiscovery.js / adapters/_ideTokenMixin.js 的原 normalizeModelId。
 */

const {
  normalizeModelIdTrimQuotes,
  normalizeModelIdCompact,
} = require('../../src/services/gateway/_modelIdParse');

describe('normalizeModelIdTrimQuotes — A 组(trim + 去首尾引号)', () => {
  test('普通 ID 原样返回', () => {
    expect(normalizeModelIdTrimQuotes('claude-opus-4')).toBe('claude-opus-4');
  });

  test('去除首尾空白', () => {
    expect(normalizeModelIdTrimQuotes('  gpt-4o  ')).toBe('gpt-4o');
  });

  test('去除首尾双引号/单引号', () => {
    expect(normalizeModelIdTrimQuotes('"gpt-4o"')).toBe('gpt-4o');
    expect(normalizeModelIdTrimQuotes("'gpt-4o'")).toBe('gpt-4o');
  });

  test('仅去一层引号（正则非贪婪于首尾各一枚）', () => {
    expect(normalizeModelIdTrimQuotes('""gpt-4o""')).toBe('"gpt-4o"');
  });

  test('保留内部空白（与 B 组的关键差异）', () => {
    expect(normalizeModelIdTrimQuotes('model with space')).toBe('model with space');
  });

  test('空串/null/undefined → 空串', () => {
    expect(normalizeModelIdTrimQuotes('')).toBe('');
    expect(normalizeModelIdTrimQuotes(null)).toBe('');
    expect(normalizeModelIdTrimQuotes(undefined)).toBe('');
  });

  test('非字符串输入经 String() 强转；falsy 数字 0 → 空串（|| 语义）', () => {
    expect(normalizeModelIdTrimQuotes(123)).toBe('123');
    expect(normalizeModelIdTrimQuotes(0)).toBe('');
  });

  test('纯空白串 → 空串', () => {
    expect(normalizeModelIdTrimQuotes('   ')).toBe('');
  });
});

describe('normalizeModelIdCompact — B 组(trim + 去首尾引号 + 剥除全部空白)', () => {
  test('普通 ID 原样返回', () => {
    expect(normalizeModelIdCompact('deepseek-v3')).toBe('deepseek-v3');
  });

  test('去除首尾引号（双/单）', () => {
    expect(normalizeModelIdCompact('"deepseek-v3"')).toBe('deepseek-v3');
    expect(normalizeModelIdCompact("'deepseek-v3'")).toBe('deepseek-v3');
  });

  test('剥除内部全部空白（与 A 组的关键差异）', () => {
    expect(normalizeModelIdCompact('model with space')).toBe('modelwithspace');
    expect(normalizeModelIdCompact('a\tb\nc')).toBe('abc');
  });

  test('空串/null/undefined → 空串', () => {
    expect(normalizeModelIdCompact('')).toBe('');
    expect(normalizeModelIdCompact(null)).toBe('');
    expect(normalizeModelIdCompact(undefined)).toBe('');
  });

  test('非字符串输入经 String() 强转', () => {
    expect(normalizeModelIdCompact(42)).toBe('42');
  });

  test('纯空白串 → 空串', () => {
    expect(normalizeModelIdCompact('  \t ')).toBe('');
  });
});

describe('消费方绑定回归 — 调用点逐字节不变的等价验证', () => {
  test('_ideTokenMixin.normalizeModelId 即 Compact 变体', () => {
    const mixin = require('../../src/services/gateway/adapters/_ideTokenMixin');
    expect(mixin.normalizeModelId).toBe(normalizeModelIdCompact);
    expect(mixin.canonicalModelKey('" GPT-4o "')).toBe('gpt-4o');
  });
});
