'use strict';
/**
 * largeTaskRuntimeStability.test.js â€?regression suite for the two runtime
 * stability fixes:
 *   Fix 1: idempotent in_progress records gain a TTL-based takeover so a
 *          crashed process can no longer permanently block retries.
 *   Fix 2: the idle watchdog actively stops lease renewal and aborts a hung
 *          handler via ctx.signal instead of passively waiting forever.
 *
 * node:test style (Jest excludes this style automatically).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLargeTaskRuntimeStore } = require('../../src/tasks/largeTaskRuntimeStore');
const { createLargeTaskOrchestrator } = require('../../src/tasks/largeTaskOrchestrator');
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ltr-stability-'));
  return { dir, storePath: path.join(dir, 'large_task_runtime.json') };
}
function cleanupSandbox(dir) {
  // Best-effort cleanup; leftover tmp dirs are harmless on CI hosts.
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('Large Task Runtime Stability', () => {
  test('Fix1: fresh in_progress record within default TTL still blocks (behavior conserved)', async () => {
      const { dir, storePath } = makeSandbox();
      let releaseHang = null;
      let hangPromise = null;
      try {
        const store = createLargeTaskRuntimeStore({ storePath });
        // First call persists an in_progress record and hangs in its executor.
        hangPromise = store.executeIdempotentSideEffect({
          scope: 'stability',
          idempotency_key: 'fresh-key',
          executor: () => new Promise((resolve) => { releaseHang = resolve; }),
        });
        await new Promise((resolve) => setImmediate(resolve));
    
        let secondExecuted = false;
        const second = await store.executeIdempotentSideEffect({
          scope: 'stability',
          idempotency_key: 'fresh-key',
          executor: async () => { secondExecuted = true; return 'never'; },
        });
    
        expect(second.ok).toBe(false);
        expect(second.code).toBe('idempotency_in_progress');
        expect(secondExecuted).toBe(false);
        expect(second.record.status).toBe('in_progress');
      } finally {
        // Release the hung executor so no promise/lock handle leaks.
        if (releaseHang) releaseHang('done');
        if (hangPromise) await hangPromise.catch(() => {});
        cleanupSandbox(dir);
      }
  });

  test('Fix1: stale in_progress record past TTL is taken over and re-executed', async () => {
      const { dir, storePath } = makeSandbox();
      let releaseHang = null;
      let hangPromise = null;
      try {
        // nowFn writes updated_at 60s in the past; staleness itself is judged
        // against the real Date.now(), so the record is immediately stale vs TTL=1s.
        const pastMs = Date.now() - 60_000;
        const store = createLargeTaskRuntimeStore({
          storePath,
          nowFn: () => pastMs,
          idempotency_in_progress_ttl_ms: 1_000,
        });
        hangPromise = store.executeIdempotentSideEffect({
          scope: 'stability',
          idempotency_key: 'stale-key',
          executor: () => new Promise((resolve) => { releaseHang = resolve; }),
        });
        await new Promise((resolve) => setImmediate(resolve));
    
        let executedCount = 0;
        const second = await store.executeIdempotentSideEffect({
          scope: 'stability',
          idempotency_key: 'stale-key',
          executor: async () => { executedCount += 1; return 'takeover-result'; },
        });
    
        expect(second.ok).toBe(true);
        expect(second.replayed).toBe(false);
        expect(executedCount).toBe(1);
        expect(second.result).toBe('takeover-result');
        expect(second.record.takeover_count).toBe(1);
        expect(second.record.status).toBe('succeeded');
      } finally {
        if (releaseHang) releaseHang('late');
        if (hangPromise) await hangPromise.catch(() => {});
        cleanupSandbox(dir);
      }
  });

  test('Fix1: idempotency_in_progress_ttl_ms=0 disables takeover even for very old records', async () => {
      const { dir, storePath } = makeSandbox();
      let releaseHang = null;
      let hangPromise = null;
      try {
        const pastMs = Date.now() - 3_600_000; // one hour old, way past any TTL
        const store = createLargeTaskRuntimeStore({
          storePath,
          nowFn: () => pastMs,
          idempotency_in_progress_ttl_ms: 0,
        });
        hangPromise = store.executeIdempotentSideEffect({
          scope: 'stability',
          idempotency_key: 'disabled-key',
          executor: () => new Promise((resolve) => { releaseHang = resolve; }),
        });
        await new Promise((resolve) => setImmediate(resolve));
    
        let secondExecuted = false;
        const second = await store.executeIdempotentSideEffect({
          scope: 'stability',
          idempotency_key: 'disabled-key',
          executor: async () => { secondExecuted = true; return 'never'; },
        });
    
        expect(second.ok).toBe(false);
        expect(second.code).toBe('idempotency_in_progress');
        expect(secondExecuted).toBe(false);
      } finally {
        if (releaseHang) releaseHang('done');
        if (hangPromise) await hangPromise.catch(() => {});
        cleanupSandbox(dir);
      }
  });

  test('Fix2: idle watchdog actively aborts a hung handler via ctx.signal', async () => {
      const { dir, storePath } = makeSandbox();
      try {
        const store = createLargeTaskRuntimeStore({ storePath });
        const orchestrator = createLargeTaskOrchestrator({
          runtime: store,
          workerId: 'stability-worker',
        });
        const created = orchestrator.createTask({ type: 'stability_hang' });
    
        let capturedCtx = null;
        const result = await orchestrator.runTask(
          created.id,
          (ctx) => {
            capturedCtx = ctx;
            // Hang forever without markActivity; only the abort signal releases it.
            return new Promise((resolve, reject) => {
              ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
          },
          { idle_timeout_ms: 500, heartbeat_ms: 500 }
        );
    
        expect(result.ok).toBe(false);
        expect(result.error.type).toBe('task_idle_timeout');
        expect(result.retry_scheduled).toBe(true);
        expect(capturedCtx).toBeTruthy();
        expect(capturedCtx.signal.aborted).toBe(true);
      } finally {
        cleanupSandbox(dir);
      }
  });

  test('Fix2: fast successful handler is unaffected (identity regression)', async () => {
      const { dir, storePath } = makeSandbox();
      try {
        const store = createLargeTaskRuntimeStore({ storePath });
        const orchestrator = createLargeTaskOrchestrator({
          runtime: store,
          workerId: 'stability-worker',
        });
        const created = orchestrator.createTask({ type: 'stability_fast' });
    
        const result = await orchestrator.runTask(
          created.id,
          async (ctx) => {
            expect(ctx.signal instanceof AbortSignal).toBeTruthy();
            expect(ctx.signal.aborted).toBe(false);
            ctx.markActivity();
            return { done: true };
          },
          { idle_timeout_ms: 5_000 }
        );
    
        expect(result.ok).toBe(true);
        expect(result.task.status).toBe('succeeded');
        assert.deepEqual(result.result, { done: true });
      } finally {
        cleanupSandbox(dir);
      }
  });

});

