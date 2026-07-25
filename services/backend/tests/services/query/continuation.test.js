'use strict';

/**
 * Tests for query/continuation.js — the single-source continuation policy.
 * Covers: continuation-command detection, resumable-error classification,
 * auto-resume bound (env-overridable), and continueHintFor on attributions.
 */

const cont = require('../../../src/services/query/continuation');

describe('isContinuationCommand', () => {
  test.each(['继续', '接着', '继续执行', '往下', 'go on', 'continue', 'KEEP GOING', '继续。', 'continue!'])(
    'recognizes short continuation command: %s', (input) => {
      expect(cont.isContinuationCommand(input)).toBe(true);
    });

  test.each(['请继续帮我把这个超过三十个字的复杂任务从头到尾全部完成并解释每一步', '继续保持这个代码风格并重构整个模块', '', '   ', 'hello', '停止'])(
    'rejects non-continuation / over-long input: %s', (input) => {
      expect(cont.isContinuationCommand(input)).toBe(false);
    });

  test('rejects null/undefined safely', () => {
    expect(cont.isContinuationCommand(null)).toBe(false);
    expect(cont.isContinuationCommand(undefined)).toBe(false);
  });
});

describe('isResumableError', () => {
  test.each(['content_filter', 'safety', 'refusal', 'permission', 'permission_denied', 'approval_denied', 'blocked', 'context_overflow', 'context_length_exceeded'])(
    'NON-resumable: %s', (et) => {
      expect(cont.isResumableError(et)).toBe(false);
    });

  test.each(['timeout', 'network', 'process', 'empty_reply', 'unknown', 'rate_limit'])(
    'resumable: %s', (et) => {
      expect(cont.isResumableError(et)).toBe(true);
    });

  test('case-insensitive + trims', () => {
    expect(cont.isResumableError('  CONTENT_FILTER ')).toBe(false);
    expect(cont.isResumableError('Permission_Denied')).toBe(false);
  });

  test('empty / null errorType defaults to resumable (pure truncation/empty)', () => {
    expect(cont.isResumableError('')).toBe(true);
    expect(cont.isResumableError(null)).toBe(true);
    expect(cont.isResumableError(undefined)).toBe(true);
  });
});

describe('maxAutoResume', () => {
  const ORIG = process.env.KHY_AUTO_RESUME_ATTEMPTS;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.KHY_AUTO_RESUME_ATTEMPTS;
    else process.env.KHY_AUTO_RESUME_ATTEMPTS = ORIG;
  });

  test('default when unset', () => {
    delete process.env.KHY_AUTO_RESUME_ATTEMPTS;
    expect(cont.maxAutoResume()).toBe(cont.DEFAULT_AUTO_RESUME_ATTEMPTS);
  });

  test('honors a valid override', () => {
    process.env.KHY_AUTO_RESUME_ATTEMPTS = '3';
    expect(cont.maxAutoResume()).toBe(3);
  });

  test('0 disables seamless auto-resume', () => {
    process.env.KHY_AUTO_RESUME_ATTEMPTS = '0';
    expect(cont.maxAutoResume()).toBe(0);
  });

  test('clamps to 5 upper bound', () => {
    process.env.KHY_AUTO_RESUME_ATTEMPTS = '99';
    expect(cont.maxAutoResume()).toBe(5);
  });

  test('falls back to default on garbage / negative', () => {
    process.env.KHY_AUTO_RESUME_ATTEMPTS = 'abc';
    expect(cont.maxAutoResume()).toBe(cont.DEFAULT_AUTO_RESUME_ATTEMPTS);
    process.env.KHY_AUTO_RESUME_ATTEMPTS = '-2';
    expect(cont.maxAutoResume()).toBe(cont.DEFAULT_AUTO_RESUME_ATTEMPTS);
  });
});

describe('continueHintFor', () => {
  test('returns the attribution-specific hint when resumable', () => {
    expect(cont.continueHintFor({ resumable: true, continueHint: '自定义提示' })).toBe('自定义提示');
  });

  test('falls back to CONTINUE_HINT when resumable but hint missing', () => {
    expect(cont.continueHintFor({ resumable: true })).toBe(cont.CONTINUE_HINT);
  });

  test('returns null for non-resumable attribution', () => {
    expect(cont.continueHintFor({ resumable: false, continueHint: 'x' })).toBeNull();
  });

  test('returns null for missing attribution', () => {
    expect(cont.continueHintFor(null)).toBeNull();
    expect(cont.continueHintFor(undefined)).toBeNull();
  });
});
