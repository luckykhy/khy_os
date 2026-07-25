'use strict';

/**
 * relayErrorBodyDiag.test.js — 回归 relayApiAdapter.handleResponse 的错误体诊断根治。
 *
 * 根因(用户识图恒 `HTTP 400 ... detail:` 空):GLM/智谱 SSE 端点在 4xx/5xx 时也回
 * `text/event-stream`,旧 handleResponse 对任何 event-stream 都当正常流 resolve `{ stream }`,
 * 上层诊断分支被跳过、错误体丢失。本测证:
 *   - 2xx event-stream 仍当正常流(不回归 SSE 成功路径);
 *   - 非 2xx event-stream 排干响应体、保留 rawBody(真错误码可见);
 *   - 空体 / 非 JSON 体都保留 rawBody;
 *   - 门控关 → 逐字节回退旧行为(任何 event-stream 当流)。
 */
const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const relay = require('../../src/services/gateway/adapters/relayApiAdapter');

// 构造一个仿 http.IncomingMessage:EventEmitter + statusCode + headers。
function mkRes({ status, contentType, body }) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.headers = { 'content-type': contentType };
  // 下一 tick 推送 body 后 end,让 handleResponse 的监听器先挂上。
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
  test('2xx event-stream is still returned as a normal stream', async () => {
    const res = mkRes({ status: 200, contentType: 'text/event-stream', body: '' });
    const out = await runHandler(res);
    assert.ok(out.stream, 'a 200 SSE must resolve as { stream }');
    assert.equal(out.status, 200);
  });

  test('4xx event-stream is drained, rawBody preserved with the real error code', async () => {
    // GLM 视觉 400 常见:体是结构化错误 JSON,即便 content-type 声明 event-stream。
    const errBody = JSON.stringify({ error: { code: '1211', message: 'model not open' } });
    const res = mkRes({ status: 400, contentType: 'text/event-stream', body: errBody });
    const out = await runHandler(res);
    assert.ok(!out.stream, 'a 400 must NOT be treated as a stream');
    assert.equal(out.status, 400);
    assert.equal(out.rawBody, errBody);
    assert.equal(out.data.error.code, '1211');
  });

  test('non-JSON 4xx body is preserved verbatim in rawBody', async () => {
    const res = mkRes({ status: 400, contentType: 'application/json', body: 'upstream boom' });
    const out = await runHandler(res);
    assert.equal(out.rawBody, 'upstream boom');
    assert.equal(out.data, 'upstream boom'); // parse failed → raw string
  });

  test('empty 4xx body still yields a defined rawBody (never lost)', async () => {
    const res = mkRes({ status: 400, contentType: 'application/json', body: '' });
    const out = await runHandler(res);
    assert.equal(out.rawBody, '');
    assert.equal(out.status, 400);
  });

  test('gate off → byte-revert: any event-stream is treated as a stream even on 400', async () => {
    process.env.KHY_RELAY_ERROR_BODY_DIAG = '0';
    const res = mkRes({ status: 400, contentType: 'text/event-stream', body: 'irrelevant' });
    const out = await runHandler(res);
    assert.ok(out.stream, 'gate off restores old behavior: SSE 400 resolves as { stream }');
  });
});
