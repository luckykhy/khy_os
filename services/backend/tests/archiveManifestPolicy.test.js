'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  isEnabled,
  archiveStrategyForPath,
  isArchivePath,
  mimeForArchive,
  isArchiveMime,
  isTextLikeEntry,
  selectPeekEntries,
  buildArchiveManifest,
} = require('../src/services/archiveManifestPolicy');

// ── 门控 ──────────────────────────────────────────────────────────────────────
test('isEnabled 默认开', () => {
  assert.strictEqual(isEnabled({}), true);
});

test('isEnabled 仅 falsy 关', () => {
  for (const v of ['0', 'false', 'off', 'no', ' OFF ']) {
    assert.strictEqual(isEnabled({ KHY_ARCHIVE_INSPECT: v }), false, v);
  }
  for (const v of ['1', 'true', 'on', 'whatever']) {
    assert.strictEqual(isEnabled({ KHY_ARCHIVE_INSPECT: v }), true, v);
  }
});

// ── archiveStrategyForPath ────────────────────────────────────────────────────
test('strategy: zip / tar 家族 / unsupported / 非归档', () => {
  assert.strictEqual(archiveStrategyForPath('a/b/demo.zip', {}), 'zip');
  assert.strictEqual(archiveStrategyForPath('x.tar', {}), 'tar');
  assert.strictEqual(archiveStrategyForPath('x.tar.gz', {}), 'tar');
  assert.strictEqual(archiveStrategyForPath('x.tgz', {}), 'tar');
  assert.strictEqual(archiveStrategyForPath('x.7z', {}), 'unsupported');
  assert.strictEqual(archiveStrategyForPath('x.rar', {}), 'unsupported');
  assert.strictEqual(archiveStrategyForPath('x.tar.bz2', {}), 'unsupported');
  assert.strictEqual(archiveStrategyForPath('x.gz', {}), 'unsupported');
  assert.strictEqual(archiveStrategyForPath('note.txt', {}), '');
  assert.strictEqual(archiveStrategyForPath('photo.png', {}), '');
});

test('复合扩展名 .tar.gz 必须先于 .gz 判定为 tar(可列)而非 unsupported', () => {
  assert.strictEqual(archiveStrategyForPath('release.tar.gz', {}), 'tar');
});

test('门控关 → strategy 恒空字符串(字节回退:压缩包不被识别)', () => {
  const off = { KHY_ARCHIVE_INSPECT: 'off' };
  assert.strictEqual(archiveStrategyForPath('demo.zip', off), '');
  assert.strictEqual(isArchivePath('demo.zip', off), false);
});

test('isArchivePath:可列与 unsupported 都算压缩包,普通文件不算', () => {
  assert.strictEqual(isArchivePath('a.zip', {}), true);
  assert.strictEqual(isArchivePath('a.7z', {}), true);
  assert.strictEqual(isArchivePath('a.txt', {}), false);
});

// ── mimeForArchive / isArchiveMime ────────────────────────────────────────────
test('mimeForArchive 归一', () => {
  assert.strictEqual(mimeForArchive('a.zip', {}), 'application/zip');
  assert.strictEqual(mimeForArchive('a.tar', {}), 'application/x-tar');
  assert.strictEqual(mimeForArchive('a.tar.gz', {}), 'application/gzip');
  assert.strictEqual(mimeForArchive('a.7z', {}), 'application/x-7z-compressed');
  assert.strictEqual(mimeForArchive('a.rar', {}), 'application/vnd.rar');
  assert.strictEqual(mimeForArchive('a.txt', {}), '');
  assert.strictEqual(mimeForArchive('a.zip', { KHY_ARCHIVE_INSPECT: 'off' }), '');
});

test('isArchiveMime 认常见归档 mime;门控关恒 false', () => {
  assert.strictEqual(isArchiveMime('application/zip', {}), true);
  assert.strictEqual(isArchiveMime('application/x-zip-compressed', {}), true);
  assert.strictEqual(isArchiveMime('application/x-7z-compressed', {}), true);
  assert.strictEqual(isArchiveMime('text/plain', {}), false);
  assert.strictEqual(isArchiveMime('application/zip', { KHY_ARCHIVE_INSPECT: '0' }), false);
});

// ── isTextLikeEntry / selectPeekEntries ───────────────────────────────────────
test('isTextLikeEntry 认文本/代码扩展名', () => {
  for (const n of ['a/README.md', 'src/app.js', 'config.yaml', 'data.csv', 'main.py']) {
    assert.strictEqual(isTextLikeEntry(n), true, n);
  }
  for (const n of ['blob.bin', 'img.png', 'a.exe', 'noext']) {
    assert.strictEqual(isTextLikeEntry(n), false, n);
  }
});

