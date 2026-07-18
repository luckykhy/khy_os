'use strict';

/**
 * btwNote.test.js — 纯叶子 `/btw` 文本逻辑契约(node:test,零 IO)。
 *
 * 锁定:normalizeNote(trim / 非串 / 空 / 截断)、mergeHints(SSOT 拼接格式 = 历史 repl.js 逐字节、
 * 无提示原样、过滤空提示)、门控梯(默认开 / falsy 关 / undefined env)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeNote,
  mergeHints,
  isEnabled,
  _HINT_HEADER,
  _MAX_NOTE_LEN,
} = require('../../../src/services/conversation/btwNote');

describe('normalizeNote', () => {
  test('去首尾空白', () => {
    assert.equal(normalizeNote('  改用 deepseek  '), '改用 deepseek');
  });
  test('非串 / 空 → 空串', () => {
    assert.equal(normalizeNote(null), '');
    assert.equal(normalizeNote(undefined), '');
    assert.equal(normalizeNote(''), '');
    assert.equal(normalizeNote('   '), '');
  });
  test('数字 / 对象被字符串化后 trim', () => {
    assert.equal(normalizeNote(42), '42');
  });
  test('超长截断到 _MAX_NOTE_LEN', () => {
    const long = 'x'.repeat(_MAX_NOTE_LEN + 50);
    assert.equal(normalizeNote(long).length, _MAX_NOTE_LEN);
  });
});

describe('mergeHints', () => {
  test('无提示 → 原样返回 input(逐字节不变)', () => {
    assert.equal(mergeHints('本回合输入', []), '本回合输入');
    assert.equal(mergeHints('本回合输入', null), '本回合输入');
    assert.equal(mergeHints('本回合输入', undefined), '本回合输入');
  });
  test('SSOT 拼接格式 = 历史 repl.js 逐字节', () => {
    const out = mergeHints('帮我重构', ['先跑测试', '注意 windows 路径']);
    assert.equal(out, `帮我重构\n\n${_HINT_HEADER}\n先跑测试\n注意 windows 路径`);
  });
  test('与历史实现等价:splice(0).join + 模板', () => {
    const input = 'A';
    const hints = ['h1', 'h2'];
    const legacy = `${input}\n\n[附加提示]\n${hints.join('\n')}`;
    assert.equal(mergeHints(input, hints), legacy);
  });
  test('过滤空 / 空白提示', () => {
    assert.equal(mergeHints('X', ['', '  ', 'real']), `X\n\n${_HINT_HEADER}\nreal`);
  });
  test('全是空提示 → 原样返回 input', () => {
    assert.equal(mergeHints('X', ['', '   ']), 'X');
  });
  test('input 为空也安全', () => {
    assert.equal(mergeHints('', ['h']), `\n\n${_HINT_HEADER}\nh`);
    assert.equal(mergeHints(null, ['h']), `\n\n${_HINT_HEADER}\nh`);
  });
});

describe('门控 isEnabled', () => {
  test('默认 → 开', () => {
    assert.equal(isEnabled({}), true);
    assert.equal(isEnabled(undefined), true);
    assert.equal(isEnabled({ KHY_BTW: 'true' }), true);
  });
  test('falsy → 关', () => {
    for (const v of ['0', 'false', 'off', 'no', '']) {
      assert.equal(isEnabled({ KHY_BTW: v }), false);
    }
  });
});
