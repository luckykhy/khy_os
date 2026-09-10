'use strict';

const { createDeferredStatusFlush } = require('../../src/cli/repl/deferredStatuses');

// Mock aiRenderer
jest.mock('../../src/cli/aiRenderer', () => ({
  printStepLine: jest.fn()
}));

describe('deferredStatuses', () => {
  const { printStepLine } = require('../../src/cli/aiRenderer');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does nothing for empty array', () => {
    const flush = createDeferredStatusFlush([]);
    flush();
    expect(printStepLine).not.toHaveBeenCalled();
  });

  test('skips plan phase', () => {
    const deferred = [{ phase: 'plan', text: 'Plan text' }];
    const flush = createDeferredStatusFlush(deferred);
    flush();
    expect(printStepLine).not.toHaveBeenCalled();
  });

  test('skips metrics noise', () => {
    const deferred = [{ phase: 'status', text: 'Metrics updated' }];
    const flush = createDeferredStatusFlush(deferred);
    flush();
    expect(printStepLine).not.toHaveBeenCalled();
  });

  test('skips completion confirmations', () => {
    const deferred = [{ phase: 'status', text: '完成处理' }];
    const flush = createDeferredStatusFlush(deferred);
    flush();
    expect(printStepLine).not.toHaveBeenCalled();
  });

  test('replays valid statuses', () => {
    const deferred = [
      { phase: 'loading', text: 'Loading data...' },
      { phase: 'done', text: 'Data loaded' }
    ];
    const flush = createDeferredStatusFlush(deferred);
    flush();
    expect(printStepLine).toHaveBeenCalledTimes(2);
  });

  test('clears the deferred array after flush', () => {
    const deferred = [{ phase: 'loading', text: 'Loading...' }];
    const flush = createDeferredStatusFlush(deferred);
    flush();
    expect(deferred).toEqual([]);
  });
});
