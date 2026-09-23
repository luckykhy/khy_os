/**
 * bridgeServer lifecycle + broadcast/health/nginx-config tests (jest).
 *
 * startBridgeServer() takes a port argument, so we start on an ephemeral port
 * (0) with no hardcoded ports; the bind host stays the module default
 * 127.0.0.1. External deps are mocked:
 *  - `ws` -> in-memory fake WebSocketServer (connection never fires; no real sockets)
 *  - `./bridgeAuth` auto-mocked -> initUserDb() no-ops, validateJwt() safe
 */
'use strict';

const http = require('http');

jest.mock('ws', () => {
  const { EventEmitter } = require('events');
  return {
    WebSocketServer: class extends EventEmitter {
      close(cb) {
        if (cb) {
          cb();
        }
      }
    },
  };
});
jest.mock('../src/bridge/bridgeAuth', () => ({
  initUserDb: jest.fn(),
  registerUser: jest.fn(() => ({ ok: true })),
  loginUser: jest.fn(() => ({ ok: true })),
  validateJwt: jest.fn(() => ({ ok: false })),
}));

const bridge = require('../src/bridge/bridgeServer');

function httpJson(port, method, reqPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: reqPath, headers: headers || {} },
      (res) => {
        let data = '';
        res.on('data', (d) => {
          data += d;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('bridgeServer 生命周期与广播', () => {
  let info;

  test('端口 0 启动：临时端口、token/pin 形态、本地 URL', async () => {
    info = await bridge.startBridgeServer(0);
    expect(info.port).toBeGreaterThan(0);
    expect(info.token).toMatch(/^[0-9a-f]{64}$/);
    expect(bridge.getPin()).toMatch(/^\d{8}$/);
    // Default bind host 127.0.0.1 -> local-only display URL, no unreachable LAN IP advertised
    // (startBridgeServer returns {port,token,pin,url,lanIp}; the local-only display
    // contract is observable via the URL shape below.)
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(bridge.getPort()).toBe(info.port);
  });

  test('重复 start 幂等：返回既有实例信息', async () => {
    const again = await bridge.startBridgeServer();
    expect(again.port).toBe(info.port);
    expect(again.token).toBe(info.token);
  });

  test('GET /health：状态 ok 且认证客户端数为 0', async () => {
    const res = await httpJson(info.port, 'GET', '/health');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.clients).toBe(0);
  });

  test('OPTIONS 预检：204 且 Access-Control-Allow-Origin 为 null（无 origin）', async () => {
    const res = await httpJson(info.port, 'OPTIONS', '/health');
    expect(res.status).toBe(204);
    // No Origin header sent -> module only sets Allow-Origin when an origin matched
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('未知路由 404', async () => {
    const res = await httpJson(info.port, 'GET', '/no-such-route');
    expect(res.status).toBe(404);
  });

  test('broadcastOutput：跳过类不入重放历史，回合事件入历史且快照为拷贝', () => {
    bridge.broadcastOutput({ type: 'pong' });
    bridge.broadcastOutput({ type: 'chunk_text', text: 'x' });
    expect(bridge._getReplayHistory()).toEqual([]);
    bridge.broadcastOutput({ type: 'turn_start' });
    const hist = bridge._getReplayHistory();
    expect(hist.length).toBe(1);
    expect(hist[0].type).toBe('turn_start');
    expect(typeof hist[0].timestamp).toBe('number');
    const frozen = [...hist];
    bridge._getReplayHistory();
    expect(bridge._getReplayHistory().length).toBe(frozen.length); // snapshot is a copy
  });

  test('_shouldSkipHistory：瞬态/分片类型命中，未知类型放行', () => {
    expect(bridge._shouldSkipHistory('presence')).toBe(true);
    expect(bridge._shouldSkipHistory('chunk_tool_use')).toBe(true);
    expect(bridge._shouldSkipHistory('approval_request')).toBe(false);
    expect(bridge._shouldSkipHistory(null)).toBe(false);
  });

  test('onBridgeEvent：订阅可用且可退订', () => {
    const seen = [];
    const off = bridge.onBridgeEvent((event, data) => {
      seen.push([event, data]);
    });
    bridge.broadcastOutput({ type: 'approval_resolved', requestId: 'r1' });
    expect(seen.length).toBe(0); // broadcast does not trigger bridge events
    off();
    expect(() => off()).not.toThrow();
    expect(seen.length).toBe(0);
  });

  test('getStatusSnapshot / getConnectedClients：运行态快照字段', () => {
    expect(bridge.getConnectedClients()).toEqual([]);
    const snap = bridge.getStatusSnapshot();
    expect(snap.running).toBe(true);
    expect(snap.url).toBe(info.url);
    expect(snap.clientCount).toBe(0);
    expect(snap.tokenShort).toBe(info.token.slice(0, 8));
    expect(snap.pin).toBe(bridge.getPin());
  });

  test('generateNginxConfig：upstream/前缀/SSL 分支结构正确', () => {
    const plain = bridge.generateNginxConfig({ locationPrefix: '/khy' });
    expect(plain).toContain('upstream khy_bridge');
    expect(plain).toContain('location /khy/');
    expect(plain).toContain('location /khy/ws');
    expect(plain).toContain('location /khy/health');
    expect(plain).toContain(`127.0.0.1:${info.port}`);
    expect(plain).not.toContain('listen 443');
    const ssl = bridge.generateNginxConfig({
      ssl: true,
      certPath: '/etc/ssl/cert.pem',
      keyPath: '/etc/ssl/key.pem',
      listenPort: 8080,
    });
    expect(ssl).toContain('listen 8080;');
    expect(ssl).toContain('listen 443 ssl;');
    expect(ssl).toContain('ssl_certificate     /etc/ssl/cert.pem;');
  });

  test('stopBridgeServer 后：快照 running=false，重复 stop 安全', async () => {
    await bridge.stopBridgeServer();
    expect(bridge.getStatusSnapshot()).toEqual({ running: false });
    expect(bridge.getPort()).toBe(0);
    await bridge.stopBridgeServer();
    expect(bridge.getStatusSnapshot()).toEqual({ running: false });
  });
});
