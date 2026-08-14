'use strict';

const { ERRNO, negErrno } = require('../src/services/wasm-sandbox/m1Constants');
const { createKhySysHost } = require('../src/services/wasm-sandbox/khySysHost');

function writeBytes(memory, ptr, bytes) {
  const view = new Uint8Array(memory.buffer);
  view.set(bytes, ptr);
}

function readBytes(memory, ptr, len) {
  const view = new Uint8Array(memory.buffer);
  return Buffer.from(view.subarray(ptr, ptr + len));
}

describe('wasm-sandbox khy_sys host imports', () => {
  test('cap_check returns 1/0 from bridge capability check', () => {
    const host = createKhySysHost({
      bridge: {
        callJsonSync: jest.fn(),
        hasCapability: jest.fn((capBit) => Number(capBit) === 2),
      },
    });
    host.attachInstance({ exports: { memory: new WebAssembly.Memory({ initial: 1 }) } });

    expect(host.imports.cap_check(2)).toBe(1);
    expect(host.imports.cap_check(4)).toBe(0);
  });

  test('ipc_call reads request JSON and writes response bytes', () => {
    const bridge = {
      hasCapability: jest.fn(() => true),
      callJsonSync: jest.fn(() => ({
        status: 0,
        data: { ok: true },
        rawPayload: Buffer.from('{"ok":true}', 'utf-8'),
      })),
    };
    const host = createKhySysHost({ bridge });
    const memory = new WebAssembly.Memory({ initial: 1 });
    host.attachInstance({ exports: { memory } });

    const reqPtr = 64;
    const req = Buffer.from('{"city":"shanghai"}', 'utf-8');
    writeBytes(memory, reqPtr, req);

    const respPtr = 256;
    const rc = host.imports.ipc_call(2, 1, reqPtr, req.length, respPtr, 256, 3000);
    expect(rc).toBe(0);
    expect(host.imports.ipc_last_len()).toBe(Buffer.byteLength('{"ok":true}'));
    expect(bridge.callJsonSync).toHaveBeenCalledWith(2, 1, { city: 'shanghai' }, { timeoutMs: 3000 });

    const outLen = host.imports.ipc_last_len();
    const out = readBytes(memory, respPtr, outLen).toString('utf-8');
    expect(out).toBe('{"ok":true}');
  });

  test('ipc_call returns EINVAL on invalid request JSON', () => {
    const bridge = {
      hasCapability: jest.fn(() => true),
      callJsonSync: jest.fn(),
    };
    const host = createKhySysHost({ bridge });
    const memory = new WebAssembly.Memory({ initial: 1 });
    host.attachInstance({ exports: { memory } });

    const reqPtr = 80;
    const req = Buffer.from('{bad-json', 'utf-8');
    writeBytes(memory, reqPtr, req);

    const rc = host.imports.ipc_call(2, 1, reqPtr, req.length, 512, 128, 3000);
    expect(rc).toBe(negErrno(ERRNO.EINVAL));
    expect(host.imports.ipc_last_status()).toBe(negErrno(ERRNO.EINVAL));
    expect(bridge.callJsonSync).not.toHaveBeenCalled();
  });

  test('ipc_call returns EMSGSIZE when response buffer is too small', () => {
    const bridge = {
      hasCapability: jest.fn(() => true),
      callJsonSync: jest.fn(() => ({
        status: 0,
        data: { ok: true },
        rawPayload: Buffer.from('{"ok":true}', 'utf-8'),
      })),
    };
    const host = createKhySysHost({ bridge });
    const memory = new WebAssembly.Memory({ initial: 1 });
    host.attachInstance({ exports: { memory } });

    const reqPtr = 96;
    const req = Buffer.from('{"x":1}', 'utf-8');
    writeBytes(memory, reqPtr, req);

    const rc = host.imports.ipc_call(2, 1, reqPtr, req.length, 640, 4, 3000);
    expect(rc).toBe(negErrno(ERRNO.EMSGSIZE));
    expect(host.imports.ipc_last_status()).toBe(negErrno(ERRNO.EMSGSIZE));
    expect(host.imports.ipc_last_len()).toBe(Buffer.byteLength('{"ok":true}'));
  });

  test('ipc_call returns EPROTO for unsupported non-pointer req/resp ABI', () => {
    const bridge = {
      hasCapability: jest.fn(() => true),
      callJsonSync: jest.fn(),
    };
    const host = createKhySysHost({ bridge });

    // wasm-gc externref style values (non-numeric pointers) are currently unsupported.
    const rc = host.imports.ipc_call(2, 1, Object.create(null), 19, Object.create(null), 65536, 3000);
    expect(rc).toBe(negErrno(ERRNO.EPROTO));
    expect(host.imports.ipc_last_status()).toBe(negErrno(ERRNO.EPROTO));
    expect(host.state.lastError).toMatch(/unsupported khy_sys IPC ABI/i);
    expect(bridge.callJsonSync).not.toHaveBeenCalled();
  });
});
