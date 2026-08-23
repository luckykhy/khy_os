'use strict';

/**
 * 审计流水的轮转/归档/封顶 + 运行时体积自检。
 *
 * 这两块的共同要求是「过了保留期先打包压缩，超了上限才删，而且绝不碰会话历史」。
 * 所以每条断言都盯着一个具体的破坏方式：归档写失败时会不会照删（不许）、活跃分片
 * 会不会被总量封顶顺手删掉（不许）、体积自检会不会自己动手删（不许）。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const cleanupService = require('../../src/services/cleanupService');

const DAY = 86400000;

function ageFile(filePath, days) {
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(filePath, t, t);
}

function seedSession(dir, name, lines, ageDays) {
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  if (ageDays) {
    ageFile(fp, ageDays);
  }
  return fp;
}

function readArchive(archiveDir) {
  return fs
    .readdirSync(archiveDir)
    .filter((n) => n.endsWith('.gz'))
    .map((n) => ({
      name: n,
      lines: zlib
        .gunzipSync(fs.readFileSync(path.join(archiveDir, n)))
        .toString('utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    }));
}

/** 换一个环境变量重载模块，跑完恢复原值——策略对象是 frozen 的，只能这么试。 */
function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  jest.resetModules();
  try {
    return fn(require('../../src/services/cleanupService'));
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    jest.resetModules();
  }
}

