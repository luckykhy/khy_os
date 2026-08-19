'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const cleanupService = require('../../src/services/cleanupService');

describe('cleanupService.cleanRuntimeLogs', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-runtime-logs-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('archives rotated logs and keeps today active', () => {
    const active = path.join(root, 'active');
    fs.mkdirSync(active, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(active, 'app-2020-01-01.log'), 'rotated payload');
    fs.writeFileSync(path.join(active, `app-${today}.log`), 'live payload');

    const result = cleanupService.cleanRuntimeLogs(root);

    expect(result.archived).toBe(1);
    expect(fs.existsSync(path.join(active, 'app-2020-01-01.log'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'archive', 'app-2020-01-01.log.gz'))).toBe(true);
    expect(fs.existsSync(path.join(active, `app-${today}.log`))).toBe(true);
  });

  test('removes empty gzip artifacts without touching current logs', () => {
    const active = path.join(root, 'active');
    fs.mkdirSync(active, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(active, 'error-2020-01-01.log.gz'), '');
    fs.writeFileSync(path.join(active, `error-${today}.log`), 'live payload');

    const result = cleanupService.cleanRuntimeLogs(root);

    expect(result.removed).toBe(1);
    expect(fs.existsSync(path.join(active, 'error-2020-01-01.log.gz'))).toBe(false);
    expect(fs.existsSync(path.join(active, `error-${today}.log`))).toBe(true);
  });

  test('caps archive files oldest first', () => {
    const archive = path.join(root, 'archive');
    fs.mkdirSync(archive, { recursive: true });
    const oldest = path.join(archive, 'app-2020-01-01.log.gz');
    const newest = path.join(archive, 'app-2020-01-02.log.gz');
    fs.writeFileSync(oldest, 'old');
    fs.writeFileSync(newest, 'new');
    fs.utimesSync(oldest, 1, 1);

    const result = cleanupService.cleanRuntimeLogs(root, {
      KEEP_DAYS: 99999,
      MAX_FILES: 1,
      MAX_SIZE_BYTES: 1048576,
    });
    expect(result.removed).toBe(1);

    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(newest)).toBe(true);
  });

  test('reclaims payload-free gzip archives that a size-zero check misses', () => {
    const archive = path.join(root, 'archive');
    fs.mkdirSync(archive, { recursive: true });
    // 10-byte truncated gzip header: what a half-finished compress leaves behind.
    const truncated = path.join(archive, 'app-2020-01-01.log.gz.dup-1');
    fs.writeFileSync(truncated, Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 11]));
    // gzip-of-empty is a valid 20-byte member that still carries no log lines.
    const emptyMember = path.join(archive, 'app-2020-01-02.log.gz');
    fs.writeFileSync(emptyMember, require('zlib').gzipSync(Buffer.alloc(0)));
    const real = path.join(archive, 'app-2020-01-03.log.gz');
    fs.writeFileSync(real, require('zlib').gzipSync(Buffer.from('a real log line\n')));

    const result = cleanupService.cleanRuntimeLogs(root, {
      KEEP_DAYS: 0,
      MAX_FILES: 100,
      MAX_SIZE_BYTES: 100 * 1024 * 1024,
    });

    expect(result.removed).toBe(2);
    expect(fs.existsSync(truncated)).toBe(false);
    expect(fs.existsSync(emptyMember)).toBe(false);
    expect(fs.existsSync(real)).toBe(true);
  });

  test('a payload-free source never mints a .dup-N beside a real archive', () => {
    const active = path.join(root, 'active');
    const archive = path.join(root, 'archive');
    fs.mkdirSync(active, { recursive: true });
    fs.mkdirSync(archive, { recursive: true });
    const existing = path.join(archive, 'app-2020-01-01.log.gz');
    fs.writeFileSync(existing, require('zlib').gzipSync(Buffer.from('kept payload\n')));
    const before = fs.readFileSync(existing);
    // Same rotated name arriving from the legacy root, but with nothing in it.
    fs.writeFileSync(path.join(root, 'app-2020-01-01.log.gz'), Buffer.alloc(0));

    cleanupService.cleanRuntimeLogs(root, {
      KEEP_DAYS: 0,
      MAX_FILES: 100,
      MAX_SIZE_BYTES: 100 * 1024 * 1024,
    });

    expect(fs.readdirSync(archive).filter((n) => n.includes('.dup-'))).toEqual([]);
    expect(fs.readFileSync(existing)).toEqual(before);
  });
});
