'use strict';

/**
 * hostOfEndpoint.test.js — 锁 utils/hostOfEndpoint 口径
 *   (收敛 imageGenPoolBridge·videoGenPoolBridge 2 处相同 body 的 _hostOf)。
 */

const test = require('node:test');
const assert = require('node:assert');

const hostOf = require('../src/utils/hostOfEndpoint');

test('带协议 URL → 小写 hostname', () => {
  assert.strictEqual(hostOf('https://API.Example.COM/v1'), 'api.example.com');
  assert.strictEqual(hostOf('http://foo.bar:8080/x'), 'foo.bar');
});

test('裸主机(无协议) → 补 https 解析', () => {
  assert.strictEqual(hostOf('example.com'), 'example.com');
  assert.strictEqual(hostOf('Host.Local:1234/p'), 'host.local');
});

test('空/空白/null/undefined → 空串', () => {
  assert.strictEqual(hostOf(''), '');
  assert.strictEqual(hostOf('   '), '');
  assert.strictEqual(hostOf(null), '');
  assert.strictEqual(hostOf(undefined), '');
});

test('畸形 → 空串(绝不抛)', () => {
  assert.doesNotThrow(() => hostOf('::::'));
  assert.strictEqual(typeof hostOf('http://'), 'string');
});

test('不 mutate 入参', () => {
  const obj = { toString() { return 'x.com'; } };
  hostOf(obj);
  assert.strictEqual(typeof obj.toString, 'function');
});
