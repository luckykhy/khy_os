'use strict';

/**
 * Unit tests for credentialRefreshCoordinator.js.
 *
 * Covers:
 *   - Single-flight dedup (concurrent same-key calls share one refresh)
 *   - Different keys do not interfere
 *   - Timeout returns failure
 *   - refreshFn throwing does not propagate (returns {ok: false})
 *   - finally cleanup: can refresh again after failure/timeout
 *   - Invalid inputs return {ok: false}
 */

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIG_ENV };
  // Use a fast timeout for tests
  process.env.KHY_CREDENTIAL_REFRESH_TIMEOUT_MS = '500';
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

function loadCoordinator() {
  return require('../../src/services/gateway/credentialRefreshCoordinator');
}

describe('credentialRefreshCoordinator', () => {
  describe('single-flight dedup', () => {
    test('concurrent calls with same key only call refreshFn once', async () => {
      const coordinator = loadCoordinator();
      let callCount = 0;
      const refreshFn = () => new Promise(resolve => {
        callCount++;
        setTimeout(() => resolve(true), 50);
      });

      const p1 = coordinator.refreshCredential('trae', refreshFn);
      const p2 = coordinator.refreshCredential('trae', refreshFn);
      const p3 = coordinator.refreshCredential('trae', refreshFn);

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      expect(callCount).toBe(1);
      expect(r1).toEqual({ ok: true });
      expect(r2).toEqual({ ok: true });
      expect(r3).toEqual({ ok: true });
    });

    test('inFlightCount reflects active refreshes', async () => {
      const coordinator = loadCoordinator();
      let resolveRefresh;
      const refreshFn = () => new Promise(resolve => { resolveRefresh = resolve; });

      const p = coordinator.refreshCredential('cursor', refreshFn);
      expect(coordinator.inFlightCount()).toBe(1);

      resolveRefresh(true);
      await p;
      expect(coordinator.inFlightCount()).toBe(0);
    });
  });

  describe('different keys do not interfere', () => {
    test('parallel refreshes for different keys both execute', async () => {
      const coordinator = loadCoordinator();
      let traeCount = 0;
      let cursorCount = 0;

      const traeFn = () => new Promise(resolve => {
        traeCount++;
        setTimeout(() => resolve(true), 30);
      });
      const cursorFn = () => new Promise(resolve => {
        cursorCount++;
        setTimeout(() => resolve(true), 30);
      });

      const [r1, r2] = await Promise.all([
        coordinator.refreshCredential('trae', traeFn),
        coordinator.refreshCredential('cursor', cursorFn),
      ]);

      expect(traeCount).toBe(1);
      expect(cursorCount).toBe(1);
      expect(r1).toEqual({ ok: true });
      expect(r2).toEqual({ ok: true });
    });
  });

  describe('timeout returns failure', () => {
    test('returns {ok: false} with timeout message when refresh hangs', async () => {
      process.env.KHY_CREDENTIAL_REFRESH_TIMEOUT_MS = '100';
      const coordinator = loadCoordinator();
      const hangingFn = () => new Promise(() => {}); // never resolves

      const result = await coordinator.refreshCredential('trae', hangingFn);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/timeout/i);
    });
  });

  describe('refreshFn throwing does not propagate', () => {
    test('returns {ok: false} with error message when refreshFn throws', async () => {
      const coordinator = loadCoordinator();
      const throwingFn = () => Promise.reject(new Error('network failure'));

      const result = await coordinator.refreshCredential('windsurf', throwingFn);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('network failure');
    });

    test('returns {ok: false} when refreshFn throws synchronously', async () => {
      const coordinator = loadCoordinator();
      const throwingFn = () => { throw new Error('sync throw'); };

      const result = await coordinator.refreshCredential('windsurf', throwingFn);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('sync throw');
    });
  });

  describe('finally cleanup — can refresh again after failure/timeout', () => {
    test('can refresh same key again after previous refresh succeeds', async () => {
      const coordinator = loadCoordinator();
      let callCount = 0;
      const refreshFn = () => { callCount++; return Promise.resolve(true); };

      await coordinator.refreshCredential('trae', refreshFn);
      expect(callCount).toBe(1);
      expect(coordinator.inFlightCount()).toBe(0);

      await coordinator.refreshCredential('trae', refreshFn);
      expect(callCount).toBe(2);
    });

    test('can refresh same key again after previous refresh fails', async () => {
      const coordinator = loadCoordinator();
      let attempt = 0;
      const refreshFn = () => {
        attempt++;
        if (attempt === 1) return Promise.reject(new Error('first fails'));
        return Promise.resolve(true);
      };

      const r1 = await coordinator.refreshCredential('trae', refreshFn);
      expect(r1.ok).toBe(false);
      expect(coordinator.inFlightCount()).toBe(0);

      const r2 = await coordinator.refreshCredential('trae', refreshFn);
      expect(r2.ok).toBe(true);
    });

    test('can refresh same key again after timeout', async () => {
      process.env.KHY_CREDENTIAL_REFRESH_TIMEOUT_MS = '50';
      const coordinator = loadCoordinator();
      let attempt = 0;

      const r1 = await coordinator.refreshCredential('trae', () => {
        attempt++;
        return new Promise(() => {}); // hang
      });
      expect(r1.ok).toBe(false);
      expect(coordinator.inFlightCount()).toBe(0);

      const r2 = await coordinator.refreshCredential('trae', () => {
        attempt++;
        return Promise.resolve(true);
      });
      expect(r2.ok).toBe(true);
      expect(attempt).toBe(2);
    });
  });

  describe('invalid inputs', () => {
    test('returns {ok: false} for empty adapterKey', async () => {
      const coordinator = loadCoordinator();
      const result = await coordinator.refreshCredential('', () => Promise.resolve(true));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/invalid/i);
    });

    test('returns {ok: false} for null adapterKey', async () => {
      const coordinator = loadCoordinator();
      const result = await coordinator.refreshCredential(null, () => Promise.resolve(true));
      expect(result.ok).toBe(false);
    });

    test('returns {ok: false} when refreshFn is not a function', async () => {
      const coordinator = loadCoordinator();
      const result = await coordinator.refreshCredential('trae', 'not-a-function');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/invalid/i);
    });
  });

  describe('refreshFn returning falsy values', () => {
    test('returns {ok: false} when refreshFn returns null', async () => {
      const coordinator = loadCoordinator();
      const result = await coordinator.refreshCredential('trae', () => Promise.resolve(null));
      expect(result.ok).toBe(false);
    });

    test('returns {ok: false} when refreshFn returns false', async () => {
      const coordinator = loadCoordinator();
      const result = await coordinator.refreshCredential('trae', () => Promise.resolve(false));
      expect(result.ok).toBe(false);
    });

    test('returns {ok: true} when refreshFn returns truthy object', async () => {
      const coordinator = loadCoordinator();
      const result = await coordinator.refreshCredential('trae', () => Promise.resolve({ token: 'abc' }));
      expect(result.ok).toBe(true);
    });
  });
});
