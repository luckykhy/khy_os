'use strict';

const {
  CAP,
  IPC,
  METHOD,
  SERVICE,
  capMask,
} = require('../src/services/wasm-sandbox/m1Constants');
const {
  createHeader,
  decodeFrame,
  encodeFrame,
} = require('../src/services/wasm-sandbox/ipcCodec');
const {
  CapabilityError,
  IpcProtocolError,
  createMoonbitHostBridge,
} = require('../src/services/wasm-sandbox/moonbitHostBridge');
const { createLoopbackTransport } = require('../src/services/wasm-sandbox/loopbackTransport');

describe('wasm-sandbox ipcCodec', () => {
  test('encodes and decodes a frame roundtrip', () => {
    const payload = Buffer.from('{"hello":"world"}', 'utf-8');
    const frame = encodeFrame({
      header: createHeader({
        msgType: IPC.MSG_TYPE.REQUEST,
        requestId: 9n,
        serviceId: SERVICE.NET,
        methodId: METHOD.NET.HTTP_GET,
      }),
      payload,
    });

    const parsed = decodeFrame(frame);
    expect(parsed.header.magic).toBe(IPC.MAGIC);
    expect(parsed.header.version).toBe(IPC.VERSION);
    expect(parsed.header.requestId).toBe(9n);
    expect(parsed.header.serviceId).toBe(SERVICE.NET);
    expect(parsed.header.methodId).toBe(METHOD.NET.HTTP_GET);
    expect(Buffer.from(parsed.payload).toString('utf-8')).toBe('{"hello":"world"}');
  });

  test('rejects payload larger than M1 limit', () => {
    const bigPayload = Buffer.alloc(IPC.MAX_PAYLOAD_BYTES + 1, 0);
    expect(() => {
      encodeFrame({
        header: createHeader({
          msgType: IPC.MSG_TYPE.REQUEST,
          requestId: 1n,
          serviceId: SERVICE.NET,
          methodId: METHOD.NET.HTTP_GET,
        }),
        payload: bigPayload,
      });
    }).toThrow(/payload exceeds M1 max/i);
  });
});

describe('wasm-sandbox moonbitHostBridge', () => {
  test('rejects transport without call/callSync', () => {
    expect(() => {
      createMoonbitHostBridge({
        capabilityMask: capMask(CAP.IPC, CAP.NET),
        transport: {},
      });
    }).toThrow(/call\(frame, meta\) or transport\.callSync/i);
  });

  test('accepts sync-only transport and serves async callJson via callSync fallback', async () => {
    const transport = createLoopbackTransport({
      now: () => '2026-05-08T00:00:00.000Z',
    });
    const bridge = createMoonbitHostBridge({
      capabilityMask: capMask(CAP.IPC, CAP.NET),
      transport: {
        callSync: transport.callSync,
      },
    });

    const result = await bridge.callJson(
      SERVICE.NET,
      METHOD.NET.HTTP_GET,
      { city: 'wuxi' }
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(0);
    expect(result.data.city).toBe('wuxi');
  });

  test('denies call when CAP_IPC is missing', async () => {
    const bridge = createMoonbitHostBridge({
      capabilityMask: capMask(CAP.NET),
      transport: { call: jest.fn() },
    });

    await expect(
      bridge.callJson(SERVICE.NET, METHOD.NET.HTTP_GET, { city: 'shanghai' })
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  test('denies NET call when CAP_NET is missing', async () => {
    const bridge = createMoonbitHostBridge({
      capabilityMask: capMask(CAP.IPC),
      transport: { call: jest.fn() },
    });

    await expect(
      bridge.callJson(SERVICE.NET, METHOD.NET.HTTP_GET, { city: 'shanghai' })
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  test('roundtrips JSON over mock transport', async () => {
    const transport = {
      call: jest.fn(async (requestFrame) => {
        const req = decodeFrame(requestFrame);
        const body = JSON.parse(Buffer.from(req.payload).toString('utf-8'));

        const responsePayload = Buffer.from(
          JSON.stringify({
            city: body.city,
            temperatureC: 23,
          }),
          'utf-8'
        );

        return encodeFrame({
          header: createHeader({
            msgType: IPC.MSG_TYPE.RESPONSE,
            requestId: req.header.requestId,
            serviceId: req.header.serviceId,
            methodId: req.header.methodId,
            status: 0,
          }),
          payload: responsePayload,
        });
      }),
    };

    const bridge = createMoonbitHostBridge({
      capabilityMask: capMask(CAP.IPC, CAP.NET),
      transport,
    });

    const result = await bridge.callJson(
      SERVICE.NET,
      METHOD.NET.HTTP_GET,
      { city: 'shanghai' }
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(0);
    expect(result.data).toEqual({
      city: 'shanghai',
      temperatureC: 23,
    });
    expect(transport.call).toHaveBeenCalledTimes(1);
  });

  test('supports synchronous callJsonSync with loopback transport', () => {
    const transport = createLoopbackTransport({
      now: () => '2026-05-08T00:00:00.000Z',
    });
    const bridge = createMoonbitHostBridge({
      capabilityMask: capMask(CAP.IPC, CAP.NET),
      transport,
    });

    const result = bridge.callJsonSync(
      SERVICE.NET,
      METHOD.NET.HTTP_GET,
      { city: 'suzhou' }
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(0);
    expect(result.data.city).toBe('suzhou');
  });

  test('rejects mismatched request id', async () => {
    const transport = {
      call: jest.fn(async (requestFrame) => {
        const req = decodeFrame(requestFrame);
        const responsePayload = Buffer.from('{}', 'utf-8');
        return encodeFrame({
          header: createHeader({
            msgType: IPC.MSG_TYPE.RESPONSE,
            requestId: req.header.requestId + 1n,
            serviceId: req.header.serviceId,
            methodId: req.header.methodId,
            status: 0,
          }),
          payload: responsePayload,
        });
      }),
    };

    const bridge = createMoonbitHostBridge({
      capabilityMask: capMask(CAP.IPC, CAP.NET),
      transport,
    });

    await expect(
      bridge.callJson(SERVICE.NET, METHOD.NET.HTTP_GET, { city: 'shanghai' })
    ).rejects.toBeInstanceOf(IpcProtocolError);
  });
});
