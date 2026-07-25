'use strict';

/**
 * rateLimitRetry.test.js — 纯叶子「限流(429)自动重试策略与文案」回归。
 *
 * 背景(用户报 2026-07·对齐 CC):一发请求就 429,khy 逼用户手动敲「继续」推进。本叶子决定
 * 「该不该自动重试 / 等多久 / 显示什么文案」,壳(ai.js)据此循环退避重发。零 IO、绝不起 timer。
 */
const { describe, test, expect } = require('@jest/globals');
const rl = require('../../src/cli/rateLimitRetry');

const GATE = 'KHY_RATE_LIMIT_AUTORETRY';
const MAXENV = 'KHY_RATE_LIMIT_MAX_ROUNDS';
function withEnv(overrides, fn) {
  const prev = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(overrides)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe('rateLimitRetry — 门控与轮数', () => {
  test('默认门控开 → maxRounds=10', () => {
    withEnv({ [GATE]: undefined, [MAXENV]: undefined }, () => {
      expect(rl.isRateLimitAutoRetryEnabled(process.env)).toBe(true);
      expect(rl.maxRounds(process.env)).toBe(10);
    });
  });

  test('门控关(off/0/false/no) → maxRounds=0(回退手动继续)', () => {
    for (const v of ['off', '0', 'false', 'no']) {
      withEnv({ [GATE]: v }, () => {
        expect(rl.isRateLimitAutoRetryEnabled(process.env)).toBe(false);
        expect(rl.maxRounds(process.env)).toBe(0);
      });
    }
  });

  test('KHY_RATE_LIMIT_MAX_ROUNDS 覆盖并钳到硬上限 20', () => {
    withEnv({ [GATE]: undefined, [MAXENV]: '3' }, () => expect(rl.maxRounds(process.env)).toBe(3));
    withEnv({ [GATE]: undefined, [MAXENV]: '999' }, () => expect(rl.maxRounds(process.env)).toBe(20));
    withEnv({ [GATE]: undefined, [MAXENV]: '-5' }, () => expect(rl.maxRounds(process.env)).toBe(10));
    withEnv({ [GATE]: undefined, [MAXENV]: 'abc' }, () => expect(rl.maxRounds(process.env)).toBe(10));
    withEnv({ [GATE]: undefined, [MAXENV]: '0' }, () => expect(rl.maxRounds(process.env)).toBe(0));
  });
});

describe('rateLimitRetry — errorType 归类', () => {
  test('限流/过载类判 true', () => {
    for (const t of ['rate_limit', 'RateLimit', 'overloaded', 'too_many_requests', '429']) {
      expect(rl.isRateLimitErrorType(t)).toBe(true);
    }
  });
  test('非限流类判 false(不越界抢其他失败)', () => {
    for (const t of ['timeout', 'network', 'auth', 'unknown', 'content_filter', '', null, undefined]) {
      expect(rl.isRateLimitErrorType(t)).toBe(false);
    }
  });
});

describe('rateLimitRetry — shouldAutoRetry', () => {
  test('限流 + 轮次在范围内 + 门控开 → true', () => {
    withEnv({ [GATE]: undefined, [MAXENV]: undefined }, () => {
      expect(rl.shouldAutoRetry({ errorType: 'rate_limit', round: 1, env: process.env })).toBe(true);
      expect(rl.shouldAutoRetry({ errorType: 'rate_limit', round: 10, env: process.env })).toBe(true);
      expect(rl.shouldAutoRetry({ errorType: 'rate_limit', round: 11, env: process.env })).toBe(false);
    });
  });
  test('非限流 → false;门控关 → false', () => {
    withEnv({ [GATE]: undefined }, () => {
      expect(rl.shouldAutoRetry({ errorType: 'timeout', round: 1, env: process.env })).toBe(false);
    });
    withEnv({ [GATE]: 'off' }, () => {
      expect(rl.shouldAutoRetry({ errorType: 'rate_limit', round: 1, env: process.env })).toBe(false);
    });
  });
});

describe('rateLimitRetry — resolveCooldownMs', () => {
  test('优先结构化 cooldownMs', () => {
    expect(rl.resolveCooldownMs({ cooldownMs: 8000 }, 0)).toBe(8000);
  });
  test('从文案 "(cooldown 11s)" 抠秒数', () => {
    const r = { content: 'recent rate_limit failure cached: 429 (cooldown 11s)' };
    expect(rl.resolveCooldownMs(r, 0)).toBe(11000);
  });
  test('中文「秒」与 error 字段亦可', () => {
    expect(rl.resolveCooldownMs({ error: '限流 cooldown 5 秒' }, 0)).toBe(5000);
  });
  test('无冷却信息 → 指数退避兜底,随轮次增长', () => {
    const a = rl.resolveCooldownMs({ content: 'rate limited' }, 0);
    const b = rl.resolveCooldownMs({ content: 'rate limited' }, 2);
    expect(a).toBe(6000);         // DEFAULT_COOLDOWN_MS
    expect(b).toBeGreaterThan(a); // 6000 * 1.6^2
  });
  test('钳在 [1s, 30s]', () => {
    expect(rl.resolveCooldownMs({ cooldownMs: 100 }, 0)).toBe(1000);
    expect(rl.resolveCooldownMs({ cooldownMs: 999999 }, 0)).toBe(30000);
  });
});

describe('rateLimitRetry — 文案', () => {
  test('剩余>0 → 明文「N 秒后自动重试（第 r/total 轮）」', () => {
    const msg = rl.buildRetryStatusMessage({ round: 2, maxRounds: 10, remainingMs: 3000 });
    expect(msg).toMatch(/限流/);
    expect(msg).toMatch(/3 秒后/);
    expect(msg).toMatch(/第 2\/10 轮/);
  });
  test('剩余<=0 → 「正在自动重试（第 r/total 轮）」', () => {
    const msg = rl.buildRetryStatusMessage({ round: 3, maxRounds: 10, remainingMs: 0 });
    expect(msg).toMatch(/正在自动重试/);
    expect(msg).toMatch(/第 3\/10 轮/);
  });
  test('buildExhaustedNote 含轮数、限流、可稍后继续/换通道', () => {
    const note = rl.buildExhaustedNote(10);
    expect(note).toMatch(/10 轮/);
    expect(note).toMatch(/限流/);
    expect(note).toMatch(/继续|通道|频率/);
  });
});
