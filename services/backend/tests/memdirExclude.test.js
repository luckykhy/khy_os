'use strict';

/**
 * memdir exclude param — additive & byte-compatible (node:test).
 * Asserts loadRelevantMemories(q) === loadRelevantMemories(q, {exclude:∅})
 * (byte-identical default) and that a non-empty exclude removes that file.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../src/memdir/paths');
const memdir = require('../src/memdir/memdir');

function withScratch(fn) {
  const prev = process.env.KHY_MEMORY_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-excl-'));
  process.env.KHY_MEMORY_DIR = tmp;
  paths._resetCache();
  try { return fn(tmp); } finally {
    if (prev === undefined) delete process.env.KHY_MEMORY_DIR; else process.env.KHY_MEMORY_DIR = prev;
    paths._resetCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('默认 exclude 空 ⇒ 与不传 exclude 字节一致', () => {
  withScratch(() => {
    memdir.saveMemory('project', 'gateway config', '网关 apikey url 配置。', {});
    memdir.saveMemory('feedback', 'notes', '一些 gateway 反馈。', {});
    const a = memdir.loadRelevantMemories('gateway apikey');
    const b = memdir.loadRelevantMemories('gateway apikey', {});
    const c = memdir.loadRelevantMemories('gateway apikey', { exclude: new Set() });
    assert.strictEqual(a, b);
    assert.strictEqual(a, c);
    assert.ok(a && a.length > 0);
  });
});

test('exclude 命中 ⇒ 该文件从块中移除', () => {
  withScratch(() => {
    const { filename } = memdir.saveMemory('project', 'gateway config', '网关 apikey url 配置。', {});
    const full = memdir.loadRelevantMemories('gateway apikey');
    assert.ok(full.includes(filename), 'baseline contains the file');
    const excluded = memdir.loadRelevantMemories('gateway apikey', { exclude: new Set([filename]) });
    assert.ok(excluded === null || !excluded.includes(filename), 'excluded file gone');
  });
});

test('selectRelevantMemories 也支持 exclude', () => {
  withScratch(() => {
    const { filename } = memdir.saveMemory('project', 'gateway config', '网关 apikey。', {});
    const sel = memdir.selectRelevantMemories('gateway apikey', { exclude: new Set([filename]) });
    assert.ok(!sel.some((s) => s.filename === filename));
  });
});
