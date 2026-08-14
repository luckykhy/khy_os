'use strict';

/**
 * proxyCoreManager 测试(node:test,注入 fake spawn/fs/net 全离线证绿)。
 *   node --test services/backend/tests/proxyCoreManager.test.js
 *
 * 诚实边界:真实 spawn mihomo 二进制 + 隧道 E2E 无法离线证绿(仓库无内核二进制、无 live 节点)。
 * 这里以注入 fake spawn 证明:握手成功路径、二进制缺失指引(不抛)、门关回退、stop 生命周期。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const mgr = require('../src/services/proxy/proxyCoreManager');

const VMESS_NODE = {
  name: '🇭🇰 HK-01', type: 'vmess', server: 'a.example.com', port: 443,
  uuid: 'u-1234', cipher: 'auto', alterId: 0, network: 'ws',
};

// 造一个假子进程:stdout/stderr 为 EventEmitter,可手动 emit 握手行。
function makeFakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  return child;
}

// 门恒开(绕过真实 env)。
const gateOpen = { isFlagEnabled: () => true };
const gateClosed = { isFlagEnabled: () => false };

test('start: 门关 → disabled 指引,不 spawn、不写盘、不抛', async () => {
  let spawned = false;
  let wrote = false;
  const restore = mgr._setDeps({
    ...gateClosed,
    spawn: () => { spawned = true; return makeFakeChild(); },
    fs: { mkdirSync() { wrote = true; }, writeFileSync() { wrote = true; },
      accessSync() {}, constants: { X_OK: 1 } },
  });
  try {
    const r = await mgr.start(VMESS_NODE, { mixedPort: 7899 });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'disabled');
    assert.match(r.guidance, /KHY_PROXY_CORE/);
    assert.equal(spawned, false);
    assert.equal(wrote, false);
  } finally {
    restore();
  }
});

test('start: 门开但二进制缺失 + 自动安装也没装上 → core-missing 指引(指名路径),绝不静默/不谎报', async () => {
  let spawned = false;
  const restore = mgr._setDeps({
    ...gateOpen,
    spawn: () => { spawned = true; return makeFakeChild(); },
    // 自动安装尝试了但没装上(本机无现成内核、无网):仍应退回 core-missing,不 spawn。
    installer: { install: async () => ({ success: false, reason: 'not-on-path' }) },
    fs: {
      accessSync() { throw new Error('ENOENT'); }, // 二进制不存在(装前装后都缺)
      constants: { X_OK: 1 },
      mkdirSync() {}, writeFileSync() {},
    },
  });
  try {
    const r = await mgr.start(VMESS_NODE);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'core-missing');
    assert.match(r.guidance, /mihomo/);
    assert.match(r.guidance, /\.khyquant/);
    assert.equal(r.autoInstall.attempted, true, '应记录自动安装已尝试');
    assert.equal(r.autoInstall.reason, 'not-on-path');
    assert.equal(spawned, false, '二进制缺失不得 spawn');
  } finally {
    restore();
  }
});

test('start: 二进制缺失 → 自动安装成功 → 二进制就位 → 重试握手成功(装完即用)', async () => {
  let installed = false;
  let installCalls = 0;
  const child = makeFakeChild(9100);
  const restore = mgr._setDeps({
    ...gateOpen,
    spawn: () => child,
    installer: {
      install: async () => { installCalls += 1; installed = true; return { success: true, method: 'downloaded' }; },
    },
    fs: {
      // 装之前 accessSync 抛(缺);装之后放行(就位)。
      accessSync() { if (!installed) throw new Error('ENOENT'); },
      constants: { X_OK: 1 },
      mkdirSync() {}, writeFileSync() {},
    },
    setTimeout: () => ({}),
    clearTimeout: () => {},
  });
  try {
    const p = mgr.start(VMESS_NODE, { mixedPort: 7901 });
    setImmediate(() => child.stdout.emit('data', Buffer.from('INFO Mixed proxy listening at: 127.0.0.1:7901')));
    const r = await p;
    assert.equal(installCalls, 1, '应只尝试安装一次');
    assert.equal(r.success, true, '装上后应握手成功');
    assert.equal(r.mixedPort, 7901);
  } finally {
    restore();
    await mgr.stop();
  }
});

test('start: 二进制缺失 + 自动安装门关 → 不尝试安装,直接 core-missing(逐字节回退)', async () => {
  let installCalled = false;
  const restore = mgr._setDeps({
    // KHY_PROXY_CORE 开,但 KHY_PROXY_CORE_AUTO_INSTALL 关。
    isFlagEnabled: (flag) => flag !== 'KHY_PROXY_CORE_AUTO_INSTALL',
    spawn: () => makeFakeChild(),
    installer: { install: async () => { installCalled = true; return { success: true }; } },
    fs: { accessSync() { throw new Error('ENOENT'); }, constants: { X_OK: 1 }, mkdirSync() {}, writeFileSync() {} },
  });
  try {
    const r = await mgr.start(VMESS_NODE);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'core-missing');
    assert.equal(installCalled, false, '门关时绝不尝试自动安装');
    assert.equal(r.autoInstall, undefined, '门关时无自动安装诊断字段(与旧行为一致)');
  } finally {
    restore();
  }
});

test('start: 自动安装内部抛异常 → fail-soft 退回 core-missing(不阻断、不谎报)', async () => {
  const restore = mgr._setDeps({
    ...gateOpen,
    spawn: () => makeFakeChild(),
    installer: { install: async () => { throw new Error('boom'); } },
    fs: { accessSync() { throw new Error('ENOENT'); }, constants: { X_OK: 1 }, mkdirSync() {}, writeFileSync() {} },
  });
  try {
    const r = await mgr.start(VMESS_NODE);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'core-missing');
    assert.equal(r.autoInstall.reason, 'install-threw');
    assert.match(r.autoInstall.error, /boom/);
  } finally {
    restore();
  }
});

test('start: 门开 + 配置非法(缺 uuid 的 vmess)→ config-invalid,列 missing,不 spawn', async () => {
  let spawned = false;
  const restore = mgr._setDeps({
    ...gateOpen,
    spawn: () => { spawned = true; return makeFakeChild(); },
    fs: { accessSync() {}, constants: { X_OK: 1 }, mkdirSync() {}, writeFileSync() {} },
  });
  try {
    const r = await mgr.start({ name: 'x', type: 'vmess', server: 'h', port: 443 });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'config-invalid');
    assert.ok(Array.isArray(r.missing));
    assert.ok(r.missing.includes('uuid'));
    assert.equal(spawned, false);
  } finally {
    restore();
  }
});

test('start: 握手成功 → success + mixedPort + pid + 写了配置', async () => {
  const child = makeFakeChild(9001);
  let writtenPath = '';
  let writtenBody = '';
  const restore = mgr._setDeps({
    ...gateOpen,
    spawn: () => child,
    fs: {
      accessSync() {}, constants: { X_OK: 1 },
      mkdirSync() {},
      writeFileSync(p, body) { writtenPath = p; writtenBody = body; },
    },
    // 立即回调,避免真定时器。
    setTimeout: () => ({}),
    clearTimeout: () => {},
  });
  try {
    const p = mgr.start(VMESS_NODE, { mixedPort: 7900 });
    // 下一 tick emit 握手行。
    setImmediate(() => child.stdout.emit('data', Buffer.from('INFO Mixed(http+socks) proxy listening at: 127.0.0.1:7900')));
    const r = await p;
    assert.equal(r.success, true);
    assert.equal(r.mixedPort, 7900);
    assert.equal(r.pid, 9001);
    assert.match(writtenPath, /proxy-core\.yaml$/);
    assert.match(writtenBody, /mixed-port: 7900/);
    assert.equal(mgr.isRunning(), true);
  } finally {
    restore();
    await mgr.stop();
  }
});

test('start: 子进程未握手先退出 → exited 报错(不谎报成功)', async () => {
  const child = makeFakeChild();
  const restore = mgr._setDeps({
    ...gateOpen,
    spawn: () => child,
    fs: { accessSync() {}, constants: { X_OK: 1 }, mkdirSync() {}, writeFileSync() {} },
    setTimeout: () => ({}),
    clearTimeout: () => {},
  });
  try {
    const p = mgr.start(VMESS_NODE);
    setImmediate(() => child.emit('exit', 1));
    const r = await p;
    assert.equal(r.success, false);
    assert.equal(r.reason, 'exited');
    assert.equal(mgr.isRunning(), false);
  } finally {
    restore();
  }
});

test('stop: 已跑 → SIGTERM 后 exit 事件即解析,清状态', async () => {
  const child = makeFakeChild();
  let signaled = '';
  const restore = mgr._setDeps({
    ...gateOpen,
    spawn: () => child,
    fs: { accessSync() {}, constants: { X_OK: 1 }, mkdirSync() {}, writeFileSync() {} },
    setTimeout: () => ({}),
    clearTimeout: () => {},
    safeSignal: (_c, sig) => { signaled = sig; },
    safeKill: () => {},
  });
  try {
    const p = mgr.start(VMESS_NODE);
    setImmediate(() => child.stdout.emit('data', 'start initial'));
    await p;
    assert.equal(mgr.isRunning(), true);
    const stopP = mgr.stop();
    setImmediate(() => child.emit('exit', 0));
    await stopP;
    assert.equal(signaled, 'SIGTERM');
    assert.equal(mgr.isRunning(), false);
    assert.equal(mgr.getStatus().mixedPort, null);
  } finally {
    restore();
  }
});

test('_dumpYaml: mihomo 配置形状 round-trip 合理(mixed-port/proxies/rules)', () => {
  const cfg = {
    'mixed-port': 7899,
    'allow-lan': false,
    mode: 'global',
    proxies: [{ name: 'n', type: 'vmess', server: 'h', port: 443, uuid: 'u' }],
    'proxy-groups': [{ name: 'KHY', type: 'select', proxies: ['n'] }],
    rules: ['MATCH,KHY'],
  };
  const yaml = mgr._dumpYaml(cfg);
  assert.match(yaml, /mixed-port: 7899/);
  assert.match(yaml, /allow-lan: false/);
  assert.match(yaml, /mode: global/);
  assert.match(yaml, /- name: n/);
  // 标量数组内联;含逗号 → 元素加引号。
  assert.match(yaml, /rules: \["MATCH,KHY"\]/);
});

// ── 「内核去哪下」指引接线(门 KHY_PROXY_CORE_DOWNLOAD_HINT default-on) ───────────
// 假下载描述符(镜像 installer.describeCoreDownload 形状),供注入验证透传。
const FAKE_DL = {
  supported: true, version: 'v1.18.10',
  url: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.18.10/mihomo-linux-amd64-compatible-v1.18.10.gz',
  assetFile: 'mihomo-linux-amd64-compatible-v1.18.10.gz', kind: 'gz',
  binDir: '/home/x/.khyquant/bin', dest: '/home/x/.khyquant/bin/mihomo',
  releasesPage: 'https://github.com/MetaCubeX/mihomo/releases', platform: 'linux', arch: 'x64',
};

test('getStatus: 静态形状 additive(running/enabled/binaryInstalled/binaryPath)', () => {
  const restore = mgr._setDeps({
    ...gateClosed,
    fs: { accessSync() { throw new Error('nope'); }, constants: { X_OK: 1 } },
  });
  try {
    const s = mgr.getStatus();
    assert.equal(s.running, false);
    assert.equal(s.enabled, false);
    assert.equal(s.binaryInstalled, false);
    assert.match(s.binaryPath, /mihomo/);
    assert.equal(s.mixedPort, null);
  } finally {
    restore();
  }
});

test('getStatus: 下载指引门开 → 附 installer.describeCoreDownload 描述符(前端据此显示 URL)', () => {
  const restore = mgr._setDeps({
    isFlagEnabled: () => true, // 含 KHY_PROXY_CORE_DOWNLOAD_HINT 开
    installer: { describeCoreDownload: () => FAKE_DL },
    fs: { accessSync() { throw new Error('nope'); }, constants: { X_OK: 1 } },
  });
  try {
    const s = mgr.getStatus();
    assert.ok(s.download, '门开应附 download 描述符');
    assert.equal(s.download.supported, true);
    assert.equal(s.download.url, FAKE_DL.url);
    assert.equal(s.download.binDir, FAKE_DL.binDir);
  } finally {
    restore();
  }
});

test('getStatus: 下载指引门关 → download=null(逐字节回退,旧消费者不受影响)', () => {
  const restore = mgr._setDeps({
    isFlagEnabled: (flag) => flag !== 'KHY_PROXY_CORE_DOWNLOAD_HINT',
    installer: { describeCoreDownload: () => FAKE_DL },
    fs: { accessSync() { throw new Error('nope'); }, constants: { X_OK: 1 } },
  });
  try {
    const s = mgr.getStatus();
    assert.equal(s.download, null, '门关时 download 必须为 null');
  } finally {
    restore();
  }
});

test('getStatus: describeCoreDownload 抛异常 → fail-soft download=null(不拖垮 status)', () => {
  const restore = mgr._setDeps({
    isFlagEnabled: () => true,
    installer: { describeCoreDownload: () => { throw new Error('boom'); } },
    fs: { accessSync() { throw new Error('nope'); }, constants: { X_OK: 1 } },
  });
  try {
    let s;
    assert.doesNotThrow(() => { s = mgr.getStatus(); });
    assert.equal(s.download, null);
  } finally {
    restore();
  }
});

test('start core-missing: 下载指引门开 + 受支持平台 → guidance 直接含确切官方 URL + download 描述符', async () => {
  const restore = mgr._setDeps({
    isFlagEnabled: (flag) => flag !== 'KHY_PROXY_CORE_AUTO_INSTALL', // CORE 开、AUTO_INSTALL 关(不走安装)、HINT 开
    spawn: () => makeFakeChild(),
    installer: {
      install: async () => ({ success: false, reason: 'not-on-path' }),
      describeCoreDownload: () => FAKE_DL,
    },
    fs: { accessSync() { throw new Error('ENOENT'); }, constants: { X_OK: 1 }, mkdirSync() {}, writeFileSync() {} },
  });
  try {
    const r = await mgr.start(VMESS_NODE);
    assert.equal(r.reason, 'core-missing');
    assert.match(r.guidance, /github\.com\/MetaCubeX\/mihomo/, 'guidance 应含确切官方 URL');
    assert.match(r.guidance, /v1\.18\.10/);
    assert.ok(r.download && r.download.url === FAKE_DL.url, '附结构化 download 描述符');
  } finally {
    restore();
  }
});

test('start core-missing: 下载指引门关 → guidance 逐字节回退旧无 URL 文案,无 download 字段', async () => {
  const restore = mgr._setDeps({
    // CORE 开;AUTO_INSTALL 关;HINT 关。
    isFlagEnabled: (flag) => flag === 'KHY_PROXY_CORE',
    spawn: () => makeFakeChild(),
    installer: {
      install: async () => ({ success: false, reason: 'not-on-path' }),
      describeCoreDownload: () => FAKE_DL,
    },
    fs: { accessSync() { throw new Error('ENOENT'); }, constants: { X_OK: 1 }, mkdirSync() {}, writeFileSync() {} },
  });
  try {
    const r = await mgr.start(VMESS_NODE);
    assert.equal(r.reason, 'core-missing');
    assert.doesNotMatch(r.guidance, /github\.com/, '门关时 guidance 不含 URL(旧行为)');
    assert.match(r.guidance, /mihomo/);
    assert.equal(r.download, undefined, '门关时无 download 字段');
  } finally {
    restore();
  }
});
