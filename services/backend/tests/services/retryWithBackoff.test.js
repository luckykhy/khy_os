'use strict';

/**
 * Tests for retryWithBackoff.js — retry logic, backoff delays,
 * error classification, and Retry-After parsing.
 */

const {
  retryWithBackoff,
  parseRetryAfter,
  isRetryableError,
  DEFAULT_ATTEMPTS,
  DEFAULT_MIN_DELAY,
} = require('../../src/services/retryWithBackoff');

describe('retryWithBackoff', () => {
  test('returns result on first successful try', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const result = await retryWithBackoff(fn, { attempts: 3 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on failure and succeeds on subsequent attempt', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockResolvedValueOnce('recovered');

    const result = await retryWithBackoff(fn, {
      attempts: 3,
      minDelayMs: 1,
      maxDelayMs: 10,
      jitter: 0,
    });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('throws after max retries exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('persistent failure'));

    await expect(
      retryWithBackoff(fn, { attempts: 3, minDelayMs: 1, maxDelayMs: 5, jitter: 0 })
    ).rejects.toThrow('persistent failure');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('respects shouldRetry predicate — stops on non-retryable error', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('auth failure'));
    const shouldRetry = jest.fn().mockReturnValue(false);

    await expect(
      retryWithBackoff(fn, { attempts: 5, shouldRetry, minDelayMs: 1 })
    ).rejects.toThrow('auth failure');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  test('calls onRetry callback before each retry sleep', async () => {
    const onRetry = jest.fn();
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('err1'))
      .mockRejectedValueOnce(new Error('err2'))
      .mockResolvedValue('ok');

    await retryWithBackoff(fn, {
      attempts: 3,
      minDelayMs: 1,
      maxDelayMs: 5,
      jitter: 0,
      onRetry,
      label: 'test-op',
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toMatchObject({
      attempt: 1,
      maxAttempts: 3,
      label: 'test-op',
    });
  });

  test('does not retry when attempts=1', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('no retry'));

    await expect(
      retryWithBackoff(fn, { attempts: 1 })
    ).rejects.toThrow('no retry');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('passes attempt number to fn', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await retryWithBackoff(fn, { attempts: 1 });
    expect(fn).toHaveBeenCalledWith(1);
  });
});

describe('parseRetryAfter', () => {
  test('parses integer seconds from response headers', () => {
    const err = { response: { headers: { 'retry-after': '5' } } };
    expect(parseRetryAfter(err)).toBe(5000);
  });

  test('parses from error-level headers', () => {
    const err = { headers: { 'retry-after': '10' } };
    expect(parseRetryAfter(err)).toBe(10000);
  });

  test('parses from retryAfter property', () => {
    const err = { retryAfter: '3' };
    expect(parseRetryAfter(err)).toBe(3000);
  });

  test('returns undefined when header is missing', () => {
    expect(parseRetryAfter({})).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  test('returns undefined for zero/negative seconds', () => {
    expect(parseRetryAfter({ retryAfter: '0' })).toBeUndefined();
    expect(parseRetryAfter({ retryAfter: '-1' })).toBeUndefined();
  });
});

describe('isRetryableError', () => {
  test('returns true for network errors', () => {
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryableError({ code: 'ENOTFOUND' })).toBe(true);
  });

  test('returns true for HTTP 429 (rate limit)', () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
    expect(isRetryableError({ statusCode: 429 })).toBe(true);
  });

  test('returns true for 5xx server errors', () => {
    expect(isRetryableError({ status: 500 })).toBe(true);
    expect(isRetryableError({ status: 503 })).toBe(true);
  });

  test('returns true for overloaded error messages', () => {
    expect(isRetryableError({ type: 'overloaded_error' })).toBe(true);
    expect(isRetryableError({ message: 'Server overloaded, please try again' })).toBe(true);
    expect(isRetryableError({ message: 'Too many requests' })).toBe(true);
  });

  test('returns false for client errors (4xx except 429)', () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 401 })).toBe(false);
    expect(isRetryableError({ status: 404 })).toBe(false);
  });

  test('returns true for codeless "socket hang up" (OpenAI/undici transient)', () => {
    // The real-world failure users hit: an Error whose ONLY signal is the message
    // string, with no err.code — must still be retryable so the turn auto-resumes.
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableError({ message: 'request to https://api failed, reason: socket hang up' })).toBe(true);
  });

  test('returns true for codeless network-error messages', () => {
    expect(isRetryableError({ message: 'connection reset by peer' })).toBe(true);
    expect(isRetryableError({ message: 'getaddrinfo EAI_AGAIN api.openai.com' })).toBe(true);
    expect(isRetryableError({ message: 'network error' })).toBe(true);
  });

  test('returns true for ECONNREFUSED / EAI_AGAIN codes', () => {
    expect(isRetryableError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isRetryableError({ code: 'EAI_AGAIN' })).toBe(true);
  });

  test('returns false for null/undefined', () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe('constants', () => {
  test('DEFAULT_ATTEMPTS is 3', () => {
    expect(DEFAULT_ATTEMPTS).toBe(3);
  });

  test('DEFAULT_MIN_DELAY is 300ms', () => {
    expect(DEFAULT_MIN_DELAY).toBe(300);
  });
});
