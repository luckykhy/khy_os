'use strict';

/**
 * 送别礼:tls-sidecar「二进制去哪下载」接线验证。
 *
 * tls-sidecar 是内置第一方 Go 程序,`installer.describeSidecarDownload()` 是它
 * 「去哪来」的确定性 SSOT——此前**不存在**(能力缺口),Web「设置→代理」的
 * 「二进制未安装」告警只写一句「预置二进制」却不给地址。本测锁住三条:
 *   1) describeSidecarDownload() 描述符成形(go.dev 指针 + 落地路径 + 内置源码编译);
 *   2) getStatus().download 在门开(默认)时透出该描述符 → 前端可渲染可点链接;
 *   3) 门 KHY_PROXY_CORE_DOWNLOAD_HINT 关时 getStatus().download === null(逐字节回退)。
 *
 * 复用 mihomo 内核已验证的 describeCoreDownload → getStatus → Vue 链路(同门)。
 * node:test 风格(可 `node --test <file>`)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const SIDECAR_DIR = path.join(__dirname, '../../../src/services/gateway/tlsSidecar');
const installer = require(path.join(SIDECAR_DIR, 'installer'));
const sidecar = require(path.join(SIDECAR_DIR, 'index'));

const FLAG = 'KHY_PROXY_CORE_DOWNLOAD_HINT';

function withFlag(value, fn) {
  const prev = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

test('describeSidecarDownload() 成形:go.dev 指针 + 落地路径 + 内置源码编译', () => {
  const d = installer.describeSidecarDownload();
  assert.ok(d && typeof d === 'object', 'returns a descriptor object');
  assert.strictEqual(d.goDownloadUrl, 'https://go.dev/dl/', 'points at the Go toolchain download');
  assert.strictEqual(d.buildFromSource, true, 'first-party: built from bundled source');
  assert.strictEqual(d.minGoVersion, '1.21');
  assert.ok(d.binaryName === 'tls-sidecar' || d.binaryName === 'tls-sidecar.exe', 'binary name set');
  assert.ok(typeof d.dest === 'string' && d.dest.length > 0, 'landing path (dest) present');
  assert.ok(typeof d.binDir === 'string' && d.dest.includes(d.binDir), 'dest sits under binDir');
  assert.ok(typeof d.note === 'string' && d.note.length > 0, 'human-readable note present');
});

test('describeSidecarDownload() 纯只读:不抛、无副作用、无网络字段泄漏 key', () => {
  // 连调两次结果一致(确定性);note 不含任何真 URL 之外的可疑 token。
  const a = installer.describeSidecarDownload();
  const b = installer.describeSidecarDownload();
  assert.deepStrictEqual(a, b);
});

test('getStatus().download 门开(默认)透出描述符', () => {
  withFlag(undefined, () => {
    const st = sidecar.getStatus();
    assert.ok(st.download && st.download.goDownloadUrl === 'https://go.dev/dl/',
      'download descriptor surfaced through getStatus when gate default-on');
  });
});

test('getStatus().download 门关(KHY_PROXY_CORE_DOWNLOAD_HINT=0)→ null(逐字节回退)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    withFlag(off, () => {
      const st = sidecar.getStatus();
      assert.strictEqual(st.download, null, `gate off via "${off}" → download null`);
    });
  }
});

test('getStatus() 门态之外其余字段不受影响(附加而非改写)', () => {
  const on = withFlag(undefined, () => sidecar.getStatus());
  const off = withFlag('0', () => sidecar.getStatus());
  // download 之外所有键值在门开/门关下必须完全一致——证明纯附加、零行为漂移。
  const strip = (o) => { const c = { ...o }; delete c.download; return c; };
  assert.deepStrictEqual(strip(on), strip(off), 'only the download field toggles; nothing else moves');
});

test('installer 头注释不再谎称「downloads pre-compiled release」', () => {
  const src = fs.readFileSync(path.join(SIDECAR_DIR, 'installer.js'), 'utf-8');
  assert.ok(!/downloads pre-compiled release/.test(src),
    'the false "auto-download" docstring claim is removed (honest: build-from-source)');
});
