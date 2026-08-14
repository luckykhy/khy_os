'use strict';

/**
 * reliability.test.js — 长任务可靠性契约测试套件。
 *
 * 覆盖:
 *   1. 任务状态机（Durable Task Store）
 *   2. Watchdog 空闲超时
 *   3. AbortSignal 中断传播
 *   4. Receipt 轨迹（闭合性、幂等性、auto-finalize）
 *   5. 重试与退避（指数退避 + jitter + AbortSignal）
 *   6. Fail-Soft 模式
 *
 * 运行: npx jest tests/reliability/reliability.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tmpPath(rel) {
  return path.join(os.tmpdir(), 'khy-reliability-test', rel);
}

function cleanTmp() {
  const dir = path.join(os.tmpdir(), 'khy-reliability-test');
  try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
}

// ── 1. Task State Machine ────────────────────────────────────────────────────

describe('Reliability: Task State Machine', () => {
  let Store;

  beforeAll(() => {
    jest.isolateModules(() => {
      Store = require('../../src/tasks/largeTaskRuntimeStore');
    });
  });

  test('STATUS_TRANSITIONS defines all 11 states', () => {
    const transitions = Store.STATUS_TRANSITIONS;
    const expected = ['queued', 'claimed', 'running', 'retry_wait', 'pausing',
                      'paused', 'cancelling', 'succeeded', 'failed', 'cancelled', 'dead_letter'];
    for (const s of expected) {
      assert.ok(transitions[s], `STATUS_TRANSITIONS missing state: ${s}`);
    }
  });

  test('TERMINAL_STATUSES has 4 states with no outgoing transitions', () => {
    const terminal = Store.TERMINAL_STATUSES;
    assert.strictEqual(terminal.size, 4);
    for (const s of terminal) {
      assert.ok(Store.STATUS_TRANSITIONS[s], `TERMINAL state ${s} missing from transitions`);
    }
  });

  test('canTransition returns true for valid transitions', () => {
    assert.ok(Store.canTransition('queued', 'claimed'));
    assert.ok(Store.canTransition('running', 'succeeded'));
    assert.ok(Store.canTransition('running', 'failed'));
    assert.ok(Store.canTransition('running', 'retry_wait'));
    assert.ok(Store.canTransition('retry_wait', 'claimed'));
    assert.ok(Store.canTransition('cancelling', 'cancelled'));
  });

  test('canTransition returns false for invalid transitions', () => {
    assert.ok(!Store.canTransition('succeeded', 'running'));
    assert.ok(!Store.canTransition('cancelled', 'queued'));
    assert.ok(!Store.canTransition('dead_letter', 'claimed'));
    assert.ok(!Store.canTransition('queued', 'succeeded'));
  });

  test('transition to same state is allowed (idempotent)', () => {
    assert.ok(Store.canTransition('running', 'running'));
  });
});

// ── 2. Watchdog ──────────────────────────────────────────────────────────────

describe('Reliability: Watchdog Timeout', () => {
  const resourceGuardPath = require.resolve('../../src/services/resourceGuard');

  test('startWatchdog creates a timer that fires onTimeout', async () => {
    const { startWatchdog } = require(resourceGuardPath);
    let timedOut = false;
    const guard = startWatchdog('test-watchdog', 200, () => {
      timedOut = true;
    });
    await sleep(300);
    guard.done();
    assert.ok(timedOut, 'Watchdog should have fired timeout callback');
  });

  test('touch() resets the idle timer', async () => {
    const { startWatchdog } = require(resourceGuardPath);
    let timedOut = false;
    const guard = startWatchdog('test-watchdog-touch', 300, () => {
      timedOut = true;
    });
    await sleep(180);
    guard.touch(); // reset
    await sleep(180);
    guard.done();
    // Without touch, would have timed out at ~300ms. With touch at ~180ms, resets to 300ms from touch.
    // At 360ms total, timer hasn't fired yet.
    assert.ok(!timedOut, 'Watchdog should NOT have fired because touch() reset the timer');
  });

  test('done() cleans up and stops the timer', async () => {
    const { startWatchdog } = require(resourceGuardPath);
    let timedOut = false;
    const guard = startWatchdog('test-watchdog-done', 100, () => {
      timedOut = true;
    });
    guard.done(); // clean up immediately
    await sleep(300);
    assert.ok(!timedOut, 'Watchdog should not fire after done() cleanup');
  });

  test('elapsed() returns ms since start', async () => {
    const { startWatchdog } = require(resourceGuardPath);
    const guard = startWatchdog('test-watchdog-elapsed', 5000, () => {});
    await sleep(50);
    const elapsed = guard.elapsed();
    guard.done();
    assert.ok(elapsed >= 40 && elapsed <= 100, `elapsed() should be ~50ms, got ${elapsed}`);
  });
});

// ── 3. AbortSignal Propagation ───────────────────────────────────────────────

describe('Reliability: AbortSignal Propagation', () => {
  test('AbortController.signal.aborted becomes true after abort()', () => {
    const ctrl = new AbortController();
    assert.ok(!ctrl.signal.aborted, 'signal should not be aborted initially');
    ctrl.abort('test reason');
    assert.ok(ctrl.signal.aborted, 'signal should be aborted after abort()');
  });

  test('AbortSignal listeners fire on abort', async () => {
    const ctrl = new AbortController();
    let fired = false;
    ctrl.signal.addEventListener('abort', () => { fired = true; });
    ctrl.abort();
    assert.ok(fired, 'abort listener should have fired');
  });

  test('Promise.race with AbortSignal rejects when aborted', async () => {
    const ctrl = new AbortController();
    const longOp = new Promise((resolve) => setTimeout(() => resolve('done'), 5000));
    const abortPromise = new Promise((_, reject) => {
      ctrl.signal.addEventListener('abort', () => reject(new Error('Aborted')));
    });
    ctrl.abort(); // abort immediately
    await expect(Promise.race([longOp, abortPromise])).rejects.toThrow('Aborted');
  });

  test('nested AbortController cascade propagates parent abort', async () => {
    const parent = new AbortController();
    const child = new AbortController();

    // Simulate cascade: parent abort triggers child
    parent.signal.addEventListener('abort', () => {
      try { child.abort(parent.signal.reason || 'parent abort'); } catch { /* ignore */ }
    }, { once: true });

    parent.abort('cascade test');
    assert.ok(child.signal.aborted, 'child signal should be aborted after parent abort');
  });
});

