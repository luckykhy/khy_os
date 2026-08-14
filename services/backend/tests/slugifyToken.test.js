'use strict';

/**
 * slugifyToken.test.js — 锁 utils/slugifyToken 的口径。
 *
 * 这是 evoEngine/evoLedger.js / cognitiveSnapshot/offloadStore.js /
 * cognitiveSnapshot/snapshotManager.js 三处曾逐字节相同的私有 `_safe(s)` 收敛后的
 * 单一真源。它给 path.join 产出文件名安全段(挡路径分隔符/穿越/非法字符),此测同时
 * 是逐字节回退的护栏:若白名单/回退/长度上限漂移,三个消费方的落盘路径会一起变,先红。
 */

const test = require('node:test');
const assert = require('node:assert');

const slugifyToken = require('../src/utils/slugifyToken');

test('保留白名单字符 [A-Za-z0-9_.-]', () => {
  assert.strictEqual(slugifyToken('main'), 'main');
  assert.strictEqual(slugifyToken('feat_v1.2-x'), 'feat_v1.2-x');
  assert.strictEqual(slugifyToken('ABC123'), 'ABC123');
});

test('非白名单字符 → 下划线(挡路径分隔符/穿越)', () => {
  assert.strictEqual(slugifyToken('a/b'), 'a_b');
  assert.strictEqual(slugifyToken('a\\b'), 'a_b');
  assert.strictEqual(slugifyToken('../etc/passwd'), '.._etc_passwd');
  assert.strictEqual(slugifyToken('a b'), 'a_b');
  assert.strictEqual(slugifyToken('名字'), '__'); // unicode 各转一个 _
});

test('nullish/空 → 字面量 default(保证路径段非空)', () => {
  assert.strictEqual(slugifyToken(''), 'default');
  assert.strictEqual(slugifyToken(null), 'default');
  assert.strictEqual(slugifyToken(undefined), 'default');
  assert.strictEqual(slugifyToken(0), 'default');   // 0 || 'default' → 'default'
});

test('长度上限 120', () => {
  const long = 'a'.repeat(200);
  assert.strictEqual(slugifyToken(long).length, 120);
  assert.strictEqual(slugifyToken(long), 'a'.repeat(120));
});

test('非字符串被 String 强转', () => {
  assert.strictEqual(slugifyToken(123), '123');
  assert.strictEqual(slugifyToken(true), 'true');
});

test('纯函数:同输入同输出', () => {
  assert.strictEqual(slugifyToken('x/y'), slugifyToken('x/y'));
});
