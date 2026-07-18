'use strict';

/**
 * memoryEngine.buildSessionPrimingSection — session-start / topic-switch priming
 * block (node:test). Asserts gate-off no-op, block header, limit/chars, and that
 * `exclude` removes already-surfaced memories. Deterministic scratch dir.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../../../src/memdir/paths');
const memdir = require('../../../src/memdir/memdir');
const engine = require('../../../src/services/memoryEngine');

function withScratch(fn) {
  const prev = process.env.KHY_MEMORY_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-primeblk-'));
  process.env.KHY_MEMORY_DIR = tmp;
  paths._resetCache();
  try { return fn(tmp); } finally {
    if (prev === undefined) delete process.env.KHY_MEMORY_DIR; else process.env.KHY_MEMORY_DIR = prev;
    paths._resetCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('门控 KHY_MEMORY_SESSION_PRIME=off → {text:null, filenames:[]}', () => {
  withScratch(() => {
    const now = Date.now();
    memdir.saveMemory('user', 'a', 'b', { updated: new Date(now).toISOString() });
    const r = engine.buildSessionPrimingSection({ nowMs: now, env: { KHY_MEMORY_SESSION_PRIME: 'off' } });
    assert.deepStrictEqual(r, { text: null, filenames: [] });
  });
});

test('开 + 非空 → [SESSION_PRIMING] 块 + filenames', () => {
  withScratch(() => {
    const now = Date.now();
    memdir.saveMemory('user', 'who', '你是资深工程师', { updated: new Date(now).toISOString() });
    memdir.saveMemory('project', 'proj', '多子系统批量', { updated: new Date(now).toISOString() });
    const r = engine.buildSessionPrimingSection({ nowMs: now, env: {} });
    assert.ok(r.text && r.text.includes('[SESSION_PRIMING]'), 'has block header');
    assert.ok(r.filenames.length >= 1, 'reports surfaced filenames');
  });
});

test('limit 限制条数', () => {
  withScratch(() => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) memdir.saveMemory('project', `p${i}`, `body ${i}`, { updated: new Date(now).toISOString() });
    const r = engine.buildSessionPrimingSection({ nowMs: now, limit: 2, env: {} });
    assert.strictEqual(r.filenames.length, 2);
  });
});

test('exclude 剔除已浮现的记忆', () => {
  withScratch(() => {
    const now = Date.now();
    const { filename: f1 } = memdir.saveMemory('user', 'who', '你是资深工程师', { updated: new Date(now).toISOString() });
    memdir.saveMemory('project', 'proj', '多子系统批量', { updated: new Date(now).toISOString() });
    const r = engine.buildSessionPrimingSection({ nowMs: now, exclude: new Set([f1]), env: {} });
    assert.ok(!r.filenames.includes(f1), 'excluded filename absent');
  });
});
