'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  isEnabled,
  shouldForceFirstToolCall,
  buildInlineImageNote,
} = require('../src/services/gateway/visionDirectTurnPolicy');

// ── isEnabled ───────────────────────────────────────────────────────────────
test('isEnabled 默认开', () => {
  assert.strictEqual(isEnabled({}), true);
});

test('isEnabled 仅 falsy 关', () => {
  for (const v of ['0', 'false', 'off', 'no', ' OFF ']) {
    assert.strictEqual(isEnabled({ KHY_VISION_DIRECT_DESCRIBE: v }), false, v);
  }
  for (const v of ['1', 'true', 'on', 'whatever']) {
    assert.strictEqual(isEnabled({ KHY_VISION_DIRECT_DESCRIBE: v }), true, v);
  }
});

// ── shouldForceFirstToolCall ────────────────────────────────────────────────
test('门控开 + 第一轮 + 无图 → 强制(legacy 编码任务保留)', () => {
  assert.strictEqual(shouldForceFirstToolCall({ iteration: 0, hasImage: false, env: {} }), true);
});

test('门控开 + 第一轮 + 带图 → 不强制(纯描述可直接出文本)', () => {
  assert.strictEqual(shouldForceFirstToolCall({ iteration: 0, hasImage: true, env: {} }), false);
});

test('门控开 + 非第一轮 → 一律不强制', () => {
  assert.strictEqual(shouldForceFirstToolCall({ iteration: 1, hasImage: false, env: {} }), false);
  assert.strictEqual(shouldForceFirstToolCall({ iteration: 3, hasImage: true, env: {} }), false);
});

test('门控关 → 字节回退 legacy(仅第一轮强制,与是否带图无关)', () => {
  const off = { KHY_VISION_DIRECT_DESCRIBE: 'off' };
  assert.strictEqual(shouldForceFirstToolCall({ iteration: 0, hasImage: true, env: off }), true);
  assert.strictEqual(shouldForceFirstToolCall({ iteration: 0, hasImage: false, env: off }), true);
  assert.strictEqual(shouldForceFirstToolCall({ iteration: 1, hasImage: true, env: off }), false);
});

test('iteration 非数字 → 不视为第一轮(不抛)', () => {
  assert.strictEqual(shouldForceFirstToolCall({ iteration: undefined, hasImage: false, env: {} }), false);
  assert.strictEqual(shouldForceFirstToolCall({}), false);
});

// ── buildInlineImageNote ────────────────────────────────────────────────────
test('门控开 + count>0 → 含「内联/不要 Read」指引', () => {
  const note = buildInlineImageNote({ count: 1, env: {} });
  assert.ok(note && note.includes('内联'));
  assert.ok(note.includes('一张图片'));
  assert.ok(/不要用 Read/.test(note));
});

test('多张图片 → 复数措辞', () => {
  const note = buildInlineImageNote({ count: 3, env: {} });
  assert.ok(note.includes('3 张图片'));
});

test('门控关 → null(字节回退,不注入)', () => {
  assert.strictEqual(buildInlineImageNote({ count: 2, env: { KHY_VISION_DIRECT_DESCRIBE: '0' } }), null);
});

test('count<=0 / 非数字 → null(不抛)', () => {
  assert.strictEqual(buildInlineImageNote({ count: 0, env: {} }), null);
  assert.strictEqual(buildInlineImageNote({ count: -1, env: {} }), null);
  assert.strictEqual(buildInlineImageNote({ count: NaN, env: {} }), null);
  assert.strictEqual(buildInlineImageNote({ env: {} }), null);
});
