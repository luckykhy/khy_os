'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function mockRegistry(appManifest) {
  jest.doMock('../src/services/appRegistry', () => ({
    get: jest.fn(() => appManifest),
  }));
}

describe('wasmAppService numeric-v1 khy_sys ABI precheck', () => {
  test('fails before calling export when khy_sys.ipc_call import exists but expected memory export is missing', async () => {
    jest.resetModules();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wasm-precheck-'));
    const wasmPath = path.join(tmpDir, 'mock.wasm');
    fs.writeFileSync(wasmPath, Buffer.from([0x00]));

    mockRegistry({
      name: 'moon-precheck',
      runtime: 'wasm',
      entry: wasmPath,
      wasm: {
        path: wasmPath,
        abi: 'numeric-v1',
        defaultExport: 'main',
        capabilities: ['ipc', 'net'],
        khySys: { memoryExport: 'memory' },
      },
    });

    let called = false;
    const instantiateSpy = jest.spyOn(WebAssembly, 'instantiate').mockImplementation(async () => ({
      module: {},
      instance: {
        exports: {
          main: () => {
            called = true;
            return 0;
          },
        },
      },
    }));
    const exportsSpy = jest.spyOn(WebAssembly.Module, 'exports').mockReturnValue([
      { kind: 'function', name: 'main' },
    ]);
    const importsSpy = jest.spyOn(WebAssembly.Module, 'imports').mockReturnValue([
      { module: 'khy_sys', kind: 'function', name: 'ipc_call' },
    ]);

    try {
      const wasmService = require('../src/services/wasmAppService');
      await expect(wasmService.runFunction('moon-precheck', 'main', [])).rejects.toThrow(
        /khy_sys ABI mismatch/i
      );
      expect(called).toBe(false);
    } finally {
      instantiateSpy.mockRestore();
      exportsSpy.mockRestore();
      importsSpy.mockRestore();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('does not block numeric-v1 exports when khy_sys.ipc_call import is absent', async () => {
    jest.resetModules();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wasm-precheck-'));
    const wasmPath = path.join(tmpDir, 'mock.wasm');
    fs.writeFileSync(wasmPath, Buffer.from([0x00]));

    mockRegistry({
      name: 'pure-numeric',
      runtime: 'wasm',
      entry: wasmPath,
      wasm: {
        path: wasmPath,
        abi: 'numeric-v1',
        defaultExport: 'main',
        capabilities: ['ipc'],
      },
    });

    let called = false;
    const instantiateSpy = jest.spyOn(WebAssembly, 'instantiate').mockImplementation(async () => ({
      module: {},
      instance: {
        exports: {
          main: () => {
            called = true;
            return 42;
          },
        },
      },
    }));
    const exportsSpy = jest.spyOn(WebAssembly.Module, 'exports').mockReturnValue([
      { kind: 'function', name: 'main' },
    ]);
    const importsSpy = jest.spyOn(WebAssembly.Module, 'imports').mockReturnValue([]);

    try {
      const wasmService = require('../src/services/wasmAppService');
      const result = await wasmService.runFunction('pure-numeric', 'main', []);
      expect(result.result).toBe(42);
      expect(called).toBe(true);
    } finally {
      instantiateSpy.mockRestore();
      exportsSpy.mockRestore();
      importsSpy.mockRestore();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('respects custom khySys.memoryExport and allows execution when export exists', async () => {
    jest.resetModules();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wasm-precheck-'));
    const wasmPath = path.join(tmpDir, 'mock.wasm');
    fs.writeFileSync(wasmPath, Buffer.from([0x00]));

    mockRegistry({
      name: 'custom-memory-ok',
      runtime: 'wasm',
      entry: wasmPath,
      wasm: {
        path: wasmPath,
        abi: 'numeric-v1',
        defaultExport: 'main',
        capabilities: ['ipc', 'net'],
        khySys: { memoryExport: 'mem2' },
      },
    });

    let called = false;
    const instantiateSpy = jest.spyOn(WebAssembly, 'instantiate').mockImplementation(async () => ({
      module: {},
      instance: {
        exports: {
          mem2: new WebAssembly.Memory({ initial: 1 }),
          main: () => {
            called = true;
            return 7;
          },
        },
      },
    }));
    const exportsSpy = jest.spyOn(WebAssembly.Module, 'exports').mockReturnValue([
      { kind: 'function', name: 'main' },
      { kind: 'memory', name: 'mem2' },
    ]);
    const importsSpy = jest.spyOn(WebAssembly.Module, 'imports').mockReturnValue([
      { module: 'khy_sys', kind: 'function', name: 'ipc_call' },
    ]);

    try {
      const wasmService = require('../src/services/wasmAppService');
      const result = await wasmService.runFunction('custom-memory-ok', 'main', []);
      expect(result.result).toBe(7);
      expect(called).toBe(true);
    } finally {
      instantiateSpy.mockRestore();
      exportsSpy.mockRestore();
      importsSpy.mockRestore();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('rejects when custom khySys.memoryExport is missing even if another memory export exists', async () => {
    jest.resetModules();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wasm-precheck-'));
    const wasmPath = path.join(tmpDir, 'mock.wasm');
    fs.writeFileSync(wasmPath, Buffer.from([0x00]));

    mockRegistry({
      name: 'custom-memory-miss',
      runtime: 'wasm',
      entry: wasmPath,
      wasm: {
        path: wasmPath,
        abi: 'numeric-v1',
        defaultExport: 'main',
        capabilities: ['ipc', 'net'],
        khySys: { memoryExport: 'mem2' },
      },
    });

    let called = false;
    const instantiateSpy = jest.spyOn(WebAssembly, 'instantiate').mockImplementation(async () => ({
      module: {},
      instance: {
        exports: {
          memory: new WebAssembly.Memory({ initial: 1 }),
          main: () => {
            called = true;
            return 0;
          },
        },
      },
    }));
    const exportsSpy = jest.spyOn(WebAssembly.Module, 'exports').mockReturnValue([
      { kind: 'function', name: 'main' },
      { kind: 'memory', name: 'memory' },
    ]);
    const importsSpy = jest.spyOn(WebAssembly.Module, 'imports').mockReturnValue([
      { module: 'khy_sys', kind: 'function', name: 'ipc_call' },
    ]);

    try {
      const wasmService = require('../src/services/wasmAppService');
      await expect(wasmService.runFunction('custom-memory-miss', 'main', [])).rejects.toThrow(
        /khy_sys ABI mismatch/i
      );
      expect(called).toBe(false);
    } finally {
      instantiateSpy.mockRestore();
      exportsSpy.mockRestore();
      importsSpy.mockRestore();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
