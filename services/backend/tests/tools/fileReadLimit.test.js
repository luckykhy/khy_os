'use strict';

// Unit tests for the file-read-limit pure leaf.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const frl = require('../../src/tools/fileReadLimit');

const ON = {}; // 默认开
const OFF = { KHY_FILE_READ_LIMIT: '0' };

// ── 门控梯 ──────────────────────────────────────────────────────────────────
test('isEnabled: 默认开', () => {
  assert.equal(frl.isEnabled(ON), true);
  assert.equal(frl.isEnabled(undefined), true);
});

test('isEnabled: 0/false/off/no → 关', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(frl.isEnabled({ KHY_FILE_READ_LIMIT: v }), false, `value ${v}`);
  }
});

// ── resolveMaxBytes ────────────────────────────────────────────────────────
test('resolveMaxBytes: 门控开 → 2MB 默认', () => {
  assert.equal(frl.resolveMaxBytes(ON, 500 * 1024), frl.DEFAULT_MAX_BYTES);
});

test('resolveMaxBytes: 门控开 + env 覆盖', () => {
  assert.equal(frl.resolveMaxBytes({ KHY_FILE_READ_MAX_BYTES: '1048576' }, 500 * 1024), 1048576);
});

test('resolveMaxBytes: 门控关 → 回退 call-site legacy', () => {
  assert.equal(frl.resolveMaxBytes(OFF, 500 * 1024), 500 * 1024);
  assert.equal(frl.resolveMaxBytes(OFF, 123456), 123456);
});

test('resolveMaxBytes: legacy 缺省/非法 → 内置 500KB', () => {
  assert.equal(frl.resolveMaxBytes(OFF), frl.LEGACY_MAX_BYTES);
  assert.equal(frl.resolveMaxBytes(OFF, -1), frl.LEGACY_MAX_BYTES);
  assert.equal(frl.resolveMaxBytes(OFF, NaN), frl.LEGACY_MAX_BYTES);
});

test('resolveMaxBytes: 门控开但 env 覆盖非法 → 2MB 默认', () => {
  assert.equal(frl.resolveMaxBytes({ KHY_FILE_READ_MAX_BYTES: 'abc' }, 500 * 1024), frl.DEFAULT_MAX_BYTES);
  assert.equal(frl.resolveMaxBytes({ KHY_FILE_READ_MAX_BYTES: '0' }, 500 * 1024), frl.DEFAULT_MAX_BYTES);
});

// ── resolveMaxLines ────────────────────────────────────────────────────────
test('resolveMaxLines: 门控开 → 5000 默认;env 覆盖;门控关 → legacy', () => {
  assert.equal(frl.resolveMaxLines(ON, 2000), frl.DEFAULT_MAX_LINES);
  assert.equal(frl.resolveMaxLines({ KHY_FILE_READ_MAX_LINES: '8000' }, 2000), 8000);
  assert.equal(frl.resolveMaxLines(OFF, 2000), 2000);
  assert.equal(frl.resolveMaxLines(OFF, 999), 999);
});

// ── partialOnOversizeEnabled ───────────────────────────────────────────────
test('partialOnOversizeEnabled: 跟随门控', () => {
  assert.equal(frl.partialOnOversizeEnabled(ON), true);
  assert.equal(frl.partialOnOversizeEnabled(OFF), false);
});

// ── buildOversizeNotice ────────────────────────────────────────────────────
test('buildOversizeNotice: 含总字节、上限与续读路径', () => {
  const s = frl.buildOversizeNotice({ totalBytes: 3000000, maxBytes: 2097152 });
  assert.match(s, /3000000 字节/);
  assert.match(s, /2097152 字节/);
  assert.match(s, /offset\/limit/);
  assert.match(s, /KHY_FILE_READ_MAX_BYTES/);
});

test('buildOversizeNotice: 防呆缺参不抛', () => {
  const s = frl.buildOversizeNotice({});
  assert.match(s, /较大/);
  assert.ok(typeof s === 'string' && s.length > 0);
});