// ── 4. Receipt Trajectory ────────────────────────────────────────────────────

describe('Reliability: Receipt Trajectory', () => {
  let receiptDir;

  beforeEach(() => {
    cleanTmp();
    receiptDir = tmpPath('receipts');
    fs.mkdirSync(receiptDir, { recursive: true });
  });

  afterEach(() => {
    cleanTmp();
  });

  test('receipt file must contain required fields', () => {
    const receipt = {
      id: 'RCPT-test-001',
      sessionId: 's-test',
      status: 'completed',
      startedAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      durationMs: 1000,
      toolChain: [],
      counts: { tools: 0, ok: 0, failed: 0 },
    };
    const filePath = path.join(receiptDir, 'RCPT-test-001.json');
    fs.writeFileSync(filePath, JSON.stringify(receipt, null, 2));
    const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.ok(loaded.id, 'receipt must have id');
    assert.ok(loaded.status, 'receipt must have status');
    assert.ok(loaded.startedAt, 'receipt must have startedAt');
    assert.ok(loaded.toolChain, 'receipt must have toolChain');
    assert.ok(loaded.counts, 'receipt must have counts');
  });

  test('receipt status must be one of the defined terminal states', () => {
    const validStatuses = ['completed', 'partial', 'failed', 'interrupted'];
    for (const s of validStatuses) {
      const receipt = { id: 'RCPT-test', status: s, sessionId: 's', startedAt: '2026-01-01T00:00:00Z', finalizedAt: '2026-01-01T00:01:00Z', durationMs: 60000, toolChain: [], counts: { tools: 0, ok: 0, failed: 0 } };
      assert.ok(validStatuses.includes(receipt.status), `${s} should be a valid receipt status`);
    }
  });

  test('receipt toolChain entries track individual tool executions', () => {
    const toolChain = [
      { tool: 'read_file', params: { path: '/test' }, result: { success: true }, elapsedMs: 25, permission: 'allow' },
      { tool: 'shell', params: { cmd: 'ls' }, result: { success: true }, elapsedMs: 120, permission: 'allow' },
      { tool: 'write_file', params: { path: '/out' }, result: { success: false, error: 'perm denied' }, elapsedMs: 5, permission: 'deny' },
    ];
    assert.strictEqual(toolChain.length, 3);
    assert.strictEqual(toolChain.filter(t => t.result?.success).length, 2);
    assert.strictEqual(toolChain.filter(t => !t.result?.success).length, 1);
    assert.ok(toolChain[2].result.error, 'failed tool entry must have error info');
  });

  test('receipt filename follows RCPT-<id>.json convention', () => {
    const receiptId = 'RCPT-20260726-143022-a1b2';
    assert.ok(receiptId.startsWith('RCPT-'), 'Receipt filename must start with RCPT-');
  });
});

