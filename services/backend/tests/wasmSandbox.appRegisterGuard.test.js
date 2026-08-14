'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MINIMAL_WASM = Buffer.from([
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,
]);

function mockCliDeps({ existingApp = null } = {}) {
  const register = jest.fn();
  const get = jest.fn(() => existingApp);
  jest.doMock('../src/services/appRegistry', () => ({
    get,
    register,
  }));

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

  return {
    register,
    get,
    printSuccess,
    printError,
    printInfo,
    printTable,
  };
}

describe('app register ABI guard', () => {
  test('rejects numeric-v1 registration when khy_sys.ipc_call is imported without expected memory export', async () => {
    jest.resetModules();

    const deps = mockCliDeps();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-app-register-'));
    const wasmPath = path.join(tmpDir, 'mock.wasm');
    fs.writeFileSync(wasmPath, MINIMAL_WASM);

    const exportsSpy = jest.spyOn(WebAssembly.Module, 'exports').mockReturnValue([
      { kind: 'function', name: 'main' },
    ]);
    const importsSpy = jest.spyOn(WebAssembly.Module, 'imports').mockReturnValue([
      { module: 'khy_sys', kind: 'function', name: 'ipc_call' },
    ]);

    try {
      const { handleApp } = require('../src/cli/handlers/app');
      await handleApp('register', ['moonbad'], {
        runtime: 'wasm',
        wasm: wasmPath,
        abi: 'numeric-v1',
        export: 'main',
      });

      expect(deps.register).not.toHaveBeenCalled();
      expect(deps.printError).toHaveBeenCalledWith(expect.stringMatching(/WASM ABI 不兼容/));
    } finally {
      exportsSpy.mockRestore();
      importsSpy.mockRestore();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('keeps warning-only behavior for string-v2 in same module shape', async () => {
    jest.resetModules();

    const deps = mockCliDeps();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-app-register-'));
    const wasmPath = path.join(tmpDir, 'mock.wasm');
    fs.writeFileSync(wasmPath, MINIMAL_WASM);

    const exportsSpy = jest.spyOn(WebAssembly.Module, 'exports').mockReturnValue([
      { kind: 'function', name: 'run' },
      { kind: 'function', name: 'alloc' },
      { kind: 'memory', name: 'mem2' },
    ]);
    const importsSpy = jest.spyOn(WebAssembly.Module, 'imports').mockReturnValue([
      { module: 'khy_sys', kind: 'function', name: 'ipc_call' },
    ]);

    try {
      const { handleApp } = require('../src/cli/handlers/app');
      await handleApp('register', ['moonwarn'], {
        runtime: 'wasm',
        wasm: wasmPath,
        abi: 'string-v2',
        export: 'run',
        memory: 'mem2',
      });

      expect(deps.register).toHaveBeenCalledTimes(1);
      expect(deps.printSuccess).toHaveBeenCalledWith(expect.stringMatching(/注册成功/));
      expect(deps.printInfo).toHaveBeenCalledWith(expect.stringMatching(/警告: 检测到 khy_sys\.ipc_call 导入/));
    } finally {
      exportsSpy.mockRestore();
      importsSpy.mockRestore();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('rejects registration when module has multiple function exports and no main/_start without --export', async () => {
    jest.resetModules();

    const deps = mockCliDeps();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-app-register-'));
    const wasmPath = path.join(tmpDir, 'mock.wasm');
    fs.writeFileSync(wasmPath, MINIMAL_WASM);

    const exportsSpy = jest.spyOn(WebAssembly.Module, 'exports').mockReturnValue([
      { kind: 'function', name: 'run' },
      { kind: 'function', name: 'compute' },
      { kind: 'memory', name: 'memory' },
    ]);
    const importsSpy = jest.spyOn(WebAssembly.Module, 'imports').mockReturnValue([]);

    try {
      const { handleApp } = require('../src/cli/handlers/app');
      await handleApp('register', ['multifunc'], {
        runtime: 'wasm',
        wasm: wasmPath,
        abi: 'numeric-v1',
      });

      expect(deps.register).not.toHaveBeenCalled();
      expect(deps.printError).toHaveBeenCalledWith(
        expect.stringMatching(/多个函数导出，且未检测到 main\/_start/)
      );
    } finally {
      exportsSpy.mockRestore();
      importsSpy.mockRestore();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('allows numeric-v1 registration when khy_sys import exists and configured khy-memory export is present', async () => {
    jest.resetModules();

    const deps = mockCliDeps();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-app-register-'));
    const wasmPath = path.join(tmpDir, 'mock.wasm');
    fs.writeFileSync(wasmPath, MINIMAL_WASM);

    const exportsSpy = jest.spyOn(WebAssembly.Module, 'exports').mockReturnValue([
      { kind: 'function', name: 'main' },
      { kind: 'memory', name: 'mem2' },
    ]);
    const importsSpy = jest.spyOn(WebAssembly.Module, 'imports').mockReturnValue([
      { module: 'khy_sys', kind: 'function', name: 'ipc_call' },
    ]);

    try {
      const { handleApp } = require('../src/cli/handlers/app');
      await handleApp('register', ['moonok'], {
        runtime: 'wasm',
        wasm: wasmPath,
        abi: 'numeric-v1',
        export: 'main',
        'khy-memory': 'mem2',
      });

      expect(deps.register).toHaveBeenCalledTimes(1);
      expect(deps.printSuccess).toHaveBeenCalledWith(expect.stringMatching(/注册成功/));
      expect(deps.printError).not.toHaveBeenCalledWith(expect.stringMatching(/WASM ABI 不兼容/));
    } finally {
      exportsSpy.mockRestore();
      importsSpy.mockRestore();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('rejects registration when module imports unsupported symbols', async () => {
    jest.resetModules();

    const deps = mockCliDeps();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-app-register-'));
    const wasmPath = path.join(tmpDir, 'mock.wasm');
    fs.writeFileSync(wasmPath, MINIMAL_WASM);

    const exportsSpy = jest.spyOn(WebAssembly.Module, 'exports').mockReturnValue([
      { kind: 'function', name: 'main' },
      { kind: 'memory', name: 'memory' },
    ]);
    const importsSpy = jest.spyOn(WebAssembly.Module, 'imports').mockReturnValue([
      { module: 'env', kind: 'function', name: 'abort' },
    ]);

    try {
      const { handleApp } = require('../src/cli/handlers/app');
      await handleApp('register', ['unsupported-import'], {
        runtime: 'wasm',
        wasm: wasmPath,
        abi: 'numeric-v1',
        export: 'main',
      });

      expect(deps.register).not.toHaveBeenCalled();
      expect(deps.printError).toHaveBeenCalledWith(expect.stringMatching(/不支持的导入/));
    } finally {
      exportsSpy.mockRestore();
      importsSpy.mockRestore();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('rejects string-v2 registration when alloc export is missing', async () => {
    jest.resetModules();

    const deps = mockCliDeps();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-app-register-'));
    const wasmPath = path.join(tmpDir, 'mock.wasm');
    fs.writeFileSync(wasmPath, MINIMAL_WASM);

    const exportsSpy = jest.spyOn(WebAssembly.Module, 'exports').mockReturnValue([
      { kind: 'function', name: 'run' },
      { kind: 'memory', name: 'memory' },
    ]);
    const importsSpy = jest.spyOn(WebAssembly.Module, 'imports').mockReturnValue([]);

    try {
      const { handleApp } = require('../src/cli/handlers/app');
      await handleApp('register', ['string-missing-alloc'], {
        runtime: 'wasm',
        wasm: wasmPath,
        abi: 'string-v2',
        export: 'run',
      });

      expect(deps.register).not.toHaveBeenCalled();
      expect(deps.printError).toHaveBeenCalledWith(expect.stringMatching(/分配函数不存在/));
    } finally {
      exportsSpy.mockRestore();
      importsSpy.mockRestore();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('rejects string-v2 registration when return-mode is unsupported', async () => {
    jest.resetModules();

    const deps = mockCliDeps();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-app-register-'));
    const wasmPath = path.join(tmpDir, 'mock.wasm');
    fs.writeFileSync(wasmPath, MINIMAL_WASM);

    const exportsSpy = jest.spyOn(WebAssembly.Module, 'exports').mockReturnValue([
      { kind: 'function', name: 'run' },
      { kind: 'function', name: 'alloc' },
      { kind: 'memory', name: 'memory' },
    ]);
    const importsSpy = jest.spyOn(WebAssembly.Module, 'imports').mockReturnValue([]);

    try {
      const { handleApp } = require('../src/cli/handlers/app');
      await handleApp('register', ['string-bad-return'], {
        runtime: 'wasm',
        wasm: wasmPath,
        abi: 'string-v2',
        export: 'run',
        'return-mode': 'ptr-len',
      });

      expect(deps.register).not.toHaveBeenCalled();
      expect(deps.printError).toHaveBeenCalledWith(expect.stringMatching(/不支持的 return-mode/));
    } finally {
      exportsSpy.mockRestore();
      importsSpy.mockRestore();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
