'use strict';

/**
 * proxyConfigService egress 扩展测试(node:test·全离线)。
 *   node --test services/backend/tests/proxyConfigService.egress.test.js
 *
 * 覆盖 activateNode(direct-connect 真实写 env / core-required 门关透传 guidance / unsupported reason)、
 * deactivate 清 env、getStatus additive(activeNode + coreStatus)。
 *
 * 隔离:HOME 重定向到 temp,proxy.json 写沙盒;core-required 用注入 fake spawn 的内核管理器 gate 关证透传。
 * direct-connect 起一个真 TCP 监听让 testProxy 可达(纯本机,离线)。
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');

const ORIG_HOME = process.env.HOME;
const ORIG_FLAG = process.env.KHY_PROXY_CORE;
let TMP_HOME = '';

// 干净清出站相关 env,避免串扰。
function clearProxyEnv() {
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']) {
    delete process.env[k];
  }
}

before(() => {
  TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-egress-'));
  process.env.HOME = TMP_HOME;
});

after(() => {
  process.env.HOME = ORIG_HOME;
  if (ORIG_FLAG === undefined) delete process.env.KHY_PROXY_CORE;
  else process.env.KHY_PROXY_CORE = ORIG_FLAG;
  clearProxyEnv();
});

beforeEach(() => {
  clearProxyEnv();
  delete process.env.KHY_PROXY_CORE;
});

// proxyConfigService 用 os.homedir(),它读的是启动时的 HOME;某些平台缓存。为稳妥直接
// 重定向 KHY_DIR 依赖的 os.homedir → 用 require 缓存后 KHY_DIR 已定。故这里改测策略:
// 不依赖 HOME 生效,转而断言「env 写入 / activeNode 语义 / guidance 透传」这些不依赖落盘路径的行为。
const svc = require('../src/services/proxyConfigService');

test('activateNode: direct-connect 可达 → 写 HTTP_PROXY env + egressMode', async () => {
  // 起一个真本机 TCP 监听,让 testProxy 连得上。
  const server = net.createServer((s) => s.destroy());
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  try {
    const r = await svc.activateNode({ name: 'direct-1', type: 'http', server: '127.0.0.1', port });
    assert.equal(r.success, true);
    assert.equal(r.egressMode, 'direct-connect');
    assert.equal(process.env.HTTP_PROXY, `http://127.0.0.1:${port}`);
    assert.equal(process.env.http_proxy, `http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await svc.deactivate();
  }
});

test('activateNode: direct-connect 不可达 → unreachable,不写 env', async () => {
  // 用一个几乎必然没人听的端口。
  const r = await svc.activateNode({ name: 'dead', type: 'http', server: '127.0.0.1', port: 1 });
  assert.equal(r.success, false);
  assert.equal(r.reason, 'unreachable');
  assert.equal(process.env.HTTP_PROXY, undefined);
});

test('activateNode: core-required 门关 → 透传 disabled guidance,egressMode=core-required,不写 env', async () => {
  // 门默认关(beforeEach 已删 env)。
  const r = await svc.activateNode({
    name: 'hk', type: 'vmess', server: 'a.com', port: 443, uuid: 'u-1', cipher: 'auto',
  });
  assert.equal(r.success, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(r.egressMode, 'core-required');
  assert.match(r.guidance, /KHY_PROXY_CORE/);
  assert.equal(process.env.HTTP_PROXY, undefined);
});

test('activateNode: core-required 门开但内核缺失 → core-missing 指引,不谎报生效', async () => {
  process.env.KHY_PROXY_CORE = '1';
  const core = require('../src/services/proxy/proxyCoreManager');
  const restore = core._setDeps({
    fs: { accessSync() { throw new Error('ENOENT'); }, constants: { X_OK: 1 } },
  });
  try {
    const r = await svc.activateNode({
      name: 'hk', type: 'vmess', server: 'a.com', port: 443, uuid: 'u-1', cipher: 'auto',
    });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'core-missing');
    assert.match(r.guidance, /mihomo/);
    assert.equal(process.env.HTTP_PROXY, undefined);
  } finally {
    restore();
  }
});

test('activateNode: core-required 门开 + fake spawn 握手 → 写 127.0.0.1:mixedPort env', async () => {
  process.env.KHY_PROXY_CORE = '1';
  const { EventEmitter } = require('events');
  const core = require('../src/services/proxy/proxyCoreManager');
  const child = new EventEmitter();
  child.pid = 7777;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const restore = core._setDeps({
    isFlagEnabled: () => true,
    spawn: () => child,
    fs: { accessSync() {}, constants: { X_OK: 1 }, mkdirSync() {}, writeFileSync() {} },
    setTimeout: () => ({}),
    clearTimeout: () => {},
    safeSignal: () => {}, safeKill: () => {},
  });
  try {
    const p = svc.activateNode(
      { name: 'hk', type: 'vmess', server: 'a.com', port: 443, uuid: 'u-1', cipher: 'auto' },
      { mixedPort: 7912 },
    );
    setImmediate(() => child.stdout.emit('data', 'start initial compatible provider'));
    const r = await p;
    assert.equal(r.success, true);
    assert.equal(r.egressMode, 'core-required');
    assert.equal(r.mixedPort, 7912);
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:7912');
    // 在 fake deps 仍生效时停,避免真 3s SIGKILL 定时器。
    setImmediate(() => child.emit('exit', 0));
    await svc.deactivate();
  } finally {
    restore();
  }
});

test('activateNode: unsupported 协议 → reason unsupported + 描述,不写 env', async () => {
  const r = await svc.activateNode({ name: 'wg', type: 'wireguard', server: 'h', port: 51820 });
  assert.equal(r.success, false);
  assert.equal(r.reason, 'unsupported');
  assert.equal(r.egressMode, 'unsupported');
  assert.match(r.error, /暂不支持|wireguard/);
  assert.equal(process.env.HTTP_PROXY, undefined);
});

test('deactivate: 清 env(幂等,内核未跑也不抛)', async () => {
  process.env.HTTP_PROXY = 'http://127.0.0.1:9999';
  process.env.http_proxy = 'http://127.0.0.1:9999';
  const r = await svc.deactivate();
  assert.equal(r.success, true);
  assert.equal(process.env.HTTP_PROXY, undefined);
  assert.equal(process.env.http_proxy, undefined);
});

test('getStatus: additive 附 activeNode(默认 null)+ coreStatus 形状', () => {
  const s = svc.getStatus();
  // 旧字段仍在。
  assert.ok('enabled' in s);
  assert.ok('type' in s);
  assert.ok('subscriptions' in s);
  // 新字段 additive。
  assert.ok('activeNode' in s);
  assert.ok('coreStatus' in s);
  assert.ok(s.coreStatus && typeof s.coreStatus === 'object');
  assert.equal(typeof s.coreStatus.running, 'boolean');
  assert.equal(typeof s.coreStatus.binaryInstalled, 'boolean');
});
