'use strict';

/**
 * maskToken.test.js — 锁 utils/maskToken 口径
 *   (收敛 3 处令牌脱敏 helper 的护栏·含「绝不露全串」安全断言)。
 */

const test = require('node:test');
const assert = require('node:assert');

const maskToken = require('../src/utils/maskToken');

test('falsy / 空 → (empty)', () => {
  assert.strictEqual(maskToken(''), '(empty)');
  assert.strictEqual(maskToken(null), '(empty)');
  assert.strictEqual(maskToken(undefined), '(empty)');
  assert.strictEqual(maskToken('   '), '(empty)');
});

test('len<=10 → 前3***', () => {
  assert.strictEqual(maskToken('abc'), 'abc***');
  assert.strictEqual(maskToken('1234567890'), '123***');
});

test('len>10 → 前6***后4', () => {
  assert.strictEqual(maskToken('sk-abcdef1234'), 'sk-abc***1234');
  assert.strictEqual(maskToken('123456789012'), '123456***9012');
});

test('安全:绝不返回完整令牌', () => {
  const tok = 'ghp_verysecrettoken9999';
  const masked = maskToken(tok);
  assert.notStrictEqual(masked, tok);
  assert.ok(masked.includes('***'));
});

test('逐输入等价原体', () => {
  const ref = (raw) => {
    const token = String(raw || '').trim();
    if (!token) return '(empty)';
    if (token.length <= 10) return `${token.slice(0, 3)}***`;
    return `${token.slice(0, 6)}***${token.slice(-4)}`;
  };
  for (const s of ['', null, undefined, 'abc', '1234567890', 'sk-abcdef1234', '  tok-with-space-123  ', 42]) {
    assert.strictEqual(maskToken(s), ref(s));
  }
});
