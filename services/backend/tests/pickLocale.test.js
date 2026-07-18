'use strict';

/**
 * pickLocale.test.js — 锁 utils/pickLocale 口径
 *   (收敛 4 处「含 CJK→zh 否则 en」语言判定 helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const pickLocale = require('../src/utils/pickLocale');

test('含 CJK 汉字 → zh', () => {
  assert.strictEqual(pickLocale('你好'), 'zh');
  assert.strictEqual(pickLocale('hello 世界'), 'zh'); // 混排含汉字即 zh
  assert.strictEqual(pickLocale('模型'), 'zh');
});

test('纯 ASCII / 无汉字 → en', () => {
  assert.strictEqual(pickLocale('hello world'), 'en');
  assert.strictEqual(pickLocale('GLM-4V'), 'en');
  assert.strictEqual(pickLocale('123 !@#'), 'en');
});

test('falsy → en(空文本默认英文)', () => {
  assert.strictEqual(pickLocale(''), 'en');
  assert.strictEqual(pickLocale(null), 'en');
  assert.strictEqual(pickLocale(undefined), 'en');
});

test('逐输入等价原体 /[一-鿿]/.test(String(text||\'\')) ? zh : en', () => {
  const ref = (text) => /[一-鿿]/.test(String(text || '')) ? 'zh' : 'en';
  for (const s of ['你好', 'abc', '混 mix', '', null, 42, '模型识别']) {
    assert.strictEqual(pickLocale(s), ref(s));
  }
});
