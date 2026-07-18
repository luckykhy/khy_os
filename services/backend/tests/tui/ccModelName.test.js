'use strict';

/**
 * ccModelName 纯叶子单测(node:test)。
 *
 * 验证「模型身份显示名派生」的单一真源:模型 slug → CC 同款友好名("Opus 4.8"),
 * 未命中 → 裸 slug 原样(忠实对齐 CC 源 utils/model/model.ts renderModelName 的
 * null→raw 兜底)。门控 KHY_MODEL_DISPLAY_NAME 关 → 逐字节回退裸 slug。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatModelLabel, modelDisplayNameEnabled } = require('../../src/cli/ccModelName');

const ON = {}; // 空 env → 门控默认开
const OFF = { KHY_MODEL_DISPLAY_NAME: '0' };

test('new-convention Claude slugs → friendly family + version', () => {
  assert.equal(formatModelLabel('claude-opus-4-8', ON), 'Opus 4.8');
  assert.equal(formatModelLabel('claude-sonnet-4-6', ON), 'Sonnet 4.6');
  assert.equal(formatModelLabel('claude-haiku-4-5', ON), 'Haiku 4.5');
  // dot separator for minor also parses
  assert.equal(formatModelLabel('claude-haiku-3.5', ON), 'Haiku 3.5');
});

test('trailing suffixes (-latest / -date) are ignored', () => {
  assert.equal(formatModelLabel('claude-haiku-4-5-latest', ON), 'Haiku 4.5');
  assert.equal(formatModelLabel('claude-haiku-4-5-20251001', ON), 'Haiku 4.5');
});

test('regression: major-then-8-digit-date (no explicit minor) → major only, NOT date-as-minor', () => {
  // Real canonical Anthropic ids: `claude-<family>-<major>-<date>` with no minor.
  // The date suffix must NOT be captured as the minor version.
  assert.equal(formatModelLabel('claude-opus-4-20250514', ON), 'Opus 4');
  assert.equal(formatModelLabel('claude-sonnet-4-20250514', ON), 'Sonnet 4');
  // With an explicit minor before the date, the minor is still honored.
  assert.equal(formatModelLabel('claude-opus-4-1-20250805', ON), 'Opus 4.1');
  assert.equal(formatModelLabel('claude-sonnet-4-5-20250929', ON), 'Sonnet 4.5');
  // Two-digit minor is preserved (not truncated).
  assert.equal(formatModelLabel('claude-opus-4-10', ON), 'Opus 4.10');
});

test('major-only slug → no minor', () => {
  assert.equal(formatModelLabel('claude-opus-4', ON), 'Opus 4');
});

test('legacy convention (version before family) → friendly', () => {
  assert.equal(formatModelLabel('claude-3-5-sonnet-20241022', ON), 'Sonnet 3.5');
  assert.equal(formatModelLabel('claude-3-opus-20240229', ON), 'Opus 3');
});

test('non-Claude / unknown / auto / empty → raw verbatim (CC null→raw parity)', () => {
  assert.equal(formatModelLabel('agnes-2.0-flash', ON), 'agnes-2.0-flash');
  assert.equal(formatModelLabel('gpt-5-codex', ON), 'gpt-5-codex');
  assert.equal(formatModelLabel('auto', ON), 'auto');
  assert.equal(formatModelLabel('', ON), '');
  assert.equal(formatModelLabel(null, ON), '');
  assert.equal(formatModelLabel(undefined, ON), '');
});

test('gate off → raw slug byte-identical', () => {
  assert.equal(formatModelLabel('claude-opus-4-8', OFF), 'claude-opus-4-8');
  assert.equal(formatModelLabel('claude-sonnet-4-6', OFF), 'claude-sonnet-4-6');
  assert.equal(formatModelLabel('agnes-2.0-flash', OFF), 'agnes-2.0-flash');
  // empty still empty regardless of gate
  assert.equal(formatModelLabel('', OFF), '');
});

test('gate predicate honors off-spellings, defaults on', () => {
  assert.equal(modelDisplayNameEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.equal(modelDisplayNameEnabled({ KHY_MODEL_DISPLAY_NAME: v }), false);
  }
  assert.equal(modelDisplayNameEnabled({ KHY_MODEL_DISPLAY_NAME: '1' }), true);
});

test('whitespace around slug is trimmed', () => {
  assert.equal(formatModelLabel('  claude-opus-4-8  ', ON), 'Opus 4.8');
});
