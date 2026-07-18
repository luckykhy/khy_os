'use strict';

function mockDeps({ runImpl, appManifest }) {
  const printSuccess = jest.fn();
  const printError = jest.fn();
  const printInfo = jest.fn();
  const printTable = jest.fn();
  jest.doMock('../src/cli/formatters', () => ({
    printSuccess,
    printError,
    printInfo,
    printTable,
  }));

  jest.doMock('../src/services/appRegistry', () => ({
    get: jest.fn(() => appManifest || {
      name: 'demo',
      runtime: 'wasm',
      wasm: { abi: 'numeric-v1', defaultExport: 'main' },
    }),
  }));

  const runFunction = jest.fn(runImpl);
  jest.doMock('../src/services/wasmAppService', () => ({
    runFunction,
  }));

  const trackAppRunLatency = jest.fn(() => ({
    app: 'demo',
    count: 3,
    successCount: 3,
    failureCount: 0,
    lastMs: 12,
    p50: 10,
    p95: 22,
  }));
  jest.doMock('../src/services/telemetryService', () => ({
    trackAppRunLatency,
  }));

  return {
    printSuccess,
    printError,
    printInfo,
    printTable,
    runFunction,
    trackAppRunLatency,
  };
}

describe('/app run latency output', () => {
  test('prints latency with p50/p95 on success', async () => {
    jest.resetModules();
    const deps = mockDeps({
      runImpl: async () => ({
        app: 'demo',
        exportName: 'main',
        args: [1],
        result: 42,
      }),
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const { handleApp } = require('../src/cli/handlers/app');
      await handleApp('run', ['demo', 'main', '1'], {});

      expect(deps.runFunction).toHaveBeenCalledTimes(1);
      expect(deps.trackAppRunLatency).toHaveBeenCalledWith(expect.objectContaining({
        app: 'demo',
        success: true,
      }));
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/latency:\d+ms\s+p50:\d+ms\s+p95:\d+ms/));
    } finally {
      logSpy.mockRestore();
    }
  });

  test('records failure sample when runFunction throws', async () => {
    jest.resetModules();
    const deps = mockDeps({
      runImpl: async () => {
        throw new Error('boom');
      },
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const { handleApp } = require('../src/cli/handlers/app');
      await handleApp('run', ['demo', 'main', '1'], {});

      expect(deps.trackAppRunLatency).toHaveBeenCalledWith(expect.objectContaining({
        app: 'demo',
        success: false,
      }));
      expect(deps.printError).toHaveBeenCalledWith(expect.stringMatching(/WASM 执行失败/));
    } finally {
      logSpy.mockRestore();
    }
  });
});
