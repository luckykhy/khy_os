import { describe, it, expect } from 'vitest';
import {
  classifyKhyError,
  ensureKhyError,
  SEVERITIES,
  CATEGORIES,
  CODES,
} from './classifyKhyError.mjs';

/**
 * classifyKhyError — locks the lightweight error-classification mirror of
 * platform/packages/shared/src/errorEnvelope.js. Drift between the two
 * tables shows up here first.
 */

describe('HTTP 状态码映射（STATUS_TABLE 单一真源）', () => {
  const cases = [
    [400, 'INVALID_ARGUMENT', 'user'],
    [401, 'AUTH_REQUIRED', 'auth'],
    [403, 'PERMISSION_DENIED', 'auth'],
    [404, 'MODEL_NOT_FOUND', 'upstream'],
    [408, 'TIMEOUT', 'network'],
    [413, 'CONTEXT_TOO_LONG', 'upstream'],
    [429, 'RATE_LIMITED', 'upstream'],
    [500, 'UPSTREAM_5XX', 'upstream'],
    [502, 'UPSTREAM_5XX', 'upstream'],
    [503, 'MODEL_OVERLOADED', 'upstream'],
    [504, 'TIMEOUT', 'network'],
  ];

  for (const [status, code, category] of cases) {
    it(`${status} → ${code}（${category}）`, () => {
      const err = classifyKhyError({ status, message: 'http fail' });
      expect(err.code).toBe(code);
      expect(err.category).toBe(category);
      expect(err.isKhyError).toBe(true);
      expect(err.actionable).toBe(true);
    });
  }

  it('statusCode 别名与 status 等价', () => {
    const err = classifyKhyError({ statusCode: 401 });
    expect(err.code).toBe('AUTH_REQUIRED');
  });

  it('0 / 负数 / 非数值 status 不走状态表', () => {
    const err = classifyKhyError({ status: 0, message: 'no status' });
    expect(err.code).toBe('UNKNOWN');
  });
});

describe('Node errno 映射（ERRNO_TABLE）', () => {
  it('ECONNREFUSED → NETWORK_UNREACHABLE', () => {
    const err = classifyKhyError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }));
    expect(err.code).toBe('NETWORK_UNREACHABLE');
    expect(err.category).toBe('network');
  });

  it('EADDRINUSE → PORT_IN_USE（config/warn）', () => {
    const err = classifyKhyError(Object.assign(new Error('addr'), { code: 'EADDRINUSE' }));
    expect(err.code).toBe('PORT_IN_USE');
    expect(err.category).toBe('config');
    expect(err.severity).toBe('warn');
  });

  it('errno 优先于消息扫描（ECONNREFUSED + 限流文案仍归网络）', () => {
    const err = classifyKhyError(
      Object.assign(new Error('too many requests: connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    );
    expect(err.code).toBe('NETWORK_UNREACHABLE');
  });
});

describe('错误名映射（NAME_TABLE）', () => {
  it('TypeError → internal/fatal，code 落回 fallbackCode', () => {
    const err = classifyKhyError(new TypeError('boom'));
    expect(err.code).toBe('UNKNOWN');
    expect(err.category).toBe('internal');
    expect(err.severity).toBe('fatal');
  });

  it('AbortError → network/warn', () => {
    const err = classifyKhyError(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(err.code).toBe('UNKNOWN');
    expect(err.category).toBe('network');
  });
});

describe('消息扫描（MESSAGE_TABLE，顺序敏感）', () => {
  it('「too many requests」→ RATE_LIMITED', () => {
    const err = classifyKhyError(new Error('upstream: too many requests'));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryable).toBe(true);
  });

  it('「CORS」→ CORS_BLOCKED（network/error，不可重试）', () => {
    const err = classifyKhyError(new Error('blocked by CORS policy'));
    expect(err.code).toBe('CORS_BLOCKED');
    expect(err.retryable).toBe(false);
  });

  it('「out of memory」→ OOM（resource/fatal）', () => {
    const err = classifyKhyError(new Error('JavaScript heap out of memory'));
    expect(err.code).toBe('OOM');
    expect(err.severity).toBe('fatal');
    expect(err.recoverable).toBe(false);
  });

  it('「unknown model」→ MODEL_NOT_FOUND', () => {
    const err = classifyKhyError(new Error('error: unknown model xyz'));
    expect(err.code).toBe('MODEL_NOT_FOUND');
  });

  it('「quota exceeded」→ BILLING_REQUIRED', () => {
    const err = classifyKhyError(new Error('quota exceeded, charge required'));
    expect(err.code).toBe('BILLING_REQUIRED');
  });
});

describe('透传与兜底', () => {
  it('已是 KhyError（isKhyError + code）原样返回，不重新包装', () => {
    const original = classifyKhyError(new Error('rate limit'));
    const passthrough = classifyKhyError(original, { fallbackCode: 'WHATEVER' });
    expect(passthrough).toBe(original);
  });

  it('完全无法归类 → UNKNOWN + fallbackCode', () => {
    const err = classifyKhyError(new Error('some opaque failure'));
    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toBe('some opaque failure');
    expect(err.hint).toBe(CODES.UNKNOWN.hint);
  });

  it('fallbackCode 透传', () => {
    const err = classifyKhyError(new Error('opaque'), { fallbackCode: 'MODULE_NOT_FOUND' });
    expect(err.code).toBe('MODULE_NOT_FOUND');
  });

  it('null/undefined 输入 → UNKNOWN，message 回退到 code', () => {
    const err = classifyKhyError(null);
    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toBe('UNKNOWN');
  });
});

describe('ensureKhyError 补全', () => {
  it('补 category/severity 后返回 enriched 对象', () => {
    const err = ensureKhyError(new Error('mystery'));
    expect(err.category).toBe('unknown');
    expect(err.severity).toBe('error');
  });
});

describe('枚举常量', () => {
  it('SEVERITIES 五级且 rank 单调递增', () => {
    const ranks = ['SILENT', 'INFO', 'WARN', 'ERROR', 'FATAL'].map((k) => SEVERITIES[k].rank);
    expect(ranks).toEqual([0, 1, 2, 3, 4]);
  });

  it('CATEGORIES 与枚举 code 一致', () => {
    expect(CATEGORIES.UPSTREAM.code).toBe('upstream');
    expect(CATEGORIES.NETWORK.code).toBe('network');
    expect(Object.freeze).toBeDefined();
    expect(Object.isFrozen(CODES)).toBe(true);
  });
});
