'use strict';

/**
 * analyzeBinaryTool.test.js — revived binaryAnalyzer as an auto-registered tool.
 *
 * Verifies the defineTool wrapper shape + execute() behavior against real
 * binaries synthesized in a temp dir (a minimal ELF header), plus fail-soft
 * paths. The underlying parsing is covered by binaryAnalyzer's own suite; here
 * we only assert the tool surface: schema, read-only flags, and dispatch.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tool = require('../src/tools/analyzeBinary');

// ── tool definition shape ───────────────────────────────────────────

test('analyzeBinary is a read-only, concurrency-safe tool', () => {
  assert.equal(tool.name, 'analyzeBinary');
  // defineTool normalizes these into predicate functions.
  assert.equal(tool.isReadOnly(), true);
  assert.equal(tool.isConcurrencySafe(), true);
  assert.equal(typeof tool.execute, 'function');
  assert.ok(tool.inputSchema && tool.inputSchema.filePath);
  assert.equal(tool.inputSchema.filePath.required, true);
});

test('getActivityDescription describes analyze and compare', () => {
  assert.match(tool.getActivityDescription({ filePath: '/bin/x' }), /分析二进制/);
  assert.match(tool.getActivityDescription({ action: 'compare', filePath: '/a', filePathB: '/b' }), /对比二进制/);
});

// ── execute: validation fail-soft ───────────────────────────────────

test('execute requires filePath', async () => {
  const res = await tool.execute({});
  assert.equal(res.success, false);
  assert.match(res.error, /filePath/);
});

test('execute compare requires filePathB', async () => {
  const res = await tool.execute({ action: 'compare', filePath: '/tmp/whatever' });
  assert.equal(res.success, false);
  assert.match(res.error, /filePathB/);
});

test('execute on a missing file fails soft (no throw)', async () => {
  const res = await tool.execute({ filePath: '/no/such/khy-binary-xyz' });
  assert.equal(res.success, false);
  assert.equal(typeof res.error, 'string');
});

// ── execute: real (synthetic) ELF ───────────────────────────────────

test('execute analyzes a minimal ELF header', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-elf-'));
  const file = path.join(dir, 'tiny.elf');
  // Minimal 64-byte ELF header: magic + class(64) + data(LE) + machine x86-64.
  const buf = Buffer.alloc(64);
  buf.write('\x7fELF', 0, 'binary');
  buf[4] = 2; // EI_CLASS = ELFCLASS64
  buf[5] = 1; // EI_DATA = little-endian
  buf[16] = 2; // e_type = ET_EXEC
  buf.writeUInt16LE(0x3e, 18); // e_machine = EM_X86_64
  fs.writeFileSync(file, buf);
  try {
    const res = await tool.execute({ filePath: file });
    assert.equal(res.success, true);
    assert.equal(res.action, 'analyze');
    assert.equal(res.result.format, 'ELF');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
