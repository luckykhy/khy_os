'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_PRESSES,
  DEFAULT_WINDOW_MS,
  MIN_PRESSES,
  MAX_PRESSES,
  busyForceExitEnabled,
  resolveThreshold,
  resolveWindowMs,
  nextBusyInterruptState,
} = require('../../../../src/cli/repl/busyInterruptEscalation');

// ── busyForceExitEnabled: default-on, only 0/false/off/no disables ──────────
test('busyForceExitEnabled defaults on when unset', () => {
  assert.strictEqual(busyForceExitEnabled({}), true);
  assert.strictEqual(busyForceExitEnabled({ KHY_BUSY_FORCE_EXIT: undefined }), true);
});

test('busyForceExitEnabled off only for canonical falsy tokens', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(busyForceExitEnabled({ KHY_BUSY_FORCE_EXIT: v }), false, `expected off for ${JSON.stringify(v)}`);
  }
  for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
    assert.strictEqual(busyForceExitEnabled({ KHY_BUSY_FORCE_EXIT: v }), true, `expected on for ${JSON.stringify(v)}`);
  }
});

test('busyForceExitEnabled never throws on hostile env', () => {
  const hostile = { get KHY_BUSY_FORCE_EXIT() { throw new Error('boom'); } };
  assert.strictEqual(busyForceExitEnabled(hostile), true);
});

// ── resolveThreshold: default 3, clamped to [MIN,MAX], bad input → default ──
test('DEFAULT_PRESSES is 3 (用户原话「3 次 Ctrl+C 结束会话」)', () => {
  assert.strictEqual(DEFAULT_PRESSES, 3);
});

test('resolveThreshold default and clamping', () => {
  assert.strictEqual(resolveThreshold({}), DEFAULT_PRESSES);
  assert.strictEqual(resolveThreshold({ KHY_BUSY_FORCE_EXIT_PRESSES: '' }), DEFAULT_PRESSES);
  assert.strictEqual(resolveThreshold({ KHY_BUSY_FORCE_EXIT_PRESSES: '3' }), 3);
  assert.strictEqual(resolveThreshold({ KHY_BUSY_FORCE_EXIT_PRESSES: '1' }), MIN_PRESSES); // below min
  assert.strictEqual(resolveThreshold({ KHY_BUSY_FORCE_EXIT_PRESSES: '999' }), MAX_PRESSES); // above max
  assert.strictEqual(resolveThreshold({ KHY_BUSY_FORCE_EXIT_PRESSES: 'abc' }), DEFAULT_PRESSES); // NaN
});

// ── resolveWindowMs: default 3000, clamped, bad input → default ─────────────
test('resolveWindowMs default and clamping', () => {
  assert.strictEqual(resolveWindowMs({}), DEFAULT_WINDOW_MS);
  assert.strictEqual(resolveWindowMs({ KHY_BUSY_FORCE_EXIT_WINDOW_MS: '5000' }), 5000);
  assert.strictEqual(resolveWindowMs({ KHY_BUSY_FORCE_EXIT_WINDOW_MS: '10' }), 500); // below min
  assert.strictEqual(resolveWindowMs({ KHY_BUSY_FORCE_EXIT_WINDOW_MS: '99999' }), 30000); // above max
  assert.strictEqual(resolveWindowMs({ KHY_BUSY_FORCE_EXIT_WINDOW_MS: 'xyz' }), DEFAULT_WINDOW_MS);
});

// ── nextBusyInterruptState: core state machine ─────────────────────────────
test('first press starts a new sequence (count 1, no force exit)', () => {
  const s = nextBusyInterruptState(null, 1000, { threshold: 2, windowMs: 3000 });
  assert.strictEqual(s.count, 1);
  assert.strictEqual(s.lastTs, 1000);
  assert.strictEqual(s.shouldForceExit, false);
});

test('second press within window escalates to force exit (threshold 2)', () => {
  const s1 = nextBusyInterruptState(null, 1000, { threshold: 2, windowMs: 3000 });
  const s2 = nextBusyInterruptState(s1, 1500, { threshold: 2, windowMs: 3000 });
  assert.strictEqual(s2.count, 2);
  assert.strictEqual(s2.shouldForceExit, true);
});

test('second press AFTER window resets to a fresh first press', () => {
  const s1 = nextBusyInterruptState(null, 1000, { threshold: 2, windowMs: 3000 });
  const s2 = nextBusyInterruptState(s1, 1000 + 3001, { threshold: 2, windowMs: 3000 });
  assert.strictEqual(s2.count, 1);
  assert.strictEqual(s2.shouldForceExit, false);
});

test('threshold 3 requires three presses within window', () => {
  const s1 = nextBusyInterruptState(null, 1000, { threshold: 3, windowMs: 3000 });
  const s2 = nextBusyInterruptState(s1, 1200, { threshold: 3, windowMs: 3000 });
  const s3 = nextBusyInterruptState(s2, 1400, { threshold: 3, windowMs: 3000 });
  assert.strictEqual(s1.shouldForceExit, false);
  assert.strictEqual(s2.shouldForceExit, false);
  assert.strictEqual(s3.shouldForceExit, true);
  assert.strictEqual(s3.count, 3);
});

test('nextBusyInterruptState is defensive against bad input (never throws)', () => {
  assert.doesNotThrow(() => nextBusyInterruptState(undefined, NaN, {}));
  const s = nextBusyInterruptState({ count: 'x', lastTs: 'y' }, 1000, {});
  assert.strictEqual(s.count, 1); // garbage prev → treated as fresh
  assert.strictEqual(s.shouldForceExit, false);
});

test('uses default threshold/window when opts omitted (DEFAULT_PRESSES === 3)', () => {
  const s1 = nextBusyInterruptState(null, 1000);
  const s2 = nextBusyInterruptState(s1, 1500);
  const s3 = nextBusyInterruptState(s2, 2000);
  assert.strictEqual(s1.shouldForceExit, false);
  assert.strictEqual(s2.shouldForceExit, false); // 前两次先走优雅取消
  assert.strictEqual(s3.shouldForceExit, true);  // 第 3 次强制结束会话
});
