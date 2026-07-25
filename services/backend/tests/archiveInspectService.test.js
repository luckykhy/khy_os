'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const svc = require('../src/services/archiveInspectService');

function _tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khy-archive-test-'));
}

function _makeTree(root) {
  fs.mkdirSync(path.join(root, 'proj', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proj', 'README.md'), 'hello from readme\nline2\n');
  fs.writeFileSync(path.join(root, 'proj', 'src', 'app.js'), 'function add(a,b){return a+b}\n');
  fs.writeFileSync(path.join(root, 'proj', 'blob.bin'), Buffer.from([0, 1, 2, 0, 3, 4]));
}

// ── tar.gz(零 CLI 依赖:node-tar 是仓库依赖)─────────────────────────────────
test('inspectArchive: tar.gz 列出条目(list-only,跳过目录)', async () => {
  const dir = _tmpDir();
  _makeTree(dir);
  const tar = require('tar');
  const tgz = path.join(dir, 'demo.tar.gz');
  tar.c({ file: tgz, cwd: dir, sync: true, gzip: true }, ['proj']);

  const r = await svc.inspectArchive(tgz);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.kindToken, 'tar');
  const names = (r.entries || []).map(e => e.name);
  assert.ok(names.some(n => n.endsWith('README.md')));
  assert.ok(names.some(n => n.endsWith('app.js')));
  assert.ok(names.some(n => n.endsWith('blob.bin')));
  assert.ok(!names.some(n => n.endsWith('/')), 'directories filtered out');
  assert.deepStrictEqual(r.peeks, [], 'tar is list-only (no in-memory peek)');
});

test('inspectArchiveToManifest: tar.gz → 含 [Archive Contents] 清单', async () => {
  const dir = _tmpDir();
  _makeTree(dir);
  const tar = require('tar');
  const tgz = path.join(dir, 'demo.tar.gz');
  tar.c({ file: tgz, cwd: dir, sync: true, gzip: true }, ['proj']);

  const manifest = await svc.inspectArchiveToManifest(tgz);
  assert.ok(manifest.includes('[Archive Contents]'));
  assert.ok(manifest.includes('README.md'));
  assert.ok(manifest.includes('未解压'));
});

// ── zip(若系统有 zip CLI 才建 fixture;否则跳过——zip 路径已由叶子单测覆盖)──────
test('inspectArchive: zip 列出条目 + 窥探小文本条目(跳过二进制)', async (t) => {
  let zipAvailable = true;
  try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); } catch { zipAvailable = false; }
  if (!zipAvailable) { t.skip('zip CLI 不可用,跳过(zip 选择逻辑已由 archiveManifestPolicy 单测覆盖)'); return; }

  const dir = _tmpDir();
  _makeTree(dir);
  const zip = path.join(dir, 'demo.zip');
  execFileSync('zip', ['-q', '-r', zip, 'proj'], { cwd: dir });

  const r = await svc.inspectArchive(zip);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.kindToken, 'zip');
  const peeked = (r.peeks || []).map(p => p.name);
  assert.ok(peeked.some(n => n.endsWith('README.md')), 'README peeked');
  assert.ok(peeked.some(n => n.endsWith('app.js')), 'app.js peeked');
  assert.ok(!peeked.some(n => n.endsWith('blob.bin')), 'binary blob NOT peeked');
  const readmePeek = (r.peeks || []).find(p => p.name.endsWith('README.md'));
  assert.ok(readmePeek && readmePeek.text.includes('hello from readme'));
});

// ── 诚实边界 / 门控 ───────────────────────────────────────────────────────────
test('inspectArchive: 不支持格式(.7z)→ 诚实 error,仍标记为压缩包', async () => {
  const dir = _tmpDir();
  const p = path.join(dir, 'x.7z');
  fs.writeFileSync(p, 'not really 7z');
  const r = await svc.inspectArchive(p);
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.kindToken, 'unsupported');
  assert.ok(/暂不支持/.test(r.error));
});

test('inspectArchive: 非压缩包(.txt)→ skipped', async () => {
  const dir = _tmpDir();
  const p = path.join(dir, 'note.txt');
  fs.writeFileSync(p, 'hi');
  const r = await svc.inspectArchive(p);
  assert.strictEqual(r.skipped, true);
});

test('inspectArchive: 门控关 → skipped(字节回退)', async () => {
  const dir = _tmpDir();
  _makeTree(dir);
  const tar = require('tar');
  const tgz = path.join(dir, 'demo.tar.gz');
  tar.c({ file: tgz, cwd: dir, sync: true, gzip: true }, ['proj']);
  const r = await svc.inspectArchive(tgz, undefined, { env: { KHY_ARCHIVE_INSPECT: 'off' } });
  assert.strictEqual(r.skipped, true);
});

test('inspectArchive: 不存在的文件 → 不抛,success:false', async () => {
  const r = await svc.inspectArchive('/nonexistent/path/to/x.zip');
  assert.strictEqual(r.success, false);
});

test('inspectArchiveToManifest: 不支持格式 → 仍返回诚实清单块(非空)', async () => {
  const dir = _tmpDir();
  const p = path.join(dir, 'x.rar');
  fs.writeFileSync(p, 'rar');
  const manifest = await svc.inspectArchiveToManifest(p);
  assert.ok(manifest.includes('[Archive Contents]'));
  assert.ok(manifest.includes('已识别这是一个压缩包'));
});
