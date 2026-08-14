'use strict';

/**
 * pastedRefLines 纯叶子单测(node:test)。
 *
 * 验证 CC 源 `src/history.ts::getPastedTextRefNumLines`(数换行符、CRLF/CR/LF 归一、
 * "+2 not 3" 增量语义)**逐分支移植正确**,以及 `pastedRefLineCountOr` 的门控梯
 * (门控开 → CC 换行数;门控关 → call-site 传入的 legacy 逐字节回退)。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isEnabled,
  countPastedRefLines,
  pastedRefLineCountOr,
} = require('../../src/cli/pastedRefLines');

const ON = {};
const OFF = { KHY_PASTED_REF_LINES: 'off' };

test('isEnabled: 默认开 / 关梯', () => {
  assert.equal(isEnabled({}), true);
  assert.equal(isEnabled({ KHY_PASTED_REF_LINES: '' }), true);
  assert.equal(isEnabled({ KHY_PASTED_REF_LINES: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.equal(isEnabled({ KHY_PASTED_REF_LINES: off }), false, off);
  }
});

test('countPastedRefLines: CC "+2 not 3"(数换行符 = 行数 − 1,无尾随换行)', () => {
  assert.equal(countPastedRefLines('line1\nline2\nline3'), 2); // CC 注释逐字例:3 行 → +2
  assert.equal(countPastedRefLines('单行无换行'), 0);          // 0 换行 → CC 走裸 [Pasted text]
  assert.equal(countPastedRefLines('a\nb'), 1);
  assert.equal(countPastedRefLines('a\nb\nc\nd'), 3);
});

test('countPastedRefLines: CRLF / 裸 CR 各归一计一次', () => {
  assert.equal(countPastedRefLines('a\r\nb\r\nc'), 2); // CRLF:split("\n") 会多计且残留 \r,CC 正确为 2
  assert.equal(countPastedRefLines('a\rb\rc'), 2);     // 老式 Mac 裸 CR:split("\n") 当 1 行,CC 正确为 2
  assert.equal(countPastedRefLines('a\r\nb\rc\nd'), 3); // 混合 CRLF/CR/LF
});

test('countPastedRefLines: 尾随换行也计入(与 CC 一致)', () => {
  assert.equal(countPastedRefLines('a\nb\n'), 2); // CC 不特判尾随换行:数到 2 个 \n
  assert.equal(countPastedRefLines('\n'), 1);
});

test('countPastedRefLines: 防呆(null/undefined/非串/空 → 0,绝不抛)', () => {
  assert.equal(countPastedRefLines(null), 0);
  assert.equal(countPastedRefLines(undefined), 0);
  assert.equal(countPastedRefLines(''), 0);
  assert.equal(countPastedRefLines(12345), 0); // "12345" 无换行
  assert.doesNotThrow(() => countPastedRefLines());
});

test('pastedRefLineCountOr: 门控开 → CC 换行数(忽略 legacy)', () => {
  assert.equal(pastedRefLineCountOr('line1\nline2\nline3', 3, ON), 2); // legacy split=3,CC=2
  assert.equal(pastedRefLineCountOr('a\r\nb\r\nc', 3, ON), 2);          // CRLF legacy split=3,CC=2
  assert.equal(pastedRefLineCountOr('单行', 1, ON), 0);                  // legacy split=1,CC=0
});

test('pastedRefLineCountOr: 门控关 → 原样返回 call-site legacy(逐字节回退,绝不串味)', () => {
  assert.equal(pastedRefLineCountOr('line1\nline2\nline3', 3, OFF), 3);
  assert.equal(pastedRefLineCountOr('a\r\nb\r\nc', 3, OFF), 3);
  assert.equal(pastedRefLineCountOr('单行', 1, OFF), 1);
  assert.equal(pastedRefLineCountOr('', 0, OFF), 0); // busyInputClassifiers 空体 legacy=0
});

test('pastedRefLineCountOr: 门控开关唯一分歧 = 计数口径(同一 3 行文本 2 vs 3)', () => {
  const t = 'x\ny\nz';
  assert.equal(pastedRefLineCountOr(t, t.split('\n').length, ON), 2);
  assert.equal(pastedRefLineCountOr(t, t.split('\n').length, OFF), 3);
});

test('pastedRefLineCountOr: 默认门控(无 env)= 开', () => {
  const prev = process.env.KHY_PASTED_REF_LINES;
  delete process.env.KHY_PASTED_REF_LINES;
  try {
    assert.equal(pastedRefLineCountOr('a\nb\nc', 3), 2);
  } finally {
    if (prev == null) delete process.env.KHY_PASTED_REF_LINES;
    else process.env.KHY_PASTED_REF_LINES = prev;
  }
});
