'use strict';
/**
 * contextResidentTokens.test.js — 上下文占用率喂入值口径单一真源(node:test)。
 *
 * 对齐 CC `src/utils/context.ts::calculateContextPercentages`:占用率分子
 *   totalInputTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * 锁定:门控开 → legacyBase(未缓存输入)+ cacheReadInputTokens + cacheWriteInputTokens;
 * 门控关 → 原样返回 legacyBase(逐字节回退,call-site 历史口径)。三段互不相交不重复计数。
 */
const { contextResidentTokensOr, isEnabled } = require('../../src/cli/contextResidentTokens');
const ON = {}; // 默认开
const OFF = { KHY_CONTEXT_CACHE_TOKENS: 'off' };
describe('isEnabled 门控梯', () => {
});
describe('contextResidentTokensOr', () => {
});

describe('Context Resident Tokens', () => {
  test('无 env / 空 → 开', () => {
        expect(isEnabled({})).toBe(true);
        expect(isEnabled()).toBe(true);
        expect(isEnabled({ KHY_CONTEXT_CACHE_TOKENS: '' })).toBe(true);
  });

  test('0/false/off/no(大小写/空白不敏感)→ 关', () => {
        for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
          expect(isEnabled({ KHY_CONTEXT_CACHE_TOKENS: v })).toBe(false);
        }
  });

  test('其它真值(1/true/on)→ 开', () => {
        expect(isEnabled({ KHY_CONTEXT_CACHE_TOKENS: '1' })).toBe(true);
        expect(isEnabled({ KHY_CONTEXT_CACHE_TOKENS: 'true' })).toBe(true);
  });

  test('门控开:三段相加(对齐 CC totalInputTokens)', () => {
        const usage = { inputTokens: 1200, cacheReadInputTokens: 78000, cacheWriteInputTokens: 2000 };
        expect(contextResidentTokensOr(usage, 1200, ON)).toBe(81200);
  });

  test('门控开:无缓存段 → 等于 legacyBase(纯未缓存 turn 与历史一致)', () => {
        const usage = { inputTokens: 1200 };
        expect(contextResidentTokensOr(usage, 1200, ON)).toBe(1200);
  });

  test('门控开:仅读缓存(写缺省)', () => {
        const usage = { inputTokens: 500, cacheReadInputTokens: 40000 };
        expect(contextResidentTokensOr(usage, 500, ON)).toBe(40500);
  });

  test('门控关:恒返回 legacyBase(连缓存段也丢弃,逐字节回退历史)', () => {
        const usage = { inputTokens: 1200, cacheReadInputTokens: 78000, cacheWriteInputTokens: 2000 };
        expect(contextResidentTokensOr(usage, 1200, OFF)).toBe(1200);
  });

  test('唯一分歧=缓存段:无缓存时开/关两态恒一致', () => {
        const usage = { inputTokens: 999 };
        expect(contextResidentTokensOr(usage, 999, ON)).toBe(contextResidentTokensOr(usage, 999, OFF));
  });

  test('防呆:legacyBase 非数/NaN/负 → 0 基数', () => {
        expect(contextResidentTokensOr({ cacheReadInputTokens: 100 }, undefined, ON)).toBe(100);
        expect(contextResidentTokensOr({ cacheReadInputTokens: 100 }, NaN, ON)).toBe(100);
        expect(contextResidentTokensOr({ cacheReadInputTokens: 100 }, -5, ON)).toBe(100);
  });

  test('防呆:缓存段非数/负 → 计 0,不污染基数', () => {
        const usage = { inputTokens: 100, cacheReadInputTokens: -7, cacheWriteInputTokens: 'x' };
        expect(contextResidentTokensOr(usage, 100, ON)).toBe(100);
  });

  test('防呆:tokenUsage 为 null/undefined → 仅 legacyBase', () => {
        expect(contextResidentTokensOr(null, 1200, ON)).toBe(1200);
        expect(contextResidentTokensOr(undefined, 1200, ON)).toBe(1200);
  });

  test('默认门控(无 env)= 开:三段相加', () => {
        const prev = process.env.KHY_CONTEXT_CACHE_TOKENS;
        delete process.env.KHY_CONTEXT_CACHE_TOKENS;
        try {
          const usage = { inputTokens: 10, cacheReadInputTokens: 20, cacheWriteInputTokens: 30 };
          expect(contextResidentTokensOr(usage)).toBe(10);
        } finally {
          if (prev == null) delete process.env.KHY_CONTEXT_CACHE_TOKENS;
          else process.env.KHY_CONTEXT_CACHE_TOKENS = prev;
        }
  });

});
