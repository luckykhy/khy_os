'use strict';

/**
 * fableVoiceProfile.test.js — Fable 5 行为 DNA 注入的纯叶子门控与逐字节回退。
 *
 * 锁死:
 *   - 门开(default)→ 三块 items 各返回借鉴文案(散文优先 / 语气 / 认错不自贬);
 *   - 门关(0/false/off/no,大小写/空白不敏感)→ 三块各返回 [](上游 section 逐字节回退);
 *   - 返回新副本(caller mutation 隔离);绝不抛(junk env / null)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  fableVoiceEnabled,
  responseFormattingItems,
  toneAndStyleItems,
  errorHandlingItems,
  RESPONSE_FORMATTING_ITEMS,
  TONE_AND_STYLE_ITEMS,
  ERROR_HANDLING_ITEMS,
} = require('../../src/services/fableVoiceProfile');

test('gate default-on → all three blocks carry their borrowed items', () => {
  assert.strictEqual(fableVoiceEnabled({}), true);
  assert.strictEqual(fableVoiceEnabled({ KHY_FABLE_VOICE: '1' }), true);
  assert.deepStrictEqual(responseFormattingItems({}), RESPONSE_FORMATTING_ITEMS);
  assert.deepStrictEqual(toneAndStyleItems({}), TONE_AND_STYLE_ITEMS);
  assert.deepStrictEqual(errorHandlingItems({}), ERROR_HANDLING_ITEMS);
});

test('gate off (0/false/off/no, case/space-insensitive) → all three return [] (byte-revert)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
    assert.strictEqual(fableVoiceEnabled({ KHY_FABLE_VOICE: v }), false, v);
    assert.deepStrictEqual(responseFormattingItems({ KHY_FABLE_VOICE: v }), [], v);
    assert.deepStrictEqual(toneAndStyleItems({ KHY_FABLE_VOICE: v }), [], v);
    assert.deepStrictEqual(errorHandlingItems({ KHY_FABLE_VOICE: v }), [], v);
  }
});

test('borrowed items are non-empty and prose-shaped (no leading bullet marker)', () => {
  for (const block of [RESPONSE_FORMATTING_ITEMS, TONE_AND_STYLE_ITEMS, ERROR_HANDLING_ITEMS]) {
    assert.ok(block.length >= 1);
    for (const item of block) {
      assert.ok(typeof item === 'string' && item.length > 0);
      assert.ok(!/^\s*[-*]/.test(item), 'items must not carry their own bullet marker');
    }
  }
});

test('items() return fresh copies (caller mutation is isolated)', () => {
  const a = responseFormattingItems({});
  a.push('mutant');
  assert.ok(!responseFormattingItems({}).includes('mutant'));
  assert.notStrictEqual(a, RESPONSE_FORMATTING_ITEMS);
});

test('never throws on junk env', () => {
  assert.doesNotThrow(() => fableVoiceEnabled(null));
  assert.doesNotThrow(() => responseFormattingItems(null));
  assert.doesNotThrow(() => toneAndStyleItems(undefined));
  assert.doesNotThrow(() => errorHandlingItems({ KHY_FABLE_VOICE: {} }));
});
