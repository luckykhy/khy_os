'use strict';

/**
 * Unit tests for readFileFormatRouter.js — the async DI orchestrator that lets
 * tools/readFile.js route detected non-plain-text formats to the existing bounded
 * extractors (PDF / image OCR / archive / docx) instead of refusing them
 * (run via `node --test`).
 *
 * 全部用 DI 桩注入提取器,不真跑 python/pdftotext/tar,故确定性、无外部依赖。
 * 覆盖:
 *   - 门控 formatRouteEnabled:默认开;env ∈ {0,false,off,no} 归一后关。
 *   - 各分支成功路径(image/pdf/docx/archive)渲染正确的 provenance 头 + 内容。
 *   - 提取器 success:false → handled:false(落 OPS-121 拒绝兜底)。
 *   - 提取器抛错 → handled:false(绝不抛)。
 *   - 门控 off → handled:false(逐字节回退)。
 *   - unsupported 格式(elf/xlsx/无提取器)→ handled:false。
 *   - 畸形入参不抛。
 *   - _looksArchivePath 纯路径判断。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const R = require('../../src/tools/readFileFormatRouter');

// ── 门控 ────────────────────────────────────────────────────────────────────
test('门控默认开(未设 env)', () => {
  assert.strictEqual(R.formatRouteEnabled({}), true);
  assert.strictEqual(R.formatRouteEnabled({ KHY_READFILE_FORMAT_ROUTE: undefined }), true);
});

test('门控 env ∈ {0,false,off,no}(含大小写/空白)→ 关', () => {
  for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'False', 'No']) {
    assert.strictEqual(R.formatRouteEnabled({ KHY_READFILE_FORMAT_ROUTE: v }), false, `env='${v}' 应关`);
  }
});

test('门控其它值 → 开', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
    assert.strictEqual(R.formatRouteEnabled({ KHY_READFILE_FORMAT_ROUTE: v }), true, `env='${v}' 应开`);
  }
});

// ── 门控 off → 立即 handled:false ────────────────────────────────────────────
test('门控 off → handled:false(不调用任何提取器)', async () => {
  let called = false;
  const deps = { extractImageOcr: () => { called = true; return { success: true, text: 'x' }; } };
  const out = await R.routeFormatRead({
    filePath: '/tmp/a.png', fmt: { category: 'image', mime: 'image/png' }, size: 100,
    env: { KHY_READFILE_FORMAT_ROUTE: '0' }, deps,
  });
  assert.strictEqual(out.handled, false);
  assert.strictEqual(called, false);
});

// ── 图片 → OCR ───────────────────────────────────────────────────────────────
test('image 分支:OCR 成功 → handled + 【图片 OCR】头', async () => {
  const deps = { extractImageOcr: async () => ({ success: true, engine: 'tesseract', text: 'hello world' }) };
  const out = await R.routeFormatRead({
    filePath: '/tmp/a.png', fmt: { category: 'image', mime: 'image/png' }, size: 200, env: {}, deps,
  });
  assert.strictEqual(out.handled, true);
  assert.strictEqual(out.result.success, true);
  assert.match(out.result.content, /【图片 OCR · tesseract】/);
  assert.match(out.result.content, /hello world/);
  assert.strictEqual(out.result.format, 'image');
  assert.strictEqual(out.result.extractedBy, 'tesseract');
  assert.strictEqual(out.result.size, 200);
});

test('image 分支:OCR 空文本 → handled:false', async () => {
  const deps = { extractImageOcr: async () => ({ success: true, engine: 'tesseract', text: '   ' }) };
  const out = await R.routeFormatRead({
    filePath: '/tmp/a.png', fmt: { category: 'image' }, size: 1, env: {}, deps,
  });
  assert.strictEqual(out.handled, false);
});

test('image 分支:OCR success:false → handled:false', async () => {
  const deps = { extractImageOcr: async () => ({ success: false, error: 'no tesseract' }) };
  const out = await R.routeFormatRead({
    filePath: '/tmp/a.png', fmt: { category: 'image' }, size: 1, env: {}, deps,
  });
  assert.strictEqual(out.handled, false);
});

// ── PDF → 文本 ───────────────────────────────────────────────────────────────
test('pdf 分支:提取成功 → handled + 【PDF 文本】头带页数', async () => {
  const deps = { extractPdf: async () => ({ success: true, engine: 'pdftotext', text: 'PDF BODY', pageCount: 10, pagesUsed: 3 }) };
  const out = await R.routeFormatRead({
    filePath: '/tmp/a.pdf', fmt: { magicFormat: 'pdf', category: 'document', mime: 'application/pdf' }, size: 5000, env: {}, deps,
  });
  assert.strictEqual(out.handled, true);
  assert.match(out.result.content, /【PDF 文本 · pdftotext · 取3\/共10页】/);
  assert.match(out.result.content, /PDF BODY/);
  assert.strictEqual(out.result.format, 'pdf');
});

test('pdf 分支:无页数信息也能渲染', async () => {
  const deps = { extractPdf: async () => ({ success: true, engine: 'strings', text: 'x' }) };
  const out = await R.routeFormatRead({
    filePath: '/tmp/a.pdf', fmt: { format: 'pdf' }, size: 1, env: {}, deps,
  });
  assert.strictEqual(out.handled, true);
  assert.match(out.result.content, /【PDF 文本 · strings】/);
});

// ── docx → 文本 ──────────────────────────────────────────────────────────────
test('docx 分支:提取成功 → handled + 【DOCX 文本】头', async () => {
  const deps = { extractDocx: async () => ({ success: true, engine: 'python-docx', text: 'DOCX BODY' }) };
  const out = await R.routeFormatRead({
    filePath: '/tmp/a.docx', fmt: { magicFormat: 'docx', category: 'document' }, size: 3000, env: {}, deps,
  });
  assert.strictEqual(out.handled, true);
  assert.match(out.result.content, /【DOCX 文本 · python-docx】/);
  assert.match(out.result.content, /DOCX BODY/);
  assert.strictEqual(out.result.format, 'docx');
});

// ── 压缩包 → 清单 + peek ─────────────────────────────────────────────────────
test('archive 分支(category=archive):清单渲染 → handled', async () => {
  const deps = {
    inspectArchive: async () => ({ success: true, kindToken: 'zip', entries: [{ name: 'a.txt' }], totalEntries: 1, peeks: [] }),
    buildArchiveManifest: () => '[Archive Contents] pkg (1 entry)\n- a.txt',
  };
  const out = await R.routeFormatRead({
    filePath: '/tmp/pkg.zip', fmt: { category: 'archive', magicFormat: 'zip' }, size: 4000, env: {}, deps,
  });
  assert.strictEqual(out.handled, true);
  assert.match(out.result.content, /\[Archive Contents\]/);
  assert.strictEqual(out.result.format, 'archive');
  assert.strictEqual(out.result.extractedBy, 'zip');
});

test('archive 分支(tar.gz 靠路径,category=unknown)→ handled', async () => {
  const deps = {
    inspectArchive: async () => ({ success: true, kindToken: 'tar', entries: [{ name: 'bin/x' }], totalEntries: 1, peeks: [] }),
    buildArchiveManifest: () => '[Archive Contents] moonbit.tar.gz\n- bin/x',
  };
  const out = await R.routeFormatRead({
    filePath: '/tmp/moonbit-linux-x86_64.tar.gz', fmt: { category: 'unknown', magicFormat: null }, size: 9000, env: {}, deps,
  });
  assert.strictEqual(out.handled, true);
  assert.match(out.result.content, /moonbit\.tar\.gz/);
});

test('archive 分支:inspectArchive success:false → handled:false', async () => {
  const deps = { inspectArchive: async () => ({ success: false, skipped: true }) };
  const out = await R.routeFormatRead({
    filePath: '/tmp/pkg.zip', fmt: { category: 'archive' }, size: 1, env: {}, deps,
  });
  assert.strictEqual(out.handled, false);
});

test('archive 分支:manifest 空串 → handled:false', async () => {
  const deps = {
    inspectArchive: async () => ({ success: true, kindToken: 'zip', entries: [], totalEntries: 0 }),
    buildArchiveManifest: () => '',
  };
  const out = await R.routeFormatRead({
    filePath: '/tmp/pkg.zip', fmt: { category: 'archive' }, size: 1, env: {}, deps,
  });
  assert.strictEqual(out.handled, false);
});

// ── 无提取器 / 抛错 / 畸形 ───────────────────────────────────────────────────
test('unsupported 格式(elf)→ handled:false', async () => {
  const out = await R.routeFormatRead({
    filePath: '/tmp/a.out', fmt: { format: 'elf', category: 'binary' }, size: 1, env: {}, deps: {},
  });
  assert.strictEqual(out.handled, false);
});

test('unsupported 格式(xlsx,无文本提取器)→ handled:false', async () => {
  const out = await R.routeFormatRead({
    filePath: '/tmp/a.xlsx', fmt: { magicFormat: 'xlsx', category: 'data' }, size: 1, env: {}, deps: {},
  });
  assert.strictEqual(out.handled, false);
});

test('提取器抛错 → handled:false(绝不抛)', async () => {
  const deps = { extractImageOcr: async () => { throw new Error('boom'); } };
  let out;
  await assert.doesNotReject(async () => {
    out = await R.routeFormatRead({ filePath: '/tmp/a.png', fmt: { category: 'image' }, size: 1, env: {}, deps });
  });
  assert.strictEqual(out.handled, false);
});

test('畸形入参(fmt 缺失/非对象/无 filePath)→ handled:false,不抛', async () => {
  for (const args of [
    undefined,
    {},
    { filePath: '/tmp/a', fmt: null, env: {} },
    { filePath: '/tmp/a', fmt: 'x', env: {} },
    { fmt: { category: 'image' }, env: {} }, // 无 filePath
  ]) {
    let out;
    await assert.doesNotReject(async () => { out = await R.routeFormatRead(args); });
    assert.strictEqual(out.handled, false);
  }
});

// ── 纯件 ─────────────────────────────────────────────────────────────────────
test('_looksArchivePath:识别 .zip/.tar/.tar.gz/.tgz,其它 false', () => {
  for (const p of ['/x/a.zip', '/x/a.tar', '/x/a.tar.gz', '/x/a.tgz', '/X/A.TAR.GZ']) {
    assert.strictEqual(R._looksArchivePath(p), true, `${p} 应识别为压缩包`);
  }
  for (const p of ['/x/a.txt', '/x/a.png', '/x/a.gz.txt', '', null, undefined]) {
    assert.strictEqual(R._looksArchivePath(p), false, `${p} 不应识别为压缩包`);
  }
});

test('渲染器对 null/非成功输入返回 null(不抛)', () => {
  assert.strictEqual(R._renderImageOcr(null, 1), null);
  assert.strictEqual(R._renderPdf({ success: false }, 1), null);
  assert.strictEqual(R._renderDocx({ success: true, text: '' }, 1), null);
  assert.strictEqual(R._renderArchive('', {}, 1), null);
});
