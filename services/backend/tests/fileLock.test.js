'use strict';

/**
 * Tests for the cross-process single-file lock (multi-instance khyos safety).
 *
 * Core guarantees asserted:
 *   - 绝对防覆盖: concurrent read-modify-write across real separate processes
 *     never loses an update (the killer test, via forked workers).
 *   - 写独占: a live holder blocks a second acquirer until timeout.
 *   - 僵尸锁免疫: a dead-PID / stale-heartbeat lock is reclaimed, never deadlocks.
 *   - 防呆: acquire has a hard timeout and throws FileLockTimeoutError; release is
 *     idempotent; re-entrancy in one process does not self-deadlock; non-write
 *     tools and unresolvable paths acquire nothing.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const L = require('../src/tools/_fileLock');

let tmpDir;
let lockRoot;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-lock-'));
  // Isolate every test's locks in a throwaway root.
  lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-lockroot-'));
  process.env.KHY_FILE_LOCK_DIR = lockRoot;
});

afterEach(() => {
  delete process.env.KHY_FILE_LOCK_DIR;
  for (const d of [tmpDir, lockRoot]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function tmp(name) { return path.join(tmpDir, name); }

// Build a foreign lock dir on disk for a path, with caller-controlled meta — used
// to simulate "another instance holds it" / "a zombie left it behind". Reuses the
// module's own key derivation (which honors KHY_FILE_LOCK_DIR at call time).
function plantLock(absPath, meta) {
  const { lockDir } = L._lockPaths(absPath);
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'meta.json'), JSON.stringify(meta), 'utf-8');
  return lockDir;
}

describe('cross-process exclusion (no lost updates)', () => {
  test('8 forked workers RMW one file under lock → all 8 updates survive', async () => {
    const file = tmp('shared.txt');
    fs.writeFileSync(file, '', 'utf-8');
    const worker = path.join(__dirname, 'fixtures', 'lockWorker.js');

    const N = 8;
    const runs = Array.from({ length: N }, (_, i) => new Promise((resolve, reject) => {
      const child = fork(worker, [file, `w${i}`, '40'], {
        env: { ...process.env, KHY_FILE_LOCK_DIR: lockRoot },
        stdio: 'inherit',
      });
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker ${i} exit ${code}`)));
      child.on('error', reject);
    }));

    await Promise.all(runs);

    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).sort();
    const expected = Array.from({ length: N }, (_, i) => `w${i}`).sort();
    assert.deepEqual(lines, expected, 'every worker line must survive — no lost update');
  });
});

describe('write-exclusive: live holder blocks', () => {
  test('acquire throws FileLockTimeoutError when an alive holder owns the lock', async () => {
    const file = tmp('busy.txt');
    // A lock owned by THIS process (definitely alive) with a fresh heartbeat.
    plantLock(file, {
      pid: process.pid, host: os.hostname(), token: 'foreign',
      acquiredAt: Date.now(), heartbeatAt: Date.now(),
    });

    await assert.rejects(
      () => L.acquire(file, { timeoutMs: 300 }),
      (err) => {
        assert.equal(err.name, 'FileLockTimeoutError');
        assert.equal(err.code, 'EFILELOCKTIMEOUT');
        assert.equal(err.filePath, file);
        return true;
      },
    );
  });
});

describe('zombie-lock immunity', () => {
  test('dead PID (same host) → lock is reclaimed and acquired', async () => {
    const file = tmp('zombie.txt');
    plantLock(file, {
      pid: 0x7ffffffe, host: os.hostname(), token: 'dead', // almost certainly not running
      acquiredAt: Date.now() - 60000, heartbeatAt: Date.now() - 60000,
    });
    const h = await L.acquire(file, { timeoutMs: 1000 });
    assert.ok(h, 'should reclaim a dead-PID lock');
    h.release();
  });

  test('stale heartbeat from another host → reclaimed', async () => {
    const file = tmp('stalehost.txt');
    plantLock(file, {
      pid: 12345, host: 'some-other-host', token: 'remote',
      acquiredAt: Date.now() - 999999, heartbeatAt: Date.now() - 999999,
    });
    const h = await L.acquire(file, { timeoutMs: 1000 });
    assert.ok(h);
    h.release();
  });
});

describe('_isStale logic', () => {
  test('dead pid → stale', () => {
    assert.equal(L._isStale({ pid: 0x7ffffffe, host: os.hostname(), heartbeatAt: Date.now() }), true);
  });
  test('alive pid (this process) fresh → not stale', () => {
    assert.equal(L._isStale({ pid: process.pid, host: os.hostname(), heartbeatAt: Date.now() }), false);
  });
  test('other host, stale heartbeat → stale', () => {
    assert.equal(L._isStale({ pid: 1, host: 'elsewhere', heartbeatAt: Date.now() - 999999 }), true);
  });
  test('other host, fresh heartbeat → not stale', () => {
    assert.equal(L._isStale({ pid: 1, host: 'elsewhere', heartbeatAt: Date.now() }), false);
  });
  test('null meta → stale (reclaimable)', () => {
    assert.equal(L._isStale(null), true);
  });
});

describe('re-entrancy and release', () => {
  test('same process re-acquire is reentrant; inner release keeps outer', async () => {
    const file = tmp('reentrant.txt');
    const outer = await L.acquire(file, { timeoutMs: 1000 });
    assert.equal(outer.reentrant, false);
    const inner = await L.acquire(file, { timeoutMs: 1000 });
    assert.equal(inner.reentrant, true);
    inner.release();
    // Still held by outer → a foreign-style acquire path would still see it; the
    // in-process refcount is the proof:
    assert.ok(L._heldLocks.has(outer.key), 'outer still holds after inner release');
    outer.release();
    assert.equal(L._heldLocks.has(outer.key), false, 'fully released');
  });

  test('release is idempotent', async () => {
    const file = tmp('idem.txt');
    const h = await L.acquire(file, { timeoutMs: 1000 });
    h.release();
    h.release(); // must not throw
    assert.equal(L._heldLocks.has(h.key), false);
  });
});

describe('decorator gating + helpers', () => {
  test('acquireForToolCall returns null for non-write tools', async () => {
    assert.equal(await L.acquireForToolCall('bash', { command: 'ls' }), null);
    assert.equal(await L.acquireForToolCall('readFile', { path: '/x' }), null);
  });

  test('acquireForToolCall returns null when no path resolvable', async () => {
    assert.equal(await L.acquireForToolCall('apply_patch', { patch: '--- a' }), null);
  });

  test('acquireForToolCall locks a write tool with a path, releasable', async () => {
    const file = tmp('viatool.txt');
    const h = await L.acquireForToolCall('writeFile', { path: file });
    assert.ok(h, 'write tool with path must acquire');
    h.release();
  });

  test('KHY_FILE_LOCK_DISABLED=1 disables locking', async () => {
    process.env.KHY_FILE_LOCK_DISABLED = '1';
    try {
      assert.equal(await L.acquireForToolCall('writeFile', { path: tmp('x') }), null);
    } finally {
      delete process.env.KHY_FILE_LOCK_DISABLED;
    }
  });

  test('isWriteTool covers the file-mutating tools', () => {
    for (const n of ['Write', 'writeFile', 'Edit', 'MultiEdit', 'NotebookEdit', 'fileOp']) {
      assert.equal(L.isWriteTool(n), true, `${n} should be a write tool`);
    }
    for (const n of ['bash', 'readFile', 'grep', 'webSearch']) {
      assert.equal(L.isWriteTool(n), false, `${n} should not be a write tool`);
    }
  });

  test('resolveTargetPath honors path / file_path / notebook_path', () => {
    assert.equal(L.resolveTargetPath({ path: '/a/b.txt' }), '/a/b.txt');
    assert.equal(L.resolveTargetPath({ file_path: '/a/c.txt' }), '/a/c.txt');
    assert.equal(L.resolveTargetPath({ notebook_path: '/a/d.ipynb' }), '/a/d.ipynb');
    assert.equal(L.resolveTargetPath({ nope: 1 }), null);
  });

  test('conflictCopyPath builds file_conflict_khy<tag>.<ext>', () => {
    assert.equal(L.conflictCopyPath('/dir/app.py', 1), '/dir/app_conflict_khy1.py');
    assert.equal(L.conflictCopyPath('/dir/README', 'A'), '/dir/README_conflict_khyA');
  });
});
