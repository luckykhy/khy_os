'use strict';

/**
 * footerMemory — pins the pure-leaf decision for the footer "process memory
 * (RSS) · pid" segment (aligns with CC's useRssDisplay in
 * PromptInputFooterLeftSide.tsx: `{formatFileSize(rss)} · pid:{pid}` with
 * level = mb>=1024?'error':mb>=512?'warning':'normal').
 *
 * The threshold→severity band is the "logic behind the display" being pinned.
 * Gate KHY_FOOTER_MEMORY default on; gate off / bad input → null (no segment).
 */

const { test } = require('node:test');
const assert = require('node:assert');

const fm = require('../src/cli/tui/footerMemory');

const MB = 1024 * 1024;

test('isFooterMemoryEnabled: default on, {0,false,off,no} off', () => {
  assert.strictEqual(fm.isFooterMemoryEnabled({}), true);
  assert.strictEqual(fm.isFooterMemoryEnabled({ KHY_FOOTER_MEMORY: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(fm.isFooterMemoryEnabled({ KHY_FOOTER_MEMORY: v }), false, `expected off for ${v}`);
  }
});

test('resolveMemoryLevel: CC threshold bands (512MB warning, 1GB error)', () => {
  assert.strictEqual(fm.resolveMemoryLevel(142 * MB), 'normal');
  assert.strictEqual(fm.resolveMemoryLevel(511 * MB), 'normal');
  assert.strictEqual(fm.resolveMemoryLevel(512 * MB), 'warning'); // >= 512MB
  assert.strictEqual(fm.resolveMemoryLevel(900 * MB), 'warning');
  assert.strictEqual(fm.resolveMemoryLevel(1024 * MB), 'error'); // >= 1GB
  assert.strictEqual(fm.resolveMemoryLevel(2048 * MB), 'error');
});

test('resolveMemoryLevel: non-finite → normal (fail-soft)', () => {
  assert.strictEqual(fm.resolveMemoryLevel(NaN), 'normal');
  assert.strictEqual(fm.resolveMemoryLevel(undefined), 'normal');
});

test('buildFooterMemory: normal band → text with size · pid, level normal', () => {
  const seg = fm.buildFooterMemory({ rssBytes: 142 * MB, pid: 12345 }, {});
  assert.ok(seg);
  assert.strictEqual(seg.level, 'normal');
  assert.match(seg.text, /^142MB · pid:12345$/);
});

test('buildFooterMemory: warning + error bands carry the right level', () => {
  assert.strictEqual(fm.buildFooterMemory({ rssBytes: 600 * MB, pid: 1 }, {}).level, 'warning');
  assert.strictEqual(fm.buildFooterMemory({ rssBytes: 1300 * MB, pid: 1 }, {}).level, 'error');
});

test('buildFooterMemory: pid omitted/invalid → size only, no pid segment', () => {
  const seg = fm.buildFooterMemory({ rssBytes: 142 * MB }, {});
  assert.ok(seg);
  assert.doesNotMatch(seg.text, /pid:/);
  assert.match(seg.text, /^142MB$/);
});

test('buildFooterMemory: gate off → null (no segment, byte-identical legacy footer)', () => {
  assert.strictEqual(fm.buildFooterMemory({ rssBytes: 142 * MB, pid: 1 }, { KHY_FOOTER_MEMORY: 'off' }), null);
});

test('buildFooterMemory: non-positive/garbage rss → null (fail-soft)', () => {
  assert.strictEqual(fm.buildFooterMemory({ rssBytes: 0, pid: 1 }, {}), null);
  assert.strictEqual(fm.buildFooterMemory({ rssBytes: -5, pid: 1 }, {}), null);
  assert.strictEqual(fm.buildFooterMemory({ rssBytes: NaN, pid: 1 }, {}), null);
  assert.doesNotThrow(() => fm.buildFooterMemory());
  assert.strictEqual(fm.buildFooterMemory(), null);
});

test('thresholds exported match CC (512MB / 1GB)', () => {
  assert.strictEqual(fm.WARNING_BYTES, 512 * MB);
  assert.strictEqual(fm.ERROR_BYTES, 1024 * MB);
});
