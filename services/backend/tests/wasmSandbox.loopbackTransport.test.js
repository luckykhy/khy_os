'use strict';

const {
  ERRNO,
  IPC,
  METHOD,
  SERVICE,
  negErrno,
} = require('../src/services/wasm-sandbox/m1Constants');
const { createHeader, decodeFrame, encodeFrame } = require('../src/services/wasm-sandbox/ipcCodec');
const { createLoopbackTransport } = require('../src/services/wasm-sandbox/loopbackTransport');

describe('wasm-sandbox loopback transport', () => {
  test('handles NET_HTTP_GET request', async () => {
    const transport = createLoopbackTransport({
      now: () => '2026-05-08T00:00:00.000Z',
    });

    const reqFrame = encodeFrame({
      header: createHeader({
        msgType: IPC.MSG_TYPE.REQUEST,
        requestId: 10n,
        serviceId: SERVICE.NET,
        methodId: METHOD.NET.HTTP_GET,
      }),
      payload: Buffer.from(JSON.stringify({ city: 'shanghai' }), 'utf-8'),
    });

    const respFrame = await transport.call(reqFrame);
    const parsed = decodeFrame(respFrame);
    const body = JSON.parse(Buffer.from(parsed.payload).toString('utf-8'));

    expect(parsed.header.msgType).toBe(IPC.MSG_TYPE.RESPONSE);
    expect(parsed.header.status).toBe(0);
    expect(body.provider).toBe('loopback-netd');
    expect(body.city).toBe('shanghai');
    expect(typeof body.temperatureC).toBe('number');
  });

  test('returns ENOSYS for unknown service/method', async () => {
    const transport = createLoopbackTransport();
    const reqFrame = encodeFrame({
      header: createHeader({
        msgType: IPC.MSG_TYPE.REQUEST,
        requestId: 11n,
        serviceId: 99,
        methodId: 88,
      }),
      payload: Buffer.from('{}', 'utf-8'),
    });

    const respFrame = await transport.call(reqFrame);
    const parsed = decodeFrame(respFrame);

    expect(parsed.header.msgType).toBe(IPC.MSG_TYPE.ERROR);
    expect(parsed.header.status).toBe(negErrno(ERRNO.ENOSYS));
  });

  test('returns EINVAL when payload is invalid JSON', async () => {
    const transport = createLoopbackTransport();
    const reqFrame = encodeFrame({
      header: createHeader({
        msgType: IPC.MSG_TYPE.REQUEST,
        requestId: 12n,
        serviceId: SERVICE.NET,
        methodId: METHOD.NET.HTTP_GET,
      }),
      payload: Buffer.from('{invalid-json', 'utf-8'),
    });

    const respFrame = await transport.call(reqFrame);
    const parsed = decodeFrame(respFrame);
    const body = JSON.parse(Buffer.from(parsed.payload).toString('utf-8'));

    expect(parsed.header.msgType).toBe(IPC.MSG_TYPE.ERROR);
    expect(parsed.header.status).toBe(negErrno(ERRNO.EINVAL));
    expect(body.error).toMatch(/invalid JSON payload/i);
  });

  test('supports sync transport call for built-in handlers', () => {
    const transport = createLoopbackTransport({
      now: () => '2026-05-08T00:00:00.000Z',
    });
    const reqFrame = encodeFrame({
      header: createHeader({
        msgType: IPC.MSG_TYPE.REQUEST,
        requestId: 13n,
        serviceId: SERVICE.NET,
        methodId: METHOD.NET.DNS_RESOLVE,
      }),
      payload: Buffer.from(JSON.stringify({ host: 'example.com' }), 'utf-8'),
    });

    const respFrame = transport.callSync(reqFrame);
    const parsed = decodeFrame(respFrame);
    const body = JSON.parse(Buffer.from(parsed.payload).toString('utf-8'));
    expect(parsed.header.status).toBe(0);
    expect(body.host).toBe('example.com');
  });
});

describe('wasmAppService.runIpcCall', () => {
  function mockRegistry(appManifest) {
    jest.doMock('../src/services/appRegistry', () => ({
      get: jest.fn(() => appManifest),
    }));
  }

  test('calls IPC successfully when caps include ipc+net', async () => {
    jest.resetModules();
    mockRegistry({
      name: 'weather',
      runtime: 'wasm',
      wasm: {
        capabilities: ['ipc', 'net'],
      },
    });
    const wasmService = require('../src/services/wasmAppService');

    const result = await wasmService.runIpcCall('weather', 'net', 'http_get', { city: 'hangzhou' });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(0);
    expect(result.data.city).toBe('hangzhou');
  });

  test('throws when required capability is missing', async () => {
    jest.resetModules();
    mockRegistry({
      name: 'weather',
      runtime: 'wasm',
      wasm: {
        capabilities: ['ipc'],
      },
    });
    const wasmService = require('../src/services/wasmAppService');

    await expect(
      wasmService.runIpcCall('weather', 'net', 'http_get', { city: 'hangzhou' })
    ).rejects.toThrow(/Missing capability/i);
  });
});

describe('wasmAppService khy_sys memory export selection', () => {
  function mockRegistry(appManifest) {
    jest.doMock('../src/services/appRegistry', () => ({
      get: jest.fn(() => appManifest),
    }));
  }

  test('prefers wasm.khySys.memoryExport over stringAbi.memoryExport', async () => {
    jest.resetModules();

    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wasm-host-'));
    const wasmPath = path.join(tmpDir, 'mock.wasm');
    fs.writeFileSync(wasmPath, Buffer.from([0x00]));

    mockRegistry({
      name: 'mockhost',
      runtime: 'wasm',
      entry: wasmPath,
      wasm: {
        path: wasmPath,
        abi: 'numeric-v1',
        defaultExport: 'main',
        capabilities: ['ipc', 'net'],
        // Deliberately set conflicting values to verify priority.
        stringAbi: { memoryExport: 'memory' },
        khySys: { memoryExport: 'mem2' },
      },
    });

    const instantiateSpy = jest.spyOn(WebAssembly, 'instantiate').mockImplementation(async (_bytes, imports) => {
      const mem2 = new WebAssembly.Memory({ initial: 1 });
      const req = Buffer.from('{"city":"nanjing"}', 'utf-8');

      function main() {
        const view = new Uint8Array(mem2.buffer);
        view.set(req, 16);
        return imports.khy_sys.ipc_call(2, 1, 16, req.length, 256, 256, 3000);
      }

      return {
        module: {},
        instance: { exports: { mem2, main } },
      };
    });
    const exportsSpy = jest.spyOn(WebAssembly.Module, 'exports').mockReturnValue([
      { kind: 'function', name: 'main' },
      { kind: 'memory', name: 'mem2' },
    ]);
    const importsSpy = jest.spyOn(WebAssembly.Module, 'imports').mockReturnValue([]);

    try {
      const wasmService = require('../src/services/wasmAppService');
      const result = await wasmService.runFunction('mockhost', 'main', []);
      expect(result.result).toBe(0);
    } finally {
      instantiateSpy.mockRestore();
      exportsSpy.mockRestore();
      importsSpy.mockRestore();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
