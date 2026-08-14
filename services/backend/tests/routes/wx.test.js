'use strict';

/**
 * wx.test.js — routes/wx.js 契约测试(Node 内置 test runner)。
 *
 * 覆盖:accounts 聚合形状、bind/unbind/active(成功 + fail-soft 4xx)、账号移除连带解绑、
 * 挂载点鉴权、token 不泄漏(只出现掩码,绝无 botToken/明文)。
 *
 * store 通过 require.cache 预置桩注入(routes/wx.js 顶层 require 底层 store,预置即命中)。
 * 运行:.khy/node/v22.12.0/node --test <本文件绝对路径>
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const SRC = path.join(__dirname, '..', '..', 'src');
const P = {
  store: require.resolve(path.join(SRC, 'services/messaging/ilinkAccountStore')),
  binding: require.resolve(path.join(SRC, 'services/messaging/ilinkBindingStore')),
  login: require.resolve(path.join(SRC, 'services/messaging/ilinkLogin')),
  daemon: require.resolve(path.join(SRC, 'services/daemonManager')),
  wx: require.resolve(path.join(SRC, 'routes/wx')),
};

function seed(filename, exportsObj) {
  require.cache[filename] = {
    id: filename, filename, loaded: true, exports: exportsObj, children: [], paths: [],
  };
}

// 用给定桩重新加载 routes/wx.js。
function loadWx(mocks) {
  delete require.cache[P.wx];
  seed(P.store, mocks.store || {});
  seed(P.binding, mocks.binding || {});
  seed(P.login, mocks.login || {});
  seed(P.daemon, mocks.daemon || {});
  return require(P.wx);
}

// 用可选前置中间件挂载 wx 路由,并发起一次 HTTP 请求。
function request(router, { method = 'GET', path: p = '/', body = null, headers = {}, pre = null } = {}) {
  const app = express();
  app.use(express.json());
  if (pre) app.use('/api/wx', pre, router);
  else app.use('/api/wx', router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const payload = body == null ? null : JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: `/api/wx${p}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          server.close(() => {
            let parsed = null;
            try { parsed = raw ? JSON.parse(raw) : null; } catch { /* leave null */ }
            resolve({ status: res.statusCode, body: parsed, raw });
          });
        });
      });
      req.on('error', (e) => server.close(() => reject(e)));
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// SSE 客户端:连接 /login/stream,逐帧解析 event/data;支持等待指定事件与读取非流式(429)响应体。
// 同一 router 共享模块级 _loginSessions,多次 openStream 即可模拟并发多会话。
function openStream(router, { headers = {} } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/wx', router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const events = [];
      const waiters = [];
      let buffer = '';
      let raw = '';
      let endResolve;
      const ended = new Promise((r) => { endResolve = r; });
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/wx/login/stream', method: 'GET', headers,
      }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (c) => {
          raw += c;
          buffer += c;
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const ev = {};
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) ev.event = line.slice(7);
              else if (line.startsWith('data: ')) ev.data = line.slice(6);
            }
            events.push(ev);
            for (let i = waiters.length - 1; i >= 0; i -= 1) {
              if (waiters[i].name === ev.event) { waiters[i].resolve(ev); waiters.splice(i, 1); }
            }
          }
        });
        res.on('end', () => endResolve(raw));
        resolve({
          status: res.statusCode,
          events,
          ended,
          bodyJson: () => { try { return JSON.parse(raw); } catch { return null; } },
          waitFor: (name) => new Promise((r, rej) => {
            const found = events.find((e) => e.event === name);
            if (found) return r(found);
            const t = setTimeout(() => rej(new Error(`等待 SSE 事件超时: ${name}`)), 5000);
            waiters.push({ name, resolve: (ev) => { clearTimeout(t); r(ev); } });
          }),
          close: () => new Promise((r) => { try { req.destroy(); } catch { /* best-effort */ } server.close(() => r()); }),
        });
      });
      req.on('error', reject);
      req.end();
    });
  });
}

// login 桩:一直 pending 直到 signal 被 abort,并记录各会话的 signal 供断言 abort 状态。
function pendingLogin() {
  const signals = [];
  return {
    signals,
    login: ({ signal }) => new Promise((resolve) => {
      signals.push(signal);
      if (signal.aborted) return resolve({ ok: false, error: '已取消' });
      signal.addEventListener('abort', () => resolve({ ok: false, error: '已取消' }), { once: true });
    }),
    renderQrToDataUrl: async () => 'data:image/png;base64,AAAA',
  };
}