describe('cleanupService.cleanTraceAudit — 归档与封顶', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-audit-rot-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('过期分片折成一份 gz，原件才被删，且能溯源到原文件名', () => {
    const sessions = path.join(root, 'sessions');
    seedSession(sessions, 'old-a.jsonl', [{ ev: 'a1' }, { ev: 'a2' }], 30);
    seedSession(sessions, 'old-b.jsonl', [{ ev: 'b1' }], 30);
    seedSession(sessions, 'fresh.jsonl', [{ ev: 'now' }], 0);

    const result = cleanupService.cleanTraceAudit(root);

    expect(result.archived).toBe(2);
    expect(result.removed).toBe(2);
    expect(fs.existsSync(path.join(sessions, 'old-a.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(sessions, 'old-b.jsonl'))).toBe(false);
    // 保留期内的分片一个字节都不能动
    expect(fs.existsSync(path.join(sessions, 'fresh.jsonl'))).toBe(true);

    const archives = readArchive(path.join(root, 'archive'));
    expect(archives).toHaveLength(1);
    expect(archives[0].lines).toHaveLength(3);
    expect(archives[0].lines.map((l) => l._source).sort()).toEqual([
      'old-a.jsonl',
      'old-a.jsonl',
      'old-b.jsonl',
    ]);
    expect(archives[0].lines.map((l) => l.ev).sort()).toEqual(['a1', 'a2', 'b1']);
  });

  test('归档比原始分片小：2483 个小文件那笔账主要在文件数', () => {
    const sessions = path.join(root, 'sessions');
    let raw = 0;
    for (let i = 0; i < 40; i++) {
      const fp = seedSession(sessions, `s${i}.jsonl`, [{ ev: 'x'.repeat(200), i }], 30);
      raw += fs.statSync(fp).size;
    }

    cleanupService.cleanTraceAudit(root);

    const archiveDir = path.join(root, 'archive');
    const names = fs.readdirSync(archiveDir);
    expect(names).toHaveLength(1);
    expect(fs.statSync(path.join(archiveDir, names[0])).size).toBeLessThan(raw);
    expect(fs.readdirSync(sessions)).toHaveLength(0);
  });

  test('坏行也进归档（包成 _raw），不静默丢弃', () => {
    const sessions = path.join(root, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const fp = path.join(sessions, 'mixed.jsonl');
    fs.writeFileSync(fp, '{"ev":"ok"}\nthis is not json\n', 'utf-8');
    ageFile(fp, 30);

    cleanupService.cleanTraceAudit(root);

    const lines = readArchive(path.join(root, 'archive'))[0].lines;
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l._raw)).toEqual({
      _source: 'mixed.jsonl',
      _raw: 'this is not json',
    });
  });

  test('归档写不出去（archive 位置被普通文件占位）时不删原件', () => {
    const sessions = path.join(root, 'sessions');
    seedSession(sessions, 'old.jsonl', [{ ev: 'keep-me' }], 30);
    fs.writeFileSync(path.join(root, 'archive'), 'blocker', 'utf-8');

    const result = cleanupService.cleanTraceAudit(root);

    expect(result.archived).toBe(0);
    expect(result.removed).toBe(0);
    expect(fs.existsSync(path.join(sessions, 'old.jsonl'))).toBe(true);
  });

  test('KHY_AUDIT_ARCHIVE=0 退回旧行为：直接删，不留归档', () => {
    withEnv({ KHY_AUDIT_ARCHIVE: '0' }, (svc) => {
      const sessions = path.join(root, 'sessions');
      seedSession(sessions, 'old.jsonl', [{ ev: 'gone' }], 30);

      const result = svc.cleanTraceAudit(root);

      expect(result.archived).toBe(0);
      expect(result.removed).toBe(1);
      expect(fs.existsSync(path.join(sessions, 'old.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'archive'))).toBe(false);
    });
  });

  test('KHY_AUDIT_KEEP_DAYS 可配：保留期拉长后同一批分片不再过期', () => {
    withEnv({ KHY_AUDIT_KEEP_DAYS: '90' }, (svc) => {
      const sessions = path.join(root, 'sessions');
      seedSession(sessions, 'thirty-days.jsonl', [{ ev: 'x' }], 30);

      const result = svc.cleanTraceAudit(root);

      expect(result.removed).toBe(0);
      expect(fs.existsSync(path.join(sessions, 'thirty-days.jsonl'))).toBe(true);
    });
  });

  test('总量超上限时从最旧的归档开始删，活跃分片一个不碰', () => {
    withEnv({ KHY_AUDIT_MAX_TOTAL_MB: '1' }, (svc) => {
      const archiveDir = path.join(root, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      // 随机字节压不动，才能真的越过 1 MB 上限
      const blob = crypto.randomBytes(700 * 1024);
      for (const [name, ageDays] of [
        ['sessions-2020-01-01.jsonl.gz', 30],
        ['sessions-2026-01-01.jsonl.gz', 1],
      ]) {
        const fp = path.join(archiveDir, name);
        fs.writeFileSync(fp, blob);
        ageFile(fp, ageDays);
      }
      const sessions = path.join(root, 'sessions');
      seedSession(sessions, 'live.jsonl', [{ ev: 'live' }], 0);

      const result = svc.cleanTraceAudit(root);

      expect(result.removed).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(path.join(archiveDir, 'sessions-2020-01-01.jsonl.gz'))).toBe(false);
      expect(fs.existsSync(path.join(archiveDir, 'sessions-2026-01-01.jsonl.gz'))).toBe(true);
      expect(fs.existsSync(path.join(sessions, 'live.jsonl'))).toBe(true);
    });
  });

  test('过期分片全是空文件时照删：没有证据需要保全，不能让空文件永远赖着', () => {
    const sessions = path.join(root, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    for (const name of ['empty-a.jsonl', 'empty-b.jsonl']) {
      const fp = path.join(sessions, name);
      fs.writeFileSync(fp, '', 'utf-8');
      ageFile(fp, 30);
    }

    const result = cleanupService.cleanTraceAudit(root);

    // wrote=false（没内容可压）但 ok=true（可以删），两者是不同含义。
    expect(result.archived).toBe(0);
    expect(result.removed).toBe(2);
    expect(fs.readdirSync(sessions)).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'archive'))).toBe(false);
  });

  test('空目录是静默 no-op，不建 archive/', () => {
    const result = cleanupService.cleanTraceAudit(root);
    expect(result.removed).toBe(0);
    expect(result.archived).toBe(0);
    expect(fs.existsSync(path.join(root, 'archive'))).toBe(false);
  });
});

describe('cleanupService.assessRuntimeFootprint — 只报不删', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-footprint-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seedDir(name, bytes) {
    const d = path.join(root, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'blob.bin'), Buffer.alloc(bytes, 1));
  }

  test('低于阈值：不出提示', () => {
    seedDir('logs', 1024);
    const f = cleanupService.assessRuntimeFootprint(root);
    expect(f.overThreshold).toBe(false);
    expect(f.notice).toBeNull();
    expect(f.totalBytes).toBeGreaterThan(0);
  });

  test('超阈值：提示点名 khy clean --runtime，且不是「处理中…」式的空话', () => {
    withEnv({ KHY_FOOTPRINT_NOTICE_MB: '1' }, (svc) => {
      seedDir('logs', 2 * 1024 * 1024);
      const f = svc.assessRuntimeFootprint(root);

      expect(f.overThreshold).toBe(true);
      expect(f.notice).toContain('khy clean --runtime');
      expect(f.notice).toContain(root);
      expect(f.notice).not.toMatch(/正在工作|处理中|Loading/i);
    });
  });

  test('自检不删任何东西：调用前后文件清单相同', () => {
    seedDir('logs', 4096);
    seedDir('checkpoints', 4096);
    seedDir('sessions', 4096);
    const before = fs.readdirSync(root).sort();

    cleanupService.assessRuntimeFootprint(root);

    expect(fs.readdirSync(root).sort()).toEqual(before);
    expect(fs.existsSync(path.join(root, 'checkpoints', 'blob.bin'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'sessions', 'blob.bin'))).toBe(true);
  });

  test('可回收数字只算 khy clean --runtime 的白名单，会话历史与工作区快照不计入', () => {
    seedDir('logs', 4096);
    seedDir('audit', 4096);
    seedDir('checkpoints', 1024 * 1024);
    seedDir('sessions', 1024 * 1024);

    const f = cleanupService.assessRuntimeFootprint(root);

    expect(f.reclaimableBytes).toBeLessThan(f.totalBytes);
    expect(f.reclaimableBytes).toBeLessThan(64 * 1024);
    expect(f.breakdown.map((b) => b.rel).sort()).toEqual([
      'audit',
      'checkpoints',
      'logs',
      'sessions',
    ]);
  });

  test('KHY_FOOTPRINT_NOTICE=0 关掉提示（体积照算）', () => {
    withEnv({ KHY_FOOTPRINT_NOTICE: '0', KHY_FOOTPRINT_NOTICE_MB: '1' }, (svc) => {
      seedDir('logs', 2 * 1024 * 1024);
      const f = svc.assessRuntimeFootprint(root);
      expect(f.overThreshold).toBe(false);
      expect(f.notice).toBeNull();
      expect(f.totalBytes).toBeGreaterThan(1024 * 1024);
    });
  });
});