test('selectPeekEntries:文本类 + 尺寸内 + 上限 + 跳过目录/二进制', () => {
  const entries = [
    { name: 'dir/', size: 0, isDirectory: true },
    { name: 'README.md', size: 100 },
    { name: 'blob.bin', size: 100 },        // 非文本 → 跳过
    { name: 'big.txt', size: 999999 },      // 超 maxBytes → 跳过
    { name: 'a.js', size: 50 },
    { name: 'b.json', size: 50 },
    { name: 'c.yaml', size: 50 },
  ];
  const picked = selectPeekEntries(entries, { maxPeek: 2, maxBytes: 1000 });
  assert.deepStrictEqual(picked.map(p => p.name), ['README.md', 'a.js']);
});

test('selectPeekEntries:maxPeek=0 → []', () => {
  assert.deepStrictEqual(selectPeekEntries([{ name: 'a.txt', size: 10 }], { maxPeek: 0, maxBytes: 100 }), []);
});

test('selectPeekEntries:非数组/异常 → [](不抛)', () => {
  assert.deepStrictEqual(selectPeekEntries(null, {}), []);
  assert.deepStrictEqual(selectPeekEntries(undefined, {}), []);
});

// ── buildArchiveManifest ──────────────────────────────────────────────────────
test('buildArchiveManifest:列条目 + 总数 + 窥探块', () => {
  const out = buildArchiveManifest({
    env: {},
    name: 'demo.zip',
    mimeType: 'application/zip',
    entries: [{ name: 'README.md', size: 24 }, { name: 'src/app.js', size: 30 }],
    totalEntries: 2,
    peeks: [{ name: 'README.md', text: 'hello' }],
  });
  assert.ok(out.includes('[Archive Contents] demo.zip (application/zip, 2 entries)'));
  // 门控 KHY_CC_FORMAT 默认开 → 字节大小走 CC `formatFileSize` 同口径(<1KB → "N bytes")。
  assert.ok(out.includes('- README.md (24 bytes)'));
  assert.ok(out.includes('- src/app.js (30 bytes)'));
  assert.ok(out.includes('[Archive Entry] README.md'));
  assert.ok(out.includes('hello'));
  assert.ok(/绝不.*臆测/.test(out));
});

test('buildArchiveManifest:salience 关 → 逐字节回退旧「前 N 原序 + 还有 N 个文件」(load-bearing)', () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({ name: `f${i}.txt`, size: 1 }));
  const out = buildArchiveManifest({
    // KHY_FILE_SALIENCE:'off' → 逐字节回退到旧的原序 slice 逻辑(截断 5 条 + 「还有 45」)。
    env: { KHY_ARCHIVE_MANIFEST_MAX_ENTRIES: '5', KHY_FILE_SALIENCE: 'off' },
    name: 'big.zip', mimeType: 'application/zip', entries, totalEntries: 50,
  });
  assert.ok(out.includes('- f0.txt'), '原序第一条');
  assert.ok(out.includes('还有 45 个文件'));
});

test('buildArchiveManifest:salience 开(默认)→ manifest 含关键文件 / 分组摘要块', () => {
  // 50 条:README/package.json/入口应被 pinned 顶上来,而非埋在原序 slice 里。
  const entries = [
    { name: 'README.md', size: 1200 },
    { name: 'package.json', size: 800 },
    { name: 'src/index.js', size: 400 },
  ];
  for (let i = 0; i < 47; i += 1) entries.push({ name: `src/mod/f${i}.js`, size: 100 + i });

  const out = buildArchiveManifest({
    env: {},   // salience 默认开
    name: 'proj.zip', mimeType: 'application/zip', entries, totalEntries: entries.length,
  });
  assert.ok(out.includes('关键文件'), 'salience 开 → 含关键文件段');
  assert.ok(out.includes('README.md'), 'README 被突出');
  assert.ok(out.includes('package.json'), 'manifest 被突出');
  // 分组摘要段(目录 / 类型分布)。
  assert.ok(out.includes('目录分布') || out.includes('类型分布'), '含分组摘要');
  // 头部与既有诚实提示不回归。
  assert.ok(out.includes('[Archive Contents] proj.zip'));
  assert.ok(/绝不.*臆测/.test(out));
});

test('buildArchiveManifest:无条目 + error → 诚实「已识别但无法列出 + 给方案」', () => {
  const out = buildArchiveManifest({
    env: {},
    name: 'x.7z', mimeType: 'application/x-7z-compressed',
    entries: [], error: '该压缩格式暂不支持列出内容',
  });
  assert.ok(out.includes('[Archive Contents] x.7z'));
  assert.ok(out.includes('已识别这是一个压缩包'));
  assert.ok(out.includes('该压缩格式暂不支持列出内容'));
  assert.ok(/请勿臆测/.test(out));
});

test('buildArchiveManifest:门控关 → 空字符串(字节回退)', () => {
  const out = buildArchiveManifest({
    env: { KHY_ARCHIVE_INSPECT: 'off' },
    name: 'demo.zip', mimeType: 'application/zip',
    entries: [{ name: 'a.txt', size: 1 }], totalEntries: 1,
  });
  assert.strictEqual(out, '');
});

test('buildArchiveManifest:全空入参 → 不抛', () => {
  assert.doesNotThrow(() => buildArchiveManifest());
  assert.doesNotThrow(() => buildArchiveManifest({ env: {} }));
});
