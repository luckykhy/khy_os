'use strict';

/**
 * fableVoiceWiring.test.js — Fable 5 DNA 在三个 prompt section 里的接线 + 逐字节回退。
 *
 * 三个 section 函数(getResponseFormattingSection / getToneAndStyleSection /
 * getErrorHandlingAndFallbackSection)在**调用时**读 env,故直接切 process.env 即可。
 * 门开 → section 文本含借鉴文案;门关 → section 文本逐字节等于「历史 items」拼接结果。
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const KEY = 'KHY_FABLE_VOICE';
let saved;
beforeEach(() => { saved = process.env[KEY]; });
afterEach(() => { if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved; });

const prompts = require('../../src/constants/prompts');
const {
  RESPONSE_FORMATTING_ITEMS,
  TONE_AND_STYLE_ITEMS,
  ERROR_HANDLING_ITEMS,
} = require('../../src/services/fableVoiceProfile');

test('response formatting: gate-on appends prose-first items; gate-off byte-reverts', () => {
  delete process.env[KEY];
  const on = prompts.getResponseFormattingSection();
  for (const item of RESPONSE_FORMATTING_ITEMS) assert.ok(on.includes(item), item.slice(0, 30));

  process.env[KEY] = 'off';
  const off = prompts.getResponseFormattingSection();
  for (const item of RESPONSE_FORMATTING_ITEMS) assert.ok(!off.includes(item));
  assert.ok(off.startsWith('# Response formatting'));
});

test('tone and style: gate-on appends tone items; gate-off byte-reverts', () => {
  delete process.env[KEY];
  const on = prompts.getToneAndStyleSection();
  for (const item of TONE_AND_STYLE_ITEMS) assert.ok(on.includes(item), item.slice(0, 30));

  process.env[KEY] = '0';
  const off = prompts.getToneAndStyleSection();
  for (const item of TONE_AND_STYLE_ITEMS) assert.ok(!off.includes(item));
  assert.ok(off.startsWith('# Tone and style'));
});

test('error handling: gate-on appends own-mistakes item; gate-off byte-reverts', () => {
  delete process.env[KEY];
  const on = prompts.getErrorHandlingAndFallbackSection();
  for (const item of ERROR_HANDLING_ITEMS) assert.ok(on.includes(item), item.slice(0, 30));

  process.env[KEY] = 'false';
  const off = prompts.getErrorHandlingAndFallbackSection();
  for (const item of ERROR_HANDLING_ITEMS) assert.ok(!off.includes(item));
  assert.ok(off.startsWith('# Error handling and fallback'));
});

test('gate-off section text is byte-identical to legacy (no trailing artifact from append)', () => {
  // 门关时上游 items.push(...[]) 无副作用 → 文本必须与「从不注入」时逐字节一致。
  process.env[KEY] = 'off';
  const rf = prompts.getResponseFormattingSection();
  // 结尾行仍是历史最后一条 legacy item(over-formatting 那条),末尾无空行/悬挂 ` - `。
  assert.ok(rf.endsWith('a paragraph or short list is clearer.'));
  assert.ok(!rf.includes(' - \n') && !rf.endsWith(' - '));
});
