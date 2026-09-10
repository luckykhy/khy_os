'use strict';
/**
 * relayErrorBodyDiag.test.js �?回归 relayApiAdapter.handleResponse 的错误体诊断根治�?
 *
 * 根因(用户识图�?`HTTP 400 ... detail:` �?:GLM/智谱 SSE 端点�?4xx/5xx 时也�?
 * `text/event-stream`,�?handleResponse 对任�?event-stream 都当正常�?resolve `{ stream }`,
 * 上层诊断分支被跳过、错误体丢失。本测证:
 *   - 2xx event-stream 仍当正常�?不回�?SSE 成功路径);
 *   - �?2xx event-stream 排干响应体、保�?rawBody(真错误码可见);
 *   - 空体 / �?JSON 体都保留 rawBody;
 *   - 门控�?�?逐字节回退旧行�?任何 event-stream 当流)�?
 */
const { EventEmitter } = require('node:events');
const relay = require('../../src/services/gateway/adapters/relayApiAdapter');
// 构造一个仿 http.IncomingMessage:EventEmitter + statusCode + headers�?
function mkRes({ status, contentType, body }) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.headers = { 'content-type': contentType };
  // 下一 tick 推�?body �?end,�?handleResponse 的监听器先挂上�?
  process.nextTick(() => {
    if (body) res.emit('data', Buffer.from(body));
    res.emit('end');
  });
  return res;
}
function runHandler(res) {
  return new Promise((resolve, reject) => {
    relay._handleResponse(resolve, reject)(res);
  });
}
afterEach(() => { delete process.env.KHY_RELAY_ERROR_BODY_DIAG; });
describe('relayApiAdapter error-body diagnostic', () => {
});

describe('Relay Error Body Diag', () => {
  test('2xx event-stream is still returned as a normal stream', async () => {
        const res = mkRes({ status: 200, contentType: 'text/event-stream', body: '' });
        const out = await runHandler(res);
        expect(out.stream).toBeTruthy();
        expect(out.status).toBe(200);
  });

  test('4xx event-stream is drained, rawBody preserved with the real error code', async () => {
        // GLM 视觉 400 常见:体是结构化错�?JSON,即便 content-type 声明 event-stream�?
        const errBody = JSON.stringify({ error: { code: '1211', message: 'model not open' } });
        const res = mkRes({ status: 400, contentType: 'text/event-stream', body: errBody });
        const out = await runHandler(res);
        expect(!out.stream).toBeTruthy();
        expect(out.status).toBe(400);
        expect(out.rawBody).toBe(errBody);
        expect(out.data.error.code).toBe('1211');
  });

  test('non-JSON 4xx body is preserved verbatim in rawBody', async () => {
        const res = mkRes({ status: 400, contentType: 'application/json', body: 'upstream boom' });
        const out = await runHandler(res);
        expect(out.rawBody).toBe('upstream boom');
        expect(out.data).toBe('upstream boom'); // parse failed �?raw string
  });

  test('empty 4xx body still yields a defined rawBody (never lost)', async () => {
        const res = mkRes({ status: 400, contentType: 'application/json', body: '' });
        const out = await runHandler(res);
        expect(out.rawBody).toBe('');
        expect(out.status).toBe(400);
  });

  test('gate off �?byte-revert: any event-stream is treated as a stream even on 400', async () => {
        process.env.KHY_RELAY_ERROR_BODY_DIAG = '0';
        const res = mkRes({ status: 400, contentType: 'text/event-stream', body: 'irrelevant' });
        const out = await runHandler(res);
        expect(out.stream).toBeTruthy();
  });

});

