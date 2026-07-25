'use strict';

/**
 * proxyCoreInstaller.test.js — 「装完即用」mihomo 内核自动获取器的行为契约(全离线)。
 *
 * 真实缺口(用户诉求 2026-07-11「自动装 mihomo」):raw 节点需本机内核,缺失时只给手动指引。
 * 本模块把获取自动化:已装 → 采纳本机 PATH 现成内核 → 官方 HTTPS 固定版本下载。
 *
 * 沙盒无网、真实隧道 E2E 需有网机器 → 所有 IO 经 _deps 注入,喂 fake 证明全链路:
 *   采纳 / 下载 / SHA256 校验(命中/不符 fail-closed)/ 解压 / 落地 / 门控回退 / fail-soft 绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const inst = require('../../src/services/proxy/proxyCoreInstaller');
const mgr = require('../../src/services/proxy/proxyCoreManager');
const { FLAG } = inst;

// ── 内存 fake fs(记录写/chmod/unlink)──────────────────────────────────────
function makeFs(initial = {}) {
  const store = { ...initial };
  const chmods = [];
  const mkdirs = [];
  return {
    store,
    chmods,
    mkdirs,
    constants: { X_OK: 1 },
    accessSync(p) {
      if (!(p in store)) {
        const e = new Error(`ENOENT: ${p}`);
        e.code = 'ENOENT';
        throw e;
      }
    },
    mkdirSync(p) {
      mkdirs.push(p);
    },
    readFileSync(p) {
      if (!(p in store)) {
        const e = new Error(`ENOENT: ${p}`);
        e.code = 'ENOENT';
        throw e;
      }
      return store[p];
    },
    writeFileSync(p, data) {
      store[p] = data;
    },
    chmodSync(p, m) {
      chmods.push([p, m]);
    },
    unlinkSync(p) {
      if (!(p in store)) {
        const e = new Error(`ENOENT: ${p}`);
        e.code = 'ENOENT';
        throw e;
      }
      delete store[p];
    },
  };
}

// 门开(default-on)注入基座:linux/x64、tester home、gate 开。
function baseDeps(overrides = {}) {
  return Object.assign(
    {
      platform: () => 'linux',
      arch: () => 'x64',
      homedir: () => '/home/tester',
      env: () => ({}),
      isFlagEnabled: () => true,
    },
    overrides,
  );
}

const BIN = '/home/tester/.khyquant/bin/mihomo';

// ── resolveAsset ─────────────────────────────────────────────────────────────
test('resolveAsset: supported platforms map to official pinned URL', () => {
  const a = inst.resolveAsset('linux', 'x64');
  assert.ok(a);
  assert.match(a.url, /^https:\/\/github\.com\/MetaCubeX\/mihomo\/releases\/download\//);
  assert.match(a.file, /linux-amd64-compatible/);
  assert.strictEqual(a.kind, 'gz');
});

test('resolveAsset: unsupported platform → null', () => {
  assert.strictEqual(inst.resolveAsset('freebsd', 'x64'), null);
  assert.strictEqual(inst.resolveAsset('win32', 'arm64'), null);
});

// ── _binaryPath ⟷ manager.BINARY_PATH 一致性(防落地/读取路径漂移)──────────
test('_binaryPath matches proxyCoreManager.BINARY_PATH under real homedir', () => {
  const os = require('os');
  const restore = inst._setDeps({ homedir: () => os.homedir(), platform: () => process.platform, arch: () => process.arch });
  try {
    assert.strictEqual(inst._binaryPath(), mgr.BINARY_PATH);
  } finally {
    restore();
  }
});

// ── isEnabled 门控(fail-closed:异常视为关)────────────────────────────────
test('isEnabled: reflects flagRegistry; throwing registry → closed', () => {
  let r = inst._setDeps(baseDeps({ isFlagEnabled: () => true }));
  assert.strictEqual(inst.isEnabled({}), true);
  r();
  r = inst._setDeps(baseDeps({ isFlagEnabled: () => { throw new Error('boom'); } }));
  assert.strictEqual(inst.isEnabled({}), false);
  r();
});

// ── 采纳本机 PATH 现成内核 ───────────────────────────────────────────────────
test('adoptFromPath: copies PATH binary into bin dir + chmod', () => {
  const fs = makeFs({ '/usr/bin/mihomo': Buffer.from('REALCORE') });
  const restore = inst._setDeps(baseDeps({
    fs,
    spawnSync: (finder, args) => {
      assert.strictEqual(finder, 'which');
      return args[0] === 'mihomo' ? { status: 0, stdout: '/usr/bin/mihomo\n' } : { status: 1, stdout: '' };
    },
  }));
  try {
    const res = inst.adoptFromPath();
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.method, 'adopted');
    assert.strictEqual(res.path, BIN);
    assert.strictEqual(res.source, '/usr/bin/mihomo');
    assert.deepStrictEqual(fs.store[BIN], Buffer.from('REALCORE'));
    assert.deepStrictEqual(fs.chmods, [[BIN, 0o755]]);
  } finally {
    restore();
  }
});

test('adoptFromPath: not on PATH → structured miss (no throw)', () => {
  const fs = makeFs();
  const restore = inst._setDeps(baseDeps({ fs, spawnSync: () => ({ status: 1, stdout: '' }) }));
  try {
    const res = inst.adoptFromPath();
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.reason, 'not-on-path');
  } finally {
    restore();
  }
});

// ── downloadCore: 门关直接跳过 ───────────────────────────────────────────────
test('downloadCore: gate off → disabled, no network', async () => {
  let called = false;
  const restore = inst._setDeps(baseDeps({
    isFlagEnabled: () => false,
    download: async () => { called = true; },
  }));
  try {
    const res = await inst.downloadCore({ env: {} });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.reason, 'disabled');
    assert.strictEqual(called, false);
  } finally {
    restore();
  }
});

// ── downloadCore: 不支持平台 / win zip 手动指引 ─────────────────────────────
test('downloadCore: unsupported platform → structured', async () => {
  const restore = inst._setDeps(baseDeps({ platform: () => 'freebsd', arch: () => 'x64' }));
  try {
    const res = await inst.downloadCore({ env: {} });
    assert.strictEqual(res.reason, 'unsupported-platform');
  } finally {
    restore();
  }
});

test('downloadCore: win32 .zip → unpack-unsupported guidance (not silent)', async () => {
  const restore = inst._setDeps(baseDeps({ platform: () => 'win32', arch: () => 'x64' }));
  try {
    const res = await inst.downloadCore({ env: {} });
    assert.strictEqual(res.reason, 'unpack-unsupported');
    assert.match(res.guidance, /手动下载/);
  } finally {
    restore();
  }
});

// ── downloadCore: happy path(无 sha256 → https-official 传输级完整性)──────
test('downloadCore: gz happy path writes binary + chmod (https-official)', async () => {
  const fs = makeFs();
  const tmp = `${BIN}.download`;
  const restore = inst._setDeps(baseDeps({
    fs,
    download: async (url, dest) => { fs.writeFileSync(dest, Buffer.from('GZBYTES')); },
    gunzip: (buf) => { assert.deepStrictEqual(buf, Buffer.from('GZBYTES')); return Buffer.from('MIHOMO-ELF'); },
  }));
  try {
    const res = await inst.downloadCore({ env: {} });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.method, 'downloaded');
    assert.strictEqual(res.integrity, 'https-official');
    assert.deepStrictEqual(fs.store[BIN], Buffer.from('MIHOMO-ELF'));
    assert.deepStrictEqual(fs.chmods, [[BIN, 0o755]]);
    assert.ok(!(tmp in fs.store), 'temp download file must be cleaned up');
  } finally {
    restore();
  }
});

// ── downloadCore: SHA256 命中 → downloaded-verified ─────────────────────────
test('downloadCore: sha256 pin match → verified', async () => {
  const fs = makeFs();
  const origAssets = JSON.parse(JSON.stringify(inst.ASSETS['linux:x64']));
  inst.ASSETS['linux:x64'].sha256 = 'cafef00d';
  const restore = inst._setDeps(baseDeps({
    fs,
    download: async (url, dest) => { fs.writeFileSync(dest, Buffer.from('GZBYTES')); },
    sha256: () => 'CAFEF00D', // 大小写不敏感比对
    gunzip: () => Buffer.from('MIHOMO-ELF'),
  }));
  try {
    const res = await inst.downloadCore({ env: {} });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.method, 'downloaded-verified');
    assert.strictEqual(res.integrity, 'sha256-pinned');
    assert.deepStrictEqual(fs.store[BIN], Buffer.from('MIHOMO-ELF'));
  } finally {
    restore();
    inst.ASSETS['linux:x64'].sha256 = origAssets.sha256;
  }
});

// ── downloadCore: SHA256 不符 → fail-closed(不解压、不落地、清临时)─────────
test('downloadCore: sha256 mismatch → fail-closed, nothing lands', async () => {
  const fs = makeFs();
  const tmp = `${BIN}.download`;
  inst.ASSETS['linux:x64'].sha256 = 'expected-good';
  let unpacked = false;
  const restore = inst._setDeps(baseDeps({
    fs,
    download: async (url, dest) => { fs.writeFileSync(dest, Buffer.from('TAMPERED')); },
    sha256: () => 'actual-bad',
    gunzip: () => { unpacked = true; return Buffer.from('x'); },
  }));
  try {
    const res = await inst.downloadCore({ env: {} });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.reason, 'sha256-mismatch');
    assert.strictEqual(res.expected, 'expected-good');
    assert.strictEqual(res.actual, 'actual-bad');
    assert.strictEqual(unpacked, false, 'must not unpack a tampered artifact');
    assert.ok(!(BIN in fs.store), 'binary must not land on mismatch');
    assert.ok(!(tmp in fs.store), 'temp file must be removed on mismatch');
    assert.deepStrictEqual(fs.chmods, [], 'never chmod a rejected artifact');
  } finally {
    restore();
    inst.ASSETS['linux:x64'].sha256 = null;
  }
});

// ── downloadCore: 下载失败 → 结构化 + 清临时 ────────────────────────────────
test('downloadCore: download error → structured, no binary', async () => {
  const fs = makeFs();
  const restore = inst._setDeps(baseDeps({
    fs,
    download: async () => { throw new Error('network down'); },
  }));
  try {
    const res = await inst.downloadCore({ env: {} });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.reason, 'download-failed');
    assert.match(res.error, /network down/);
    assert.ok(!(BIN in fs.store));
  } finally {
    restore();
  }
});

// ── install 编排:已装 → existing ───────────────────────────────────────────
test('install: already installed → existing (no adopt/download)', async () => {
  const fs = makeFs({ [BIN]: Buffer.from('present') });
  let adoptTried = false;
  const restore = inst._setDeps(baseDeps({
    fs,
    spawnSync: () => { adoptTried = true; return { status: 1, stdout: '' }; },
    download: async () => { throw new Error('should not download'); },
  }));
  try {
    const res = await inst.install({ env: {} });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.method, 'existing');
    assert.strictEqual(adoptTried, false);
  } finally {
    restore();
  }
});

// ── install 编排:采纳成功即短路,不联网 ────────────────────────────────────
test('install: adopt success short-circuits download', async () => {
  const fs = makeFs({ '/usr/bin/mihomo': Buffer.from('CORE') });
  let downloaded = false;
  const restore = inst._setDeps(baseDeps({
    fs,
    spawnSync: (finder, args) => (args[0] === 'mihomo' ? { status: 0, stdout: '/usr/bin/mihomo\n' } : { status: 1, stdout: '' }),
    download: async () => { downloaded = true; },
  }));
  try {
    const res = await inst.install({ env: {} });
    assert.strictEqual(res.method, 'adopted');
    assert.strictEqual(downloaded, false);
  } finally {
    restore();
  }
});

// ── install 编排:不在 PATH + 门关 → disabled 指引,不联网 ──────────────────
test('install: not on path + gate off → disabled guidance, no network', async () => {
  const fs = makeFs();
  let downloaded = false;
  const restore = inst._setDeps(baseDeps({
    fs,
    isFlagEnabled: () => false,
    spawnSync: () => ({ status: 1, stdout: '' }),
    download: async () => { downloaded = true; },
  }));
  try {
    const res = await inst.install({ env: {} });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.reason, 'disabled');
    assert.match(res.guidance, new RegExp(FLAG));
    assert.strictEqual(downloaded, false);
  } finally {
    restore();
  }
});

// ── install 编排:不在 PATH + 门开 → 走下载并落地 ───────────────────────────
test('install: not on path + gate on → downloads and lands', async () => {
  const fs = makeFs();
  const restore = inst._setDeps(baseDeps({
    fs,
    spawnSync: () => ({ status: 1, stdout: '' }),
    download: async (url, dest) => { fs.writeFileSync(dest, Buffer.from('GZ')); },
    gunzip: () => Buffer.from('ELF'),
  }));
  try {
    const res = await inst.install({ env: {} });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.method, 'downloaded');
    assert.deepStrictEqual(fs.store[BIN], Buffer.from('ELF'));
  } finally {
    restore();
  }
});

// ── fail-soft:install 内部任何异常绝不抛 ────────────────────────────────────
test('install: never throws even if a dep explodes', async () => {
  const restore = inst._setDeps(baseDeps({
    fs: { accessSync() { throw new Error('fs broken'); }, constants: { X_OK: 1 } },
    spawnSync: () => { throw new Error('spawn broken'); },
  }));
  try {
    let res;
    await assert.doesNotReject(async () => { res = await inst.install({ env: {} }); });
    assert.strictEqual(res.success, false);
  } finally {
    restore();
  }
});

// ── describeCoreDownload:「内核去哪下」人可读描述符(纯函数·零 IO·SSOT) ──────────
test('describeCoreDownload: 受支持平台给出确切官方固定 URL + 落地路径', () => {
  const dl = inst.describeCoreDownload('linux', 'x64');
  assert.strictEqual(dl.supported, true);
  assert.strictEqual(dl.version, inst.PINNED_VERSION);
  // URL 必须是官方 RELEASE_BASE 下的固定资产(与自动下载走同一 SSOT)。
  assert.ok(dl.url.startsWith(inst.RELEASE_BASE + '/'), 'url 走官方固定资产路径');
  assert.ok(dl.url.includes('mihomo-linux-amd64'), 'linux amd64 资产名');
  assert.strictEqual(dl.assetFile, inst.resolveAsset('linux', 'x64').file);
  assert.strictEqual(dl.dest, inst._binaryPath());
  assert.strictEqual(dl.binDir, require('path').dirname(inst._binaryPath()));
  assert.strictEqual(dl.releasesPage, 'https://github.com/MetaCubeX/mihomo/releases');
});

test('describeCoreDownload: win32 给 .zip 资产 + mihomo.exe 落地', () => {
  const dl = inst.describeCoreDownload('win32', 'x64');
  assert.strictEqual(dl.supported, true);
  assert.ok(dl.url.endsWith('.zip'), 'windows 资产为 zip');
  assert.strictEqual(dl.kind, 'zip');
});

test('describeCoreDownload: 冷门平台 supported=false 但仍给 releases 页 + 落地路径(绝不留死路)', () => {
  const dl = inst.describeCoreDownload('freebsd', 'x64');
  assert.strictEqual(dl.supported, false);
  assert.strictEqual(dl.url, undefined);
  assert.strictEqual(dl.assetFile, undefined);
  assert.strictEqual(dl.releasesPage, 'https://github.com/MetaCubeX/mihomo/releases');
  assert.ok(dl.dest && dl.binDir, '仍给落地路径');
});

test('describeCoreDownload: 缺省参数走真实平台探测(不抛)', () => {
  assert.doesNotThrow(() => inst.describeCoreDownload());
  const dl = inst.describeCoreDownload();
  assert.ok(dl && typeof dl.releasesPage === 'string' && dl.dest);
});
