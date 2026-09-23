'use strict';

/**
 * A2A 出站客户端 — header 构造回归测试(node:test)。
 *
 * 回归的缺陷:`sendMessage`/`createTask` 在未配置 `KHY_A2A_API_KEY` 时把
 * `Authorization: undefined`(以及未传 userId 时的 `X-User-Id: undefined`)交给
 * `http.request`。Node 对 undefined 值的 header **同步抛**
 * ERR_HTTP_INVALID_HEADER_VALUE,异常被 `_request` 的 catch 吞成 `{ status: 0 }` ——
 * 表现为"出站 A2A 通信 100% 静默失败",且看不出原因。
 *
 * 这里用真实本地 HTTP server 做行为验证,而不是断言内部函数:要锁住的是
 * "没有 key 也能发出去"这个外部可观测事实。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const a2a = require('../../src/services/a2a/index.js');

/** 起一个回声 server,记录收到的 header 与请求体;返回 { url, seen, close }。 */
function startEchoServer() {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        seen.push({
          method: req.method,
          path: req.url,
          authorization: req.headers.authorization || null,
          userId: req.headers['x-user-id'] || null,
          body: parsed,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${srv.address().port}`,
        seen,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

test('未配置 API key 时 sendMessage 仍能成功(回归:此前 100% 静默失败)', async () => {
  const prev = process.env.KHY_A2A_API_KEY;
  delete process.env.KHY_A2A_API_KEY;
  const echo = await startEchoServer();
  try {
    const res = await a2a.sendMessage(echo.url, 'hello');
    assert.equal(res.status, 200, `期望 200,实际 ${JSON.stringify(res)}`);
    assert.equal(res.data.ok, true);
    // 没有 key → 不应带 Authorization,但请求必须发出去
    assert.equal(echo.seen.length, 1);
    assert.equal(echo.seen[0].authorization, null);
    assert.equal(echo.seen[0].path, '/v1/message:send');
  } finally {
    await echo.close();
    if (prev !== undefined) process.env.KHY_A2A_API_KEY = prev;
  }
});

// ── 规范对齐(2026-09-15):createTask 不再是私有扩展 ──────────────────────
//
// 旧实现 POST `/v1/tasks` 并自带顶层 `id` 与 `messages[]` 数组 —— A2A 规范里
// **没有**独立的「创建任务」RPC(任务由服务端在 message/send 时隐式创建,taskId
// 由服务端生成),该端点也不是任何 REST 绑定的路径。审计 A7 判定它无法与任何
// 标准 A2A agent 互通,故 createTask 改为委托 sendMessage。
//
// 本测试此前断言 `path === '/v1/tasks'`,等于把**不合规**锁成了期望行为。现改为
// 断言规范路径 —— 这类"测试锁住了旧缺陷"的用例必须随修复一起改,否则修复会被
// 下一次回归悄悄推翻。
test('未配置 API key 时 createTask 仍能成功,且走规范路径 /v1/message:send', async () => {
  const prev = process.env.KHY_A2A_API_KEY;
  delete process.env.KHY_A2A_API_KEY;
  const echo = await startEchoServer();
  try {
    const res = await a2a.createTask(echo.url, 'do something');
    assert.equal(res.status, 200, `期望 200,实际 ${JSON.stringify(res)}`);
    assert.equal(echo.seen[0].authorization, null);
    assert.equal(echo.seen[0].path, '/v1/message:send');
  } finally {
    await echo.close();
    if (prev !== undefined) process.env.KHY_A2A_API_KEY = prev;
  }
});

test('Part 带 kind 判别字段(A2A 规范 Part 是 kind 判别联合)', async () => {
  const echo = await startEchoServer();
  try {
    await a2a.sendMessage(echo.url, 'hello parts');
    const part = echo.seen[0].body.message.parts[0];
    assert.equal(part.kind, 'text', '缺 kind 的 Part 不是合法 TextPart,标准客户端会拒收');
    assert.equal(part.text, 'hello parts');
    assert.equal(echo.seen[0].body.message.role, 'user');
    assert.ok(echo.seen[0].body.message.messageId, 'messageId 必填');
  } finally {
    await echo.close();
  }
});

test('cancelTask 走规范路径 tasks/{id}:cancel(补上审计 A5 的缺口)', async () => {
  const echo = await startEchoServer();
  try {
    const res = await a2a.cancelTask(echo.url, 'task-abc');
    assert.equal(res.status, 200);
    assert.equal(echo.seen[0].method, 'POST');
    assert.equal(echo.seen[0].path, '/v1/tasks/task-abc:cancel');
  } finally {
    await echo.close();
  }
});

test('getTask 的 taskId 被 URL 编码(防路径注入)', async () => {
  const echo = await startEchoServer();
  try {
    await a2a.getTask(echo.url, 'a/b?c');
    assert.equal(echo.seen[0].path, '/v1/tasks/a%2Fb%3Fc');
  } finally {
    await echo.close();
  }
});

test('配置了 API key → 带上 Bearer,且不因 userId 缺省而失败', async () => {
  const prev = process.env.KHY_A2A_API_KEY;
  process.env.KHY_A2A_API_KEY = 'unit-test-key';
  const echo = await startEchoServer();
  try {
    // 不传 options.userId:X-User-Id 不应被塞成 undefined
    const res = await a2a.sendMessage(echo.url, 'hello');
    assert.equal(res.status, 200);
    assert.equal(echo.seen[0].authorization, 'Bearer unit-test-key');
    assert.equal(echo.seen[0].userId, null);
  } finally {
    await echo.close();
    if (prev !== undefined) process.env.KHY_A2A_API_KEY = prev;
    else delete process.env.KHY_A2A_API_KEY;
  }
});

test('传了 userId → X-User-Id 正确透传', async () => {
  const echo = await startEchoServer();
  try {
    const res = await a2a.sendMessage(echo.url, 'hello', { userId: 'user-42' });
    assert.equal(res.status, 200);
    assert.equal(echo.seen[0].userId, 'user-42');
  } finally {
    await echo.close();
  }
});

test('对端不可达 → status 0 且 phase 标明是网络层(不是参数问题)', async () => {
  // 端口 1 上不会有服务;关键是不能抛,且能区分失败层级
  const res = await a2a.sendMessage('http://127.0.0.1:1', 'hello');
  assert.equal(res.status, 0);
  assert.equal(res.phase, 'network');
});
