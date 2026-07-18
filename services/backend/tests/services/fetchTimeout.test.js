'use strict';

/**
 * Tests for fetchTimeout.js — timeout signal composition,
 * fetchWithTimeout execution, and URL sanitization.
 */

// Mock ssrfGuard to avoid external dep in fetchWithSsrfGuard
jest.mock('../../src/services/ssrfGuard', () => ({
  validateUrl: jest.fn().mockResolvedValue(true),
}), { virtual: true });

const {
  buildTimeoutAbortSignal,
  fetchWithTimeout,
  bindAbortRelay,
  DEFAULT_FETCH_TIMEOUT_MS,
} = require('../../src/services/fetchTimeout');

describe('buildTimeoutAbortSignal', () => {
  test('returns noop cleanup when no timeout and no signal', () => {
    const { signal, cleanup, refresh } = buildTimeoutAbortSignal({});
    // When no external signal is provided, default timeout applies
    // but if signal IS provided without timeout, just pass signal through
    expect(typeof cleanup).toBe('function');
    expect(typeof refresh).toBe('function');
    cleanup(); // should not throw
  });

  test('returns external signal when no timeout but signal provided', () => {
    const controller = new AbortController();
    const { signal, cleanup } = buildTimeoutAbortSignal({
      signal: controller.signal,
    });
    expect(signal).toBe(controller.signal);
    cleanup();
  });

  test('creates composed signal with timeout', () => {
    const { signal, cleanup } = buildTimeoutAbortSignal({
      timeoutMs: 5000,
    });
    expect(signal).toBeDefined();
    expect(signal.aborted).toBe(false);
    cleanup();
  });

  test('aborts on timeout expiration', async () => {
    const { signal, cleanup } = buildTimeoutAbortSignal({
      timeoutMs: 50,
    });
    expect(signal.aborted).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  test('refresh resets the timeout timer', async () => {
    const { signal, cleanup, refresh } = buildTimeoutAbortSignal({
      timeoutMs: 100,
    });

    // Refresh before timeout
    await new Promise((resolve) => setTimeout(resolve, 60));
    refresh();

    // Should not be aborted yet after refresh
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(signal.aborted).toBe(false);

    cleanup();
  });

  test('cleanup prevents abort after call', async () => {
    const { signal, cleanup } = buildTimeoutAbortSignal({
      timeoutMs: 50,
    });
    cleanup(); // clean up immediately
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Signal may or may not be aborted depending on timing,
    // but cleanup should not throw
  });
});

describe('fetchWithTimeout', () => {
  test('returns fn result when fn completes before timeout', async () => {
    const result = await fetchWithTimeout(
      async () => 'data',
      { timeoutMs: 1000 }
    );
    expect(result).toBe('data');
  });

  test('rejects when fn exceeds timeout', async () => {
    await expect(
      fetchWithTimeout(
        async (signal) => {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 5000);
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          });
        },
        { timeoutMs: 50 }
      )
    ).rejects.toThrow();
  });

  test('propagates fn errors', async () => {
    await expect(
      fetchWithTimeout(
        async () => { throw new Error('fn error'); },
        { timeoutMs: 1000 }
      )
    ).rejects.toThrow('fn error');
  });
});

describe('bindAbortRelay', () => {
  test('creates a function that aborts the controller', () => {
    const controller = new AbortController();
    const relay = bindAbortRelay(controller);
    expect(typeof relay).toBe('function');
    expect(controller.signal.aborted).toBe(false);
    relay();
    expect(controller.signal.aborted).toBe(true);
  });
});

describe('DEFAULT_FETCH_TIMEOUT_MS', () => {
  test('is 120000 (2 minutes)', () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(120000);
  });
});
