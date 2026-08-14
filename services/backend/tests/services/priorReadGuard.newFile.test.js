'use strict';

/**
 * Regression tests for the priorReadGuard deadlock on file creation + the
 * Windows path-key mismatch.
 *
 * Bug: priorReadGuard blocked EVERY writeFile/editFile whose path was not in the
 * read map — including brand-new files. A new file cannot be Read (Read fails
 * with "file not found"), so the write was permanently blocked → deadlock. On
 * Windows it also falsely blocked already-read files because the guard's lookup
 * key (bare path.resolve) did not match the Windows-normalized read-tracker key.
 *
 * Fix: (1) allow writes to non-existent paths (new-file creation); (2) share
 * _readTracker.normalizePath so keys line up across read/write on Windows.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { priorReadGuard } = require('../../src/services/toolGuards');
const readTracker = require('../../src/tools/_readTracker');

describe('priorReadGuard — new-file creation & read enforcement', () => {
  let tmpDir;

  beforeEach(() => {
    readTracker.clear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'priorread-'));
  });

  afterEach(() => {
    readTracker.clear();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('writing a NEW (non-existent) file is allowed — no deadlock', () => {
    const target = path.join(tmpDir, '新建文件.txt');
    const res = priorReadGuard({
      toolName: 'writeFile',
      params: { file_path: target },
      _fileReadHashes: new Map(),
    });
    expect(res.action).toBe('allow');
  });

  test('writing an EXISTING file that was never read is blocked', () => {
    const target = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(target, 'hello');
    const res = priorReadGuard({
      toolName: 'writeFile',
      params: { file_path: target },
      _fileReadHashes: new Map(),
    });
    expect(res.action).toBe('block');
    expect(res.reason).toMatch(/Prior-read required/);
  });

  test('an EXISTING file recorded in the read tracker is allowed', () => {
    const target = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(target, 'hello');
    readTracker.markRead(target);
    const res = priorReadGuard({
      toolName: 'editFile',
      params: { file_path: target },
      _fileReadHashes: new Map(),
    });
    expect(res.action).toBe('allow');
  });

  test('an EXISTING file present only in the hash map is allowed (fallback)', () => {
    const target = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(target, 'hello');
    const key = readTracker.normalizePath(path.resolve(target));
    const res = priorReadGuard({
      toolName: 'writeFile',
      params: { file_path: target },
      _fileReadHashes: new Map([[key, { hash: 'x', mtime: 1, size: 5 }]]),
    });
    expect(res.action).toBe('allow');
  });

  test('apply_patch is always allowed (multi-file)', () => {
    const target = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(target, 'hello');
    const res = priorReadGuard({
      toolName: 'apply_patch',
      params: { file_path: target },
      _fileReadHashes: new Map(),
    });
    expect(res.action).toBe('allow');
  });

  test('no file_path → allow', () => {
    expect(priorReadGuard({ toolName: 'writeFile', params: {} }).action).toBe('allow');
  });
});

describe('_readTracker.normalizePath — shared, platform-aware', () => {
  test('is exported as a function', () => {
    expect(typeof readTracker.normalizePath).toBe('function');
  });

  test('is idempotent', () => {
    const p = path.resolve(os.tmpdir(), 'a', 'b.txt');
    expect(readTracker.normalizePath(readTracker.normalizePath(p))).toBe(readTracker.normalizePath(p));
  });

  test('read recorded one way is found via the normalizer (key parity)', () => {
    const p = path.resolve(os.tmpdir(), 'parity.txt');
    readTracker.markRead(p);
    expect(readTracker.hasRead(p)).toBe(true);
    // hasRead resolves through the same normalizer the guard uses.
    expect(readTracker.hasRead(readTracker.normalizePath(p))).toBe(true);
  });
});
