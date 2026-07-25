'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function mockRegistry(appManifest) {
  jest.doMock('../src/services/appRegistry', () => ({
    get: jest.fn(() => appManifest),
  }));
}

function elapsedMs(startNs, endNs) {
  return Number(endNs - startNs) / 1e6;
}

describe('wasmAppService performance and cache behavior', () => {
  test('hot run is significantly faster than cold run and reuses instantiated module', async () => {
    jest.resetModules();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wasm-perf-'));
    const wasmPath = path.join(tmpDir, 'mock.wasm');
    fs.writeFileSync(wasmPath, Buffer.from([0x00]));

    mockRegistry({
      name: 'perf-app',
      runtime: 'wasm',
      entry: wasmPath,
      wasm: {
        path: wasmPath,
        abi: 'numeric-v1',
        defaultExport: 'main',
        capabilities: ['ipc'],
      },
    });

    const coldDelayMs = 120;
    const instantiateSpy = jest.spyOn(WebAssembly, 'instantiate').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, coldDelayMs));
      return {
        module: {},
        instance: {
          exports: {
            main: () => 123,
          },
        },
      };
    });
    const exportsSpy = jest.spyOn(WebAssembly.Module, 'exports').mockReturnValue([
      { kind: 'function', name: 'main' },
    ]);
    const importsSpy = jest.spyOn(WebAssembly.Module, 'imports').mockReturnValue([]);

    try {
      const wasmService = require('../src/services/wasmAppService');

      const t0 = process.hrtime.bigint();
      const first = await wasmService.runFunction('perf-app', 'main', []);
      const t1 = process.hrtime.bigint();
      const second = await wasmService.runFunction('perf-app', 'main', []);
      const t2 = process.hrtime.bigint();

      const coldMs = elapsedMs(t0, t1);
      const hotMs = elapsedMs(t1, t2);

      expect(first.result).toBe(123);
      expect(second.result).toBe(123);
      expect(instantiateSpy).toHaveBeenCalledTimes(1);
      expect(coldMs).toBeGreaterThanOrEqual(coldDelayMs * 0.7);
      expect(hotMs).toBeLessThan(coldDelayMs * 0.5);
    } finally {
      instantiateSpy.mockRestore();
      exportsSpy.mockRestore();
      importsSpy.mockRestore();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('cache invalidates and reloads module when wasm file changes', async () => {
    jest.resetModules();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wasm-perf-'));
    const wasmPath = path.join(tmpDir, 'mock.wasm');
    fs.writeFileSync(wasmPath, Buffer.from([0x00]));

    mockRegistry({
      name: 'perf-reload',
      runtime: 'wasm',
      entry: wasmPath,
      wasm: {
        path: wasmPath,
        abi: 'numeric-v1',
        defaultExport: 'main',
        capabilities: ['ipc'],
      },
    });

    let buildId = 0;
    const instantiateSpy = jest.spyOn(WebAssembly, 'instantiate').mockImplementation(async () => {
      buildId += 1;
      const currentBuildId = buildId;
      return {
        module: {},
        instance: {
          exports: {
            main: () => currentBuildId,
          },
        },
      };
    });
    const exportsSpy = jest.spyOn(WebAssembly.Module, 'exports').mockReturnValue([
      { kind: 'function', name: 'main' },
    ]);
    const importsSpy = jest.spyOn(WebAssembly.Module, 'imports').mockReturnValue([]);

    try {
      const wasmService = require('../src/services/wasmAppService');

      const first = await wasmService.runFunction('perf-reload', 'main', []);
      fs.appendFileSync(wasmPath, Buffer.from([0x01]));
      const second = await wasmService.runFunction('perf-reload', 'main', []);

      expect(first.result).toBe(1);
      expect(second.result).toBe(2);
      expect(instantiateSpy).toHaveBeenCalledTimes(2);
    } finally {
      instantiateSpy.mockRestore();
      exportsSpy.mockRestore();
      importsSpy.mockRestore();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
