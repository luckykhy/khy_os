'use strict';
/**
 * makeSourceSnapshot.test.js —proves the pip/npm full-source snapshot carries
 * the WORKING TREE (uncommitted edits + untracked-not-ignored files), not just
 * `git archive HEAD`. This is the guarantee a cloud-dev-only project relies on:
 * after the machine is wiped, `pip install` + `khy restore` must reproduce
 * everything the user had —committed or not.
 *
 * Dual-runner: jest 下用原生 describe/expect；node --test 下把同一批用例注册
 * 成**独立顶层 test()**（不经 describe 容器）——重型 git E2E（git archive 全树
 * + 解密 + tar 解包）若挂在带默认 30s 超时的父容器里会被 cancelledByParent，
 * 顶层独立注册则每个用例 300s 超时，互不牵连。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const GEN = path.resolve(__dirname, '..', '..', 'scripts', 'makeSourceSnapshot.js');
const {
  decrypt,
  sha256Hex,
  DEFAULT_SOURCE_SECRET,
} = require('../../src/services/sourceSnapshotCrypto');

function git(root, args) {
  // 宿主机 PATH 无 git 时，依次用 KHY_TEST_GIT_DIR / KHY_GIT_PATH 定位可执行文件
  // （jest.gitGlobalSetup 对 jest 侧做同样的事；node --test 侧需要本钩子）。
  const dir = process.env.KHY_TEST_GIT_DIR || process.env.KHY_GIT_PATH;
  let bin = 'git';
  if (dir) {
    const candidate = path.join(String(dir), 'git.exe');
    if (fs.existsSync(candidate)) {
      bin = candidate;
    }
  }
  return execFileSync(bin, ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}
/** Build a repo with one commit, then dirty it: edit tracked, add untracked + ignored. */
function makeDirtyRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-snap-test-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 't@example.com']);
  git(root, ['config', 'user.name', 'tester']);
  fs.writeFileSync(path.join(root, 'committed.txt'), 'COMMITTED-V1\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\nignored.txt\nnode_modules/\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  // Dirty the working tree the way an about-to-expire cloud box would be.
  fs.writeFileSync(path.join(root, 'committed.txt'), 'COMMITTED-V2-EDITED\n'); // uncommitted edit
  fs.writeFileSync(path.join(root, 'brand_new.js'), 'UNTRACKED-NEW-FILE\n'); // untracked, not ignored
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'SECRET-DO-NOT-SHIP\n'); // gitignored
  // A live .env holding a fake-but-secret-shaped credential: the exact class of
  // file that must NEVER travel in the shipped snapshot. It is gitignored, so
  // `git add -A` into the throwaway index drops it.
  fs.writeFileSync(path.join(root, '.env'), 'JWT_SECRET=deadbeefFAKE0000not-a-real-key\n');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'junk'), 'junk');
  return root;
}
/** Run the generator and return { header, destDir } after decrypt+verify+extract. */
function generateAndRestore(root, extraEnv = {}) {
  const out = path.join(root, '_source');
  const res = spawnSync(process.execPath, [
    GEN,
    '--out',
    out,
    '--root',
    root,
    '--timestamp',
    '2026-01-01T00:00:00Z',
    '--require',
  ], { encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  expect(res.status).toBe(0);
  const header = JSON.parse(fs.readFileSync(path.join(out, 'snapshot.json'), 'utf8'));
  const ciphertext = fs.readFileSync(path.join(out, 'khy-os-source.tar.gz.enc'));
  const plaintext = decrypt(ciphertext, header, DEFAULT_SOURCE_SECRET);
  expect(sha256Hex(plaintext)).toBe(header.sha256);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-snap-restore-'));
  const tarPath = path.join(root, 'plain.tar.gz');
  fs.writeFileSync(tarPath, plaintext);
  const x = spawnSync('tar', ['-xzf', tarPath, '-C', dest], { encoding: 'utf8' });
  expect(x.status).toBe(0);
  return { header, dest };
}
const read = (dir, rel) => {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8').trim();
  } catch {
    return null;
  }
};

// ── 用例体（两种运行器共用）────────────────────────────────────────────
function caseWorkingTree() {
  const root = makeDirtyRepo();
  try {
    const { header, dest } = generateAndRestore(root);
    expect(header.captureMode).toBe('working-tree');
    expect(header.includesUncommitted).toBe(true);
    expect(header.dirty).toBe(true);
    expect(read(dest, 'committed.txt')).toBe('COMMITTED-V2-EDITED');
    expect(read(dest, 'brand_new.js')).toBe('UNTRACKED-NEW-FILE');
    // .gitignore is still respected — no secrets, no node_modules bloat.
    expect(read(dest, 'ignored.txt')).toBe(null);
    expect(read(dest, '.env')).toBe(null);
    expect(fs.existsSync(path.join(dest, 'node_modules'))).toBe(false);
    fs.rmSync(dest, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function caseHeadOnly() {
  const root = makeDirtyRepo();
  try {
    const { header, dest } = generateAndRestore(root, { KHY_SNAPSHOT_FROM: 'head' });
    expect(header.captureMode).toBe('head');
    expect(header.includesUncommitted).toBe(false);
    expect(read(dest, 'committed.txt')).toBe('COMMITTED-V1');
    expect(read(dest, 'brand_new.js')).toBe(null);
    fs.rmSync(dest, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function caseCleanTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-snap-clean-'));
  try {
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 't@example.com']);
    git(root, ['config', 'user.name', 'tester']);
    fs.writeFileSync(path.join(root, 'only.txt'), 'ONLY-COMMITTED\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);
    const { header, dest } = generateAndRestore(root);
    expect(header.captureMode).toBe('working-tree');
    expect(header.dirty).toBe(false);
    expect(read(dest, 'only.txt')).toBe('ONLY-COMMITTED');
    fs.rmSync(dest, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── node --test 独立运行：顶层独立 test()，重负载互不牵连 ───────────────
if (typeof globalThis.describe !== 'function') {
  const _nt = require(['node', ':test'].join(''));
  const _assert = require(['node', ':assert/strict'].join(''));
  globalThis.expect = (v) => ({
    toBe: (e) => _assert.strictEqual(v, e),
    toEqual: (e) => _assert.deepStrictEqual(v, e),
    toBeLessThanOrEqual: (e) => _assert.ok(v <= e),
    toBeGreaterThan: (e) => _assert.ok(v > e),
  });
  _nt.test('Make Source Snapshot: default (working-tree) restores uncommitted + untracked, drops ignored', caseWorkingTree, { timeout: 300000 });
  _nt.test('Make Source Snapshot: KHY_SNAPSHOT_FROM=head committed-only, ignores dirty tree', caseHeadOnly, { timeout: 300000 });
  _nt.test('Make Source Snapshot: clean working tree capture == HEAD, dirty=false', caseCleanTree, { timeout: 300000 });
} else {
  describe('Make Source Snapshot', () => {
    test('default (working-tree): restores uncommitted edits + untracked, drops ignored', caseWorkingTree);
    test('KHY_SNAPSHOT_FROM=head: committed-only, ignores the dirty working tree', caseHeadOnly);
    test('clean working tree: working-tree capture == HEAD, dirty=false', caseCleanTree);
  });
}