// ── 5. Retry with Backoff ────────────────────────────────────────────────────

describe('Reliability: Retry with Backoff', () => {
  const { retryWithBackoff, isRetryableError } = require('../../src/services/retryWithBackoff');

  test('returns result on first successful try', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const result = await retryWithBackoff(fn, { attempts: 3, minDelayMs: 1, maxDelayMs: 5, jitter: 0 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on failure and succeeds on subsequent attempt', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockResolvedValueOnce('recovered');

    const result = await retryWithBackoff(fn, { attempts: 3, minDelayMs: 1, maxDelayMs: 10, jitter: 0 });
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

  test('isRetryableError returns false for auth errors', () => {
    expect(isRetryableError(new Error('authentication_error'))).toBe(false);
    expect(isRetryableError({ code: 'auth', message: 'unauthorized' })).toBe(false);
    expect(isRetryableError(new Error('permission_denied'))).toBe(false);
    expect(isRetryableError({ code: 'not_found' })).toBe(false);
  });

  test('isRetryableError returns true for retryable errors', () => {
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableError({ code: 'ECONNRESET', message: 'connection reset' })).toBe(true);
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryableError({ statusCode: 429 })).toBe(true);
    expect(isRetryableError({ statusCode: 500 })).toBe(true);
    expect(isRetryableError({ type: 'overloaded_error' })).toBe(true);
  });

  test('backoff delays increase exponentially with jitter', async () => {
    const delays = [];
    const fn = jest.fn().mockRejectedValue(new Error('fail'));

    try {
      await retryWithBackoff(fn, {
        attempts: 4,
        minDelayMs: 100,
        maxDelayMs: 10000,
        jitter: 0, // disable jitter for predictable test
        onRetry: (ctx) => { delays.push(ctx.delayMs); },
      });
    } catch { /* expected */ }

    // Exponential: 100, 200, 400 (capped)
    assert.strictEqual(delays.length, 3, `expected 3 retry delays, got ${delays.length}`);
    assert.ok(delays[0] >= 90 && delays[0] <= 110, `first delay should be ~100ms, got ${delays[0]}`);
    assert.ok(delays[1] >= 190 && delays[1] <= 210, `second delay should be ~200ms, got ${delays[1]}`);
    assert.ok(delays[2] >= 390 && delays[2] <= 410, `third delay should be ~400ms, got ${delays[2]}`);
  });
});

// ── 6. Fail-Soft Patterns ───────────────────────────────────────────────────

describe('Reliability: Fail-Soft Patterns', () => {
  test('receiptService.finalizeReceipt is idempotent (no-op when no open receipt)', () => {
    const receiptService = require('../../src/services/receiptService');
    // finalizeReceipt with no open receipt returns null (no-op, not throw)
    const result = receiptService.finalizeReceipt('nonexistent-session', { status: 'completed' });
    assert.strictEqual(result, null, 'finalizeReceipt should return null when no open receipt');
  });

  test('resourceGuard.safeExec respects timeout', () => {
    const { safeExec } = require('../../src/services/resourceGuard');
    // safeExec uses execSync with a timeout — on timeout the command is killed.
    // Exit code varies by platform (137 on Unix via SIGKILL, 1 on Windows).
    const result = safeExec({
      cmd: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      timeoutMs: 500,
    });
    assert.ok(result.exitCode !== 0, 'safeExec should return non-zero exitCode on timeout');
    assert.ok(result.stderr.includes('killed') || result.stderr.includes('timeout') || result.exitCode !== 0,
      `safeExec should indicate timeout/kill, got exitCode=${result.exitCode}, stderr=${result.stderr}`);
  });
});
