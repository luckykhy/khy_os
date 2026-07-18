/**
 * Unit tests for graceful shutdown logic.
 */

describe('graceful shutdown', () => {
  test('httpServer hook resolves when server.close completes before timeout', async () => {
    let closeCallback;
    const mockServer = {
      close: (cb) => { closeCallback = cb; },
    };

    const hookPromise = new Promise((resolve) => {
      const timer = setTimeout(() => { resolve('timeout'); }, 3000);
      mockServer.close(() => {
        clearTimeout(timer);
        resolve('closed');
      });
    });

    // Simulate server closing immediately
    closeCallback();

    const result = await hookPromise;
    expect(result).toBe('closed');
  });

  test('httpServer hook resolves via timeout when server.close hangs', async () => {
    const mockServer = {
      close: () => { /* never calls callback */ },
    };

    const hookPromise = new Promise((resolve) => {
      const timer = setTimeout(() => { resolve('timeout'); }, 50); // short timeout for test
      mockServer.close(() => {
        clearTimeout(timer);
        resolve('closed');
      });
    });

    const result = await hookPromise;
    expect(result).toBe('timeout');
  });

  test('resolve is only called once even if both paths fire', async () => {
    let resolveCount = 0;
    let closeCallback;
    const mockServer = {
      close: (cb) => { closeCallback = cb; },
    };

    await new Promise((outerResolve) => {
      const hookPromise = new Promise((resolve) => {
        const origResolve = (val) => { resolveCount++; resolve(val); };
        const timer = setTimeout(() => { origResolve('timeout'); }, 20);
        mockServer.close(() => {
          clearTimeout(timer);
          origResolve('closed');
        });
      });

      // Fire close callback after a short delay (within timeout window)
      setTimeout(() => { closeCallback(); }, 5);

      hookPromise.then(() => {
        // Wait a bit more to ensure timeout doesn't fire again
        setTimeout(() => { outerResolve(); }, 50);
      });
    });

    // Promise.resolve is idempotent, but our custom counter should be 1
    expect(resolveCount).toBe(1);
  });

  test('shutdown hooks run in parallel', async () => {
    const order = [];
    const hooks = [
      { name: 'fast', fn: async () => { order.push('fast-start'); await delay(10); order.push('fast-end'); } },
      { name: 'slow', fn: async () => { order.push('slow-start'); await delay(30); order.push('slow-end'); } },
    ];

    // Simulate parallel execution like the bootstrap module
    await Promise.all(hooks.map(h => h.fn()));

    expect(order[0]).toBe('fast-start');
    expect(order[1]).toBe('slow-start');
    expect(order).toContain('fast-end');
    expect(order).toContain('slow-end');
  });
});

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}
