'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');

const { createFeishuAdapter, _protocol } = require('../src/adapters/im/feishuAdapter');

const LOOPBACK = '127.0.0.1';

async function waitFor(predicate, label, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待「${label}」超时`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startGateway() {
  const wss = new WebSocketServer({ host: LOOPBACK, port: 0 });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const sockets = new Set();
  const received = [];
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('message', (bytes) => received.push(_protocol.decodeFrame(Buffer.from(bytes))));
    ws.on('close', () => sockets.delete(ws));
  });
  return {
    endpoint: `ws://${LOOPBACK}:${wss.address().port}/callback/ws?device_id=device-1&service_id=42`,
    received,
    push(frame) { for (const ws of sockets) ws.send(frame); },
    async stop() {
      for (const ws of sockets) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

function eventFrame(payload, extraHeaders = []) {
  return _protocol.encodeFrame({
    SeqID: 7,
    LogID: 9,
    service: 42,
    method: 1,
    headers: [{ key: 'type', value: 'event' }, ...extraHeaders],
    payload,
  });
}

test('官方协议:endpoint 协商、pbbp2 EVENT/ACK/PONG 与 REST 回复闭环', async () => {
  const gateway = await startGateway();
  const posts = [];
  const httpClient = {
    async post(url, body, options) {
      posts.push({ url, body, headers: options.headers });
      if (url.endsWith('/callback/ws/endpoint')) {
        return {
          status: 200,
          data: {
            code: 0,
            data: {
              endpoint: gateway.endpoint,
              client_config: { PingInterval: 2, ReconnectInterval: 3, ReconnectCount: -1, ReconnectNonce: 1 },
            },
          },
        };
      }
      if (url.includes('/open-apis/im/v1/messages?receive_id_type=chat_id')) {
        return { status: 200, data: { code: 0, msg: 'ok' } };
      }
      throw new Error(`意外请求:${url}`);
    },
  };
  const logLines = [];
  const adapter = createFeishuAdapter({
    env: {
      KHY_IM_FEISHU_APP_ID: 'cli_protocol_app',
      KHY_IM_FEISHU_APP_SECRET: 'protocol-secret-never-log',
      KHY_IM_FEISHU_ACCESS_TOKEN: 'tenant-token-never-log',
    },
    httpClient,
    logger: {
      info: (line) => logLines.push(line),
      warn: (line) => logLines.push(line),
      error: (line) => logLines.push(line),
    },
    timing: { idleMs: 0, heartbeatMs: 0, reconnectMinMs: 100, reconnectMaxMs: 500 },
    autoReconnect: false,
  });

  try {
    const inbox = [];
    adapter.onMessage((message) => inbox.push(message));
    await adapter.connect();

    assert.deepEqual(posts[0].body, { AppID: 'cli_protocol_app', AppSecret: 'protocol-secret-never-log' });
    assert.equal(posts[0].headers.locale, 'zh');
    assert.equal(adapter.describeState().timing.heartbeatMs, 2000);
    assert.equal(adapter.describeState().timing.reconnectMinMs, 3000);
    assert.match(adapter.describeEndpoint(), /service_id=\*\*\*/);

    const event = {
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1' },
      event: {
        sender: { sender_id: { open_id: 'ou_protocol' } },
        message: {
          message_id: 'om_protocol',
          chat_id: 'oc_protocol',
          content: '{"text":"官方二进制事件"}',
        },
      },
    };
    gateway.push(eventFrame(Buffer.from(JSON.stringify(event)), [
      { key: 'message_id', value: 'msg-1' },
      { key: 'sum', value: '1' },
      { key: 'seq', value: '0' },
    ]));

    await waitFor(() => inbox.length === 1, 'EVENT 派发');
    await waitFor(() => gateway.received.some((frame) => {
      try { return JSON.parse(frame.payload.toString()).code === 200; } catch { return false; }
    }), 'EVENT ACK');
    assert.equal(inbox[0].chatId, 'oc_protocol');
    assert.equal(inbox[0].senderId, 'ou_protocol');
    assert.equal(inbox[0].text, '官方二进制事件');
    const ack = gateway.received.find((frame) => JSON.parse(frame.payload.toString()).code === 200);
    assert.equal(ack.SeqID, 7n);
    assert.equal(ack.service, 42);
    assert.ok(ack.headers.some((header) => header.key === 'biz_rt'));

    gateway.push(_protocol.encodeFrame({
      SeqID: 11,
      LogID: 12,
      service: 42,
      method: 0,
      headers: [{ key: 'type', value: 'ping' }],
    }));
    await waitFor(
      () => gateway.received.some((frame) => frame.headers.some((header) => header.value === 'pong')),
      'PONG 回帧'
    );

    const sent = await adapter.sendMessage('oc_protocol', 'AI 回复');
    assert.equal(sent.via, 'api');
    const apiPost = posts.find((post) => post.url.includes('/open-apis/im/v1/messages'));
    assert.equal(apiPost.headers.Authorization, 'Bearer tenant-token-never-log');
    assert.deepEqual(apiPost.body, {
      receive_id: 'oc_protocol',
      msg_type: 'text',
      content: '{"text":"AI 回复"}',
    });
    assert.ok(!logLines.join('\n').includes('protocol-secret-never-log'));
    assert.ok(!logLines.join('\n').includes('tenant-token-never-log'));
  } finally {
    await adapter.disconnect('test-done');
    await gateway.stop();
  }
});

test('pbbp2 分片按 message_id 乱序重组,只在完整后派发', () => {
  const adapter = createFeishuAdapter({
    env: { KHY_IM_FEISHU_APP_ID: 'app', KHY_IM_FEISHU_APP_SECRET: 'secret' },
    logger: { info() {}, warn() {}, error() {} },
  });
  const payload = Buffer.from(JSON.stringify({ type: 'message', id: 'om_chunk', chatId: 'oc_chunk', text: '分片消息' }));
  const pivot = Math.floor(payload.length / 2);
  const headers = [
    { key: 'message_id', value: 'chunk-1' },
    { key: 'sum', value: '2' },
  ];
  assert.equal(adapter._decodeFrame(eventFrame(payload.subarray(pivot), [...headers, { key: 'seq', value: '1' }])).kind, 'chunk');
  const decoded = adapter._decodeFrame(eventFrame(payload.subarray(0, pivot), [...headers, { key: 'seq', value: '0' }]));
  assert.equal(decoded.kind, 'message');
  assert.equal(decoded.message.text, '分片消息');
});
