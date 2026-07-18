'use strict';

/**
 * normalizeCompatibility.test.js — 锁 utils/normalizeCompatibility 口径
 *   (收敛 3 处上游兼容协议标签归一化 helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const normalizeCompatibility = require('../src/utils/normalizeCompatibility');

test('空 / falsy → openai(默认)', () => {
  assert.strictEqual(normalizeCompatibility(''), 'openai');
  assert.strictEqual(normalizeCompatibility(null), 'openai');
  assert.strictEqual(normalizeCompatibility(undefined), 'openai');
  assert.strictEqual(normalizeCompatibility('   '), 'openai');
});

test('openai 族 → openai', () => {
  assert.strictEqual(normalizeCompatibility('openai'), 'openai');
  assert.strictEqual(normalizeCompatibility('OpenAI-Compatible'), 'openai');
  assert.strictEqual(normalizeCompatibility('openai_compatible'), 'openai');
});

test('anthropic 族 → anthropic', () => {
  assert.strictEqual(normalizeCompatibility('anthropic'), 'anthropic');
  assert.strictEqual(normalizeCompatibility('Anthropic-Compatible'), 'anthropic');
  assert.strictEqual(normalizeCompatibility('anthropic_compatible'), 'anthropic');
});

test('unknown/auto/detect → unknown', () => {
  assert.strictEqual(normalizeCompatibility('unknown'), 'unknown');
  assert.strictEqual(normalizeCompatibility('auto'), 'unknown');
  assert.strictEqual(normalizeCompatibility('DETECT'), 'unknown');
});

test('无法识别 → 空串(供回退)', () => {
  assert.strictEqual(normalizeCompatibility('gemini'), '');
  assert.strictEqual(normalizeCompatibility('xyz'), '');
});

test('逐输入等价原体', () => {
  const ref = (raw = '') => {
    const value = String(raw || '').trim().toLowerCase();
    if (!value) return 'openai';
    if (value === 'openai' || value === 'openai-compatible' || value === 'openai_compatible') return 'openai';
    if (value === 'anthropic' || value === 'anthropic-compatible' || value === 'anthropic_compatible') return 'anthropic';
    if (value === 'unknown' || value === 'auto' || value === 'detect') return 'unknown';
    return '';
  };
  for (const s of ['', null, undefined, 'openai', 'OPENAI_COMPATIBLE', 'anthropic', 'auto', 'gemini', '  detect  ', 42]) {
    assert.strictEqual(normalizeCompatibility(s), ref(s));
  }
});
