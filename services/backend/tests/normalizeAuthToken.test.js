'use strict';

/**
 * normalizeAuthToken.test.js — 锁 utils/normalizeAuthToken 口径
 *   (收敛 3 处 khy- 令牌归一化 helper 的护栏·含安全断言)。
 */

const test = require('node:test');
const assert = require('node:assert');

const normalizeAuthToken = require('../src/utils/normalizeAuthToken');

test('khy- 前缀 → 保规范形态', () => {
  assert.strictEqual(normalizeAuthToken('khy-abc123'), 'khy-abc123');
});

test('KHY-/大小写混写 → 归一到 khy-', () => {
  assert.strictEqual(normalizeAuthToken('KHY-abc'), 'khy-abc');
});

test('khy 无连字符 → 剥前缀+前导符再重建', () => {
  assert.strictEqual(normalizeAuthToken('khy__abc'), 'khy-abc');
  assert.strictEqual(normalizeAuthToken('khyabc'), 'khy-abc');
});

test('无 khy 前缀 → 整串作后缀重建', () => {
  assert.strictEqual(normalizeAuthToken('plainToken'), 'khy-plainToken');
});

test('空/仅前缀 → allowEmpty 控制返回 (安全: 无有效后缀不返伪 token)', () => {
  assert.strictEqual(normalizeAuthToken(''), '');
  assert.strictEqual(normalizeAuthToken('', { allowEmpty: false }), null);
  assert.strictEqual(normalizeAuthToken('khy-', { allowEmpty: false }), null);
  assert.strictEqual(normalizeAuthToken(null), '');
});

test('逐输入等价原体', () => {
  const ref = (raw, { allowEmpty = true } = {}) => {
    const token = String(raw || '').trim();
    if (!token) return allowEmpty ? '' : null;
    let suffix = '';
    if (/^khy-/i.test(token)) {
      suffix = token.slice(4);
    } else if (/^khy/i.test(token)) {
      suffix = token.slice(3).replace(/^[-_]+/, '');
    } else {
      suffix = token;
    }
    suffix = String(suffix || '').trim();
    if (!suffix) return allowEmpty ? '' : null;
    return `khy-${suffix}`;
  };
  const cases = [
    ['khy-abc', undefined],
    ['KHY-XYZ', { allowEmpty: false }],
    ['khy_abc', undefined],
    ['  spaced  ', undefined],
    ['', { allowEmpty: false }],
    [null, undefined],
    ['khy', { allowEmpty: false }],
    ['khy---trim', undefined],
  ];
  for (const [r, o] of cases) {
    assert.strictEqual(normalizeAuthToken(r, o), ref(r, o));
  }
});
