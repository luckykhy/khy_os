'use strict';
/**
 * makeSourceSnapshot.test.js â€?proves the pip/npm full-source snapshot carries
 * the WORKING TREE (uncommitted edits + untracked-not-ignored files), not just
 * `git archive HEAD`. This is the guarantee a cloud-dev-only project relies on:
 * after the machine is wiped, `pip install` + `khy restore` must reproduce
 * everything the user had â€?committed or not.
 *
 * node:test (jest cannot run these). Run with:  node --test tests/cli/makeSourceSnapshot.test.js
 *
 * Each case builds a throwaway git repo, runs the real generator, then decrypts
 * + verifies + extracts using the same crypto single-source the restore path
 * uses, asserting the restored tree matches the live working state.
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
  return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  fs.writeFileSync(path.join(root, 'brand_new.js'), 'UNTRACKED-NEW-FILE\n');   // untracked, not ignored
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'SECRET-DO-NOT-SHIP\n');    // gitignored
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
  const res = spawnSync('node', [
    GEN, '--out', out, '--root', root, '--timestamp', '2026-01-01T00:00:00Z', '--require',
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
  try { return fs.readFileSync(path.join(dir, rel), 'utf8').trim(); } catch { return null; }
};

describe('Make Source Snapshot', () => {
  test('default (working-tree): restores uncommitted edits + untracked, drops ignored', () => {
      const root = makeDirtyRepo();
      try {
        const { header, dest } = generateAndRestore(root);
    
        expect(header.captureMode).toBe('working-tree');
        expect(header.includesUncommitted).toBe(true);
        expect(header.dirty).toBe(true);
    
        // The whole point: the live, uncommitted content comes back.
        expect(read(dest)).toBe('committed.txt');
        expect(read(dest)).toBe('brand_new.js');
    
        // .gitignore is still respected â€?no secrets, no node_modules bloat.
        expect(read(dest)).toBe('ignored.txt');
        expect(read(dest)).toBe('.env');
        expect(fs.existsSync(path.join(dest).toBe('node_modules')), false, 'node_modules must NOT ship');
    
        fs.rmSync(dest, { recursive: true, force: true });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
  });

  test('KHY_SNAPSHOT_FROM=head: committed-only, ignores the dirty working tree', () => {
      const root = makeDirtyRepo();
      try {
        const { header, dest } = generateAndRestore(root, { KHY_SNAPSHOT_FROM: 'head' });
    
        expect(header.captureMode).toBe('head');
        expect(header.includesUncommitted).toBe(false);
    
        // Only the committed version is present; the uncommitted edit is absent.
        expect(read(dest)).toBe('committed.txt');
        expect(read(dest)).toBe('brand_new.js');
    
        fs.rmSync(dest, { recursive: true, force: true });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
  });

  test('clean working tree: working-tree capture == HEAD, dirty=false', () => {
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
        expect(header.dirty).toBe(false, 'clean tree reports dirty=false');
        expect(read(dest)).toBe('only.txt');
        fs.rmSync(dest, { recursive: true, force: true });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
  });

});

