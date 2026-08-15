'use strict';

const http = require('../src/services/modelAdaptationHttp');

function responseRecorder() {
  const calls = [];
  return {
    calls,
    sendJson(_res, status, body) {
      calls.push({ status, body });
    },
  };
}

describe('modelAdaptationHttp', () => {
  it('未命中路径 → false,不写响应', async () => {
    const rec = responseRecorder();
    const handler = http.createModelAdaptationHttpHandler({
      registry: { getStatus: () => ({}) },
      sendJson: rec.sendJson,
    });

    await expect(handler({ method: 'GET' }, {}, '/other')).resolves.toBe(false);
    expect(rec.calls).toEqual([]);
  });

  it('未认证 → 401,不读取状态也不 reload', async () => {
    const rec = responseRecorder();
    let touched = 0;
    const handler = http.createModelAdaptationHttpHandler({
      authenticate: () => false,
      registry: {
        getStatus: () => {
          touched += 1;
        },
        reload: () => {
          touched += 1;
        },
      },
      sendJson: rec.sendJson,
    });

    await handler({ method: 'POST' }, {}, http.RELOAD_PATH);
    expect(rec.calls[0]).toMatchObject({ status: 401, body: { success: false } });
    expect(touched).toBe(0);
  });

  it('GET status 返回 registry 监控快照', async () => {
    const rec = responseRecorder();
    const status = { generation: 7, counters: { gets: 9 } };
    const handler = http.createModelAdaptationHttpHandler({
      authenticate: () => ({ ok: true }),
      registry: { getStatus: () => status },
      sendJson: rec.sendJson,
    });

    await expect(handler({ method: 'GET' }, {}, http.STATUS_PATH)).resolves.toBe(true);
    expect(rec.calls[0]).toEqual({ status: 200, body: { success: true, data: status } });
  });

  it('POST reload 只触发注册表 reload,语义标为 next-request', async () => {
    const rec = responseRecorder();
    const calls = [];
    const status = { generation: 8 };
    const handler = http.createModelAdaptationHttpHandler({
      authenticate: async () => true,
      registry: {
        getStatus: () => ({}),
        reload(opts) {
          calls.push(opts);
          return status;
        },
      },
      sendJson: rec.sendJson,
    });

    await handler({ method: 'POST' }, {}, http.RELOAD_PATH);
    expect(calls).toEqual([{ reason: 'http' }]);
    expect(rec.calls[0]).toMatchObject({
      status: 200,
      body: { success: true, data: status, semantics: 'next-request' },
    });
  });

  it('已知路径的错误 method → 405', async () => {
    const rec = responseRecorder();
    const handler = http.createModelAdaptationHttpHandler({
      registry: { getStatus: () => ({}) },
      sendJson: rec.sendJson,
    });

    await handler({ method: 'DELETE' }, {}, http.STATUS_PATH);
    expect(rec.calls[0].status).toBe(405);
  });
});
