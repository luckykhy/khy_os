'use strict';
/**
 * retryableLoopOutcomeHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the retryable-error-type Set and the
 * two cooldown-detection regexes out of _isRetryableLoopOutcome. They were
 * rebuilt on every retry decision; now they are built once at module load. The
 * Set is consumed read-only via `.has`; the regexes use `.test()` only and carry
 * NO `/g` flag (so no lastIndex leaks across shared calls). None escape (the
 * function returns a boolean). Repeated-call stability is asserted explicitly.
 */
const { _internals } = require('../../src/services/agenticHarnessService');
const isRetryable = _internals._isRetryableLoopOutcome;

describe('Retryable Loop Outcome Hoist', () => {
  test('retryable error types with zero tool calls are retryable', () => {
      for (const t of ['timeout', 'network', 'process', 'unknown', 'cancelled']) {
        expect(isRetryable({ errorType: t, toolCallLog: [] })).toBe(true, `${t} should be retryable`);
      }
  });

  test('non-retryable error type or tool calls present → not retryable', () => {
      expect(isRetryable({ errorType: 'auth', toolCallLog: [] })).toBe(false);
      expect(isRetryable({ errorType: 'timeout', toolCallLog: [{}] })).toBe(false);
      expect(isRetryable({ toolCallLog: [] })).toBe(false); // empty errorType
      expect(isRetryable(null)).toBe(false);
  });

  test('cooldown / recent-failure-cached content blocks retry', () => {
      expect(isRetryable({ errorType: 'network', content: 'model in cooldown', toolCallLog: [] })).toBe(false);
      expect(isRetryable({ errorType: 'network', finalResponse: 'recent failure was cached', toolCallLog: [] })).toBe(false);
  });

  test('shared regexes are stable across repeated calls (no /g lastIndex leak)', () => {
      // A cooldown string must ALWAYS block, and a clean string must ALWAYS pass,
      // regardless of call order — proving no leaked regex state.
      for (let i = 0; i < 5; i++) {
        expect(isRetryable({ errorType: 'network', content: 'cooldown', toolCallLog: [] })).toBe(false, `iter ${i} cooldown`);
        expect(isRetryable({ errorType: 'network', content: '', toolCallLog: [] })).toBe(true, `iter ${i} clean`);
      }
  });

});