test('GET /accounts 聚合 listAccounts + 绑定 + 会话 + 心跳 + daemonRunning', async () => {
  const router = loadWx({
    store: {
      listAccounts: () => [{
        accountId: 'bot_1', userId: 'u_1', token: 'ab****yz', active: true, createdAt: '2026-01-01T00:00:00Z',
      }],
      getSessionState: () => ({ expired: true, at: '2026-01-02', reason: '' }),
      getHeartbeat: () => ({ beatAt: 1, ageMs: 4321 }),
    },
    binding: { getBinding: () => ({ workspace: '/ws/a', agent: 'agentX' }) },
    daemon: { daemonStatus: async () => ({ running: true }) },
  });

  const res = await request(router, { path: '/accounts' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.daemonRunning, true);
  assert.strictEqual(res.body.accounts.length, 1);
  const a = res.body.accounts[0];
  assert.deepStrictEqual(a, {
    accountId: 'bot_1',
    userId: 'u_1',
    token: 'ab****yz',
    active: true,
    createdAt: '2026-01-01T00:00:00Z',
    workspace: '/ws/a',
    agent: 'agentX',
    expired: true,
    heartbeatAgeMs: 4321,
  });
});

test('GET /accounts token 不泄漏(仅掩码,无 botToken/明文)', async () => {
  const router = loadWx({
    store: {
      listAccounts: () => [{
        accountId: 'bot_1', userId: 'u_1', token: 'se****47', active: true, createdAt: 't',
      }],
      getSessionState: () => null,
      getHeartbeat: () => null,
    },
    binding: { getBinding: () => null },
    daemon: { daemonStatus: async () => ({ running: false }) },
  });

  const res = await request(router, { path: '/accounts' });
  assert.strictEqual(res.status, 200);
  assert.ok(!res.raw.includes('botToken'), '响应不得含 botToken 字段');
  assert.ok(!res.raw.includes('SECRET'), '响应不得含明文 token');
  assert.strictEqual(res.body.accounts[0].token, 'se****47');
  assert.strictEqual(res.body.accounts[0].heartbeatAgeMs, null);
  assert.strictEqual(res.body.accounts[0].expired, false);
});

test('POST /bind 成功透传 store 结果', async () => {
  let seen = null;
  const router = loadWx({
    binding: {
      bindAccount: (id, data) => { seen = { id, data }; return { ok: true, accountId: id, binding: { workspace: data.workspace, agent: data.agent || '' } }; },
    },
  });
  const res = await request(router, { method: 'POST', path: '/bind', body: { accountId: 'bot_1', workspace: '/ws', agent: 'a1' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.binding.workspace, '/ws');
  // wx.js 从 body 解构 {accountId, workspace, agent},以 (accountId, {workspace, agent}) 调 store。
  assert.deepStrictEqual(seen, { id: 'bot_1', data: { workspace: '/ws', agent: 'a1' } });
});

test('POST /bind store 返回 ok:false → 400 + {error}', async () => {
  const router = loadWx({
    binding: { bindAccount: () => ({ ok: false, error: '缺少 workspace' }) },
  });
  const res = await request(router, { method: 'POST', path: '/bind', body: { accountId: 'bot_1' } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, '缺少 workspace');
});

test('DELETE /bind/:id 解绑透传', async () => {
  const router = loadWx({
    binding: { unbindAccount: (id) => ({ ok: true, accountId: id }) },
  });
  const res = await request(router, { method: 'DELETE', path: '/bind/bot_1' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.accountId, 'bot_1');
});

test('POST /active 成功 / 失败 fail-soft 4xx', async () => {
  const ok = loadWx({ store: { setActiveAccount: (id) => ({ ok: true, accountId: id }) } });
  const r1 = await request(ok, { method: 'POST', path: '/active', body: { accountId: 'bot_1' } });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.body.accountId, 'bot_1');

  const bad = loadWx({ store: { setActiveAccount: () => ({ ok: false, error: '账号不存在' }) } });
  const r2 = await request(bad, { method: 'POST', path: '/active', body: { accountId: 'nope' } });
  assert.strictEqual(r2.status, 400);
  assert.strictEqual(r2.body.error, '账号不存在');
});

test('DELETE /accounts/:id 移除凭据 + 连带解绑孤儿绑定 + fail-soft daemon', async () => {
  const calls = { clear: null, unbind: null, restart: 0, start: 0, status: 0 };
  const router = loadWx({
    store: { clearAccount: (id) => { calls.clear = id; return { ok: true, accountId: id }; } },
    binding: { unbindAccount: (id) => { calls.unbind = id; return { ok: true, accountId: id }; } },
    daemon: {
      daemonStatus: async () => { calls.status += 1; return { running: true }; },
      daemonRestart: async () => { calls.restart += 1; return { pid: 1, port: 2 }; },
      daemonStart: async () => { calls.start += 1; return { pid: 1, port: 2 }; },
    },
  });
  const res = await request(router, { method: 'DELETE', path: '/accounts/bot_1' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.accountId, 'bot_1');
  assert.strictEqual(calls.clear, 'bot_1');
  assert.strictEqual(calls.unbind, 'bot_1', '必须连带解绑孤儿绑定');
  assert.strictEqual(calls.restart, 1, 'running 时应 restart 而非 start');
  assert.strictEqual(res.body.daemon.restarted, true);
});

test('DELETE /accounts/:id 凭据清理失败 → 400,不触碰 daemon', async () => {
  let restarted = 0;
  const router = loadWx({
    store: { clearAccount: () => ({ ok: false, error: 'accountId 非法' }) },
    binding: { unbindAccount: () => { throw new Error('不该被调用'); } },
    daemon: { daemonStatus: async () => ({ running: true }), daemonRestart: async () => { restarted += 1; } },
  });
  const res = await request(router, { method: 'DELETE', path: '/accounts/@@@' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'accountId 非法');
  assert.strictEqual(restarted, 0);
});

test('挂载点鉴权:前置 401 中间件阻断,路由不执行', async () => {
  let hit = false;
  const router = loadWx({
    store: { listAccounts: () => { hit = true; return []; }, getSessionState: () => null, getHeartbeat: () => null },
    daemon: { daemonStatus: async () => ({ running: false }) },
  });
  const guard = (req, res, next) => {
    if (!req.headers.authorization) return res.status(401).json({ message: '认证失败' });
    return next();
  };
  const res = await request(router, { path: '/accounts', pre: guard });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(hit, false, '鉴权失败时路由处理器不应执行');
});

test('GET /login/stream 并发两路各拿到不同 sessionId 且互不 abort', async () => {
  const lg = pendingLogin();
  const router = loadWx({ login: lg, daemon: { daemonStatus: async () => ({ running: false }) } });

  const a = await openStream(router);
  const evA = await a.waitFor('session');
  const b = await openStream(router);
  const evB = await b.waitFor('session');

  const sidA = JSON.parse(evA.data).sessionId;
  const sidB = JSON.parse(evB.data).sessionId;
  assert.ok(sidA && sidB, '两路都应首帧下发 sessionId');
  assert.notStrictEqual(sidA, sidB, '并发两路 sessionId 必须不同');
  assert.strictEqual(lg.signals.length, 2);
  assert.strictEqual(lg.signals[0].aborted, false, '后来者不得 abort 先到会话');
  assert.strictEqual(lg.signals[1].aborted, false);

  await a.close();
  await b.close();
});

test('POST /login/cancel 仅取消指定会话,不影响其他', async () => {
  const lg = pendingLogin();
  const router = loadWx({ login: lg, daemon: { daemonStatus: async () => ({ running: false }) } });

  const a = await openStream(router);
  const sidA = JSON.parse((await a.waitFor('session')).data).sessionId;
  const b = await openStream(router);
  await b.waitFor('session');

  const res = await request(router, { method: 'POST', path: '/login/cancel', body: { sessionId: sidA } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.cancelled, true);
  assert.strictEqual(lg.signals[0].aborted, true, '被取消会话应 abort');
  assert.strictEqual(lg.signals[1].aborted, false, '其他会话不受影响');

  await a.close();
  await b.close();
});

test('GET /login/stream 超并发上限返回 429 + {error}(含进度)', async () => {
  const prev = process.env.KHY_WX_MAX_LOGIN_SESSIONS;
  process.env.KHY_WX_MAX_LOGIN_SESSIONS = '1';
  try {
    const lg = pendingLogin();
    const router = loadWx({ login: lg, daemon: { daemonStatus: async () => ({ running: false }) } });

    const a = await openStream(router);
    await a.waitFor('session');
    const b = await openStream(router);
    await b.ended;
    assert.strictEqual(b.status, 429);
    const body = b.bodyJson();
    assert.ok(body && typeof body.error === 'string', '429 应回 JSON {error}');
    assert.ok(body.error.includes('(1/1)'), '文案应含进度 (1/1)');

    await a.close();
    await b.close();
  } finally {
    if (prev === undefined) delete process.env.KHY_WX_MAX_LOGIN_SESSIONS;
    else process.env.KHY_WX_MAX_LOGIN_SESSIONS = prev;
  }
});

test('POST /login/cancel 缺 sessionId 返回 400;找不到会话幂等 200', async () => {
  const router = loadWx({ daemon: { daemonStatus: async () => ({ running: false }) } });

  const bad = await request(router, { method: 'POST', path: '/login/cancel', body: {} });
  assert.strictEqual(bad.status, 400);
  assert.ok(bad.body.error.includes('sessionId'), '400 文案应点名缺失参数 sessionId');

  const miss = await request(router, { method: 'POST', path: '/login/cancel', body: { sessionId: 'not-exist' } });
  assert.strictEqual(miss.status, 200);
  assert.strictEqual(miss.body.ok, true);
  assert.strictEqual(miss.body.cancelled, false, '找不到会话应幂等 200 且 cancelled:false');
});
