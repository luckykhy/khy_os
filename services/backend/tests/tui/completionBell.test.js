'use strict';

/**
 * completionBell — unit coverage for the opt-in "ring the terminal on a long
 * turn's completion" experience knob (体感: 完成提醒). Exercises the PURE
 * decision `shouldRingCompletionBell`; the emit wrapper (env read + BEL write
 * to the TTY) is a thin best-effort shell around this predicate and is not
 * worth a process-level harness.
 *
 * Contract locked here:
 *   - off unless explicitly enabled (default silent — never surprise the user),
 *   - never rings without a real TTY (piped/CI output stays clean),
 *   - only rings for turns at or past the min duration (quick replies silent),
 *   - the min boundary is inclusive (elapsed == min rings).
 *
 * Runnable under both jest (describe/test/expect) and `node --test` via the
 * tiny shim below, because this checkout ships no jest binary.
 */

const { shouldRingCompletionBell } = require('../../src/cli/tui/hooks/useQueryBridge');

/* ── jest-or-node:test shim ─────────────────────────────────────────────── */
let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = nt.describe;
  _test = nt.test;
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
  });
}

/* ── tests ──────────────────────────────────────────────────────────────── */
_describe('shouldRingCompletionBell', () => {
  _test('stays silent when disabled even on a long TTY turn', () => {
    _expect(shouldRingCompletionBell({ enabled: false, elapsedMs: 60000, minMs: 10000, isTTY: true })).toBe(false);
  });

  _test('stays silent without a TTY (piped/CI output)', () => {
    _expect(shouldRingCompletionBell({ enabled: true, elapsedMs: 60000, minMs: 10000, isTTY: false })).toBe(false);
  });

  _test('stays silent for a quick turn below the minimum', () => {
    _expect(shouldRingCompletionBell({ enabled: true, elapsedMs: 1500, minMs: 10000, isTTY: true })).toBe(false);
  });

  _test('rings for a long enabled turn on a TTY', () => {
    _expect(shouldRingCompletionBell({ enabled: true, elapsedMs: 12000, minMs: 10000, isTTY: true })).toBe(true);
  });

  _test('min boundary is inclusive (elapsed == min rings)', () => {
    _expect(shouldRingCompletionBell({ enabled: true, elapsedMs: 10000, minMs: 10000, isTTY: true })).toBe(true);
  });

  _test('a zero minimum rings on any enabled TTY turn', () => {
    _expect(shouldRingCompletionBell({ enabled: true, elapsedMs: 0, minMs: 0, isTTY: true })).toBe(true);
  });
});
