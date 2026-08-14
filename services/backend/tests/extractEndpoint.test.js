'use strict';

/**
 * extractEndpoint.test.js — 锁 utils/extractEndpoint 口径
 *   (收敛 nlExternalAppResolver·nlProviderResolver 2 处相同 body 的 _extractEndpoint)。
 */

const test = require('node:test');
const assert = require('node:assert');

const extractEndpoint = require('../src/utils/extractEndpoint');

test('抽首个 http(s) URL', () => {
  assert.strictEqual(extractEndpoint('用 https://api.example.com/v1 这个'), 'https://api.example.com/v1');
  assert.strictEqual(extractEndpoint('http://x.io'), 'http://x.io');
});

test('剥尾部中文/半角标点', () => {
  assert.strictEqual(extractEndpoint('地址是 https://api.foo.com。'), 'https://api.foo.com');
  assert.strictEqual(extractEndpoint('https://api.foo.com；'), 'https://api.foo.com');
  assert.strictEqual(extractEndpoint('https://api.foo.com;'), 'https://api.foo.com');
});

test('无 URL → 空串', () => {
  assert.strictEqual(extractEndpoint('no url here'), '');
  assert.strictEqual(extractEndpoint('ftp://x.io'), '');
});

test('非字符串 → 空串(绝不抛)', () => {
  assert.strictEqual(extractEndpoint(null), '');
  assert.strictEqual(extractEndpoint(undefined), '');
  assert.strictEqual(extractEndpoint(42), '');
});

test('取首个(多 URL 只取第一个)', () => {
  assert.strictEqual(extractEndpoint('https://a.com 和 https://b.com'), 'https://a.com');
});
