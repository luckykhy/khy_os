'use strict';

/**
 * maskSecret.test.js — 锁 utils/maskSecret 口径
 *   (收敛 4 处密钥脱敏 helper 的护栏·含「绝不露全串」安全断言)。
 */

const test = require('node:test');
const assert = require('node:assert');

const maskSecret = require('../src/utils/maskSecret');

test('falsy / 空 → 空串', () => {
  assert.strictEqual(maskSecret(''), '');
  assert.strictEqual(maskSecret(null), '');
  assert.strictEqual(maskSecret(undefined), '');
  assert.strictEqual(maskSecret('   '), '');
});

test('len<=8 → 前2****', () => {
  assert.strictEqual(maskSecret('ab'), 'ab****');
  assert.strictEqual(maskSecret('12345678'), '12****');
});

test('len>8 → 前4...后2', () => {
  assert.strictEqual(maskSecret('sk-abcdef1234'), 'sk-a...34');
  assert.strictEqual(maskSecret('123456789'), '1234...89');
});

test('安全:绝不返回完整密钥', () => {
  const secret = 'sk-verysecretkey-9999';
  const masked = maskSecret(secret);
  assert.notStrictEqual(masked, secret);
  assert.ok(masked.includes('...'));
});

test('逐输入等价原体', () => {
  const ref = (value) => {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.length <= 8) return `${text.slice(0, 2)}****`;
    return `${text.slice(0, 4)}...${text.slice(-2)}`;
  };
  for (const s of ['', null, undefined, 'ab', '12345678', 'sk-abcdef1234', '  spaced-key-1234  ', 42]) {
    assert.strictEqual(maskSecret(s), ref(s));
  }
});
