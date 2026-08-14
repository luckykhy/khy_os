'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { ERRNO, negErrno } = require('../src/services/wasm-sandbox/m1Constants');
const { createKhySysHost } = require('../src/services/wasm-sandbox/khySysHost');

function _repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function _weatherDemoDir() {
  return path.join(_repoRoot(), 'packages', 'moonbit-plugin-sdk', 'cmd', 'weather-demo');
}

function _weatherDemoWasmPath() {
  return path.join(
    _repoRoot(),
    'packages',
    'moonbit-plugin-sdk',
    '_build',
    'wasm-gc',
    'debug',
    'build',
    'cmd',
    'weather-demo',
    'weather-demo.wasm'
  );
}

function _ensureWeatherDemoWasm() {
  const wasmPath = _weatherDemoWasmPath();
  if (fs.existsSync(wasmPath)) return wasmPath;

  const moonBin = process.env.MOON_BIN || 'moon';
  try {
    childProcess.execFileSync(moonBin, ['build'], {
      cwd: _weatherDemoDir(),
      stdio: 'pipe',
    });
  } catch {
    return null;
  }

  return fs.existsSync(wasmPath) ? wasmPath : null;
}

const weatherDemoWasmPath = _ensureWeatherDemoWasm();
const moonbitTest = weatherDemoWasmPath ? test : test.skip;

describe('wasm-sandbox moonbit wasm-gc IPC ABI integration', () => {
  moonbitTest('weather-demo calls khy_sys.ipc_call with wasm-gc externref byte objects', async () => {
    const bytes = fs.readFileSync(weatherDemoWasmPath);
    const calls = [];
    let lastLenCalls = 0;

    const imports = {
      khy_sys: {
        ipc_call: (...args) => {
          calls.push(args);
          return 0;
        },
        ipc_last_len: () => {
          lastLenCalls += 1;
          return 0;
        },
      },
      spectest: {
        print_char: () => {},
      },
    };

    const { instance } = await WebAssembly.instantiate(bytes, imports);
    expect(typeof instance.exports._start).toBe('function');
    instance.exports._start();

    expect(calls).toHaveLength(1);
    const [serviceId, methodId, reqBytes, reqLen, respBytes, respCap, timeoutMs] = calls[0];
    expect(serviceId).toBe(2);
    expect(methodId).toBe(1);
    expect(reqLen).toBe(19);
    expect(respCap).toBe(65536);
    expect(timeoutMs).toBe(3000);
    expect(typeof reqBytes).toBe('object');
    expect(typeof respBytes).toBe('object');
    expect(Object.getPrototypeOf(reqBytes)).toBe(null);
    expect(Object.getPrototypeOf(respBytes)).toBe(null);
    expect(lastLenCalls).toBeGreaterThanOrEqual(1);
  });

  moonbitTest('khySysHost rejects wasm-gc externref ABI with EPROTO and no bridge call', async () => {
    const bytes = fs.readFileSync(weatherDemoWasmPath);
    const bridge = {
      callJsonSync: jest.fn(() => ({ status: 0, data: {} })),
    };
    const host = createKhySysHost({ bridge });

    const imports = {
      khy_sys: host.imports,
      spectest: { print_char: () => {} },
    };
    const { instance } = await WebAssembly.instantiate(bytes, imports);
    host.attachInstance(instance);
    instance.exports._start();

    expect(bridge.callJsonSync).not.toHaveBeenCalled();
    expect(host.imports.ipc_last_status()).toBe(negErrno(ERRNO.EPROTO));
    expect(host.state.lastError).toMatch(/unsupported khy_sys IPC ABI/i);
  });

  moonbitTest('wasmAppService.runFunction surfaces explicit ABI mismatch error', async () => {
    jest.resetModules();
    jest.doMock('../src/services/appRegistry', () => ({
      get: jest.fn(() => ({
        name: 'moon-weather',
        runtime: 'wasm',
        entry: weatherDemoWasmPath,
        wasm: {
          path: weatherDemoWasmPath,
          abi: 'numeric-v1',
          defaultExport: '_start',
          capabilities: ['ipc', 'net'],
          khySys: { memoryExport: 'memory' },
        },
      })),
    }));

    const wasmService = require('../src/services/wasmAppService');
    await expect(wasmService.runFunction('moon-weather', '_start', [])).rejects.toThrow(
      /khy_sys ABI mismatch/i
    );
  });
});
