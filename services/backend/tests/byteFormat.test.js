'use strict';

/**
 * byteFormat.test.js — 锁 byteFormat.humanBytes 的口径(带空格、到 TB、绝不抛)。
 *
 * 这是三处历史 `_humanBytes`(diskAnalyzeReport / upstreamStudyReport /
 * diskCleanup/planner)收敛后的单一真源;此测同时是「逐字节回退」的护栏:
 * 若有人改动进位/取整规则,三处报告输出会一起漂移,此测先红。
 */

const test = require('node:test');
const assert = require('node:assert');

const { humanBytes } = require('../src/services/byteFormat');

test('退化输入 → "0 B"(非有限/<=0/null/字符串)', () => {
  for (const x of [NaN, Infinity, -Infinity, -1, 0, null, undefined, 'abc', {}]) {
    assert.strictEqual(humanBytes(x), '0 B');
  }
});

test('B 档取整(i===0),不带小数', () => {
  assert.strictEqual(humanBytes(1), '1 B');
  assert.strictEqual(humanBytes(512), '512 B');
  assert.strictEqual(humanBytes(1023), '1023 B');
});

test('1024 起进位到 KB(<100 保 1 位小数,含 .0)', () => {
  assert.strictEqual(humanBytes(1024), '1.0 KB');
  assert.strictEqual(humanBytes(1536), '1.5 KB');
});

test('>=100 的值取整,<100 保 1 位小数', () => {
  assert.strictEqual(humanBytes(100 * 1024), '100 KB');       // 100.0 → 取整
  assert.strictEqual(humanBytes(1536 * 1024), '1.5 MB');       // <100 → 1 位小数
  assert.strictEqual(humanBytes(340 * 1048576), '340 MB');
});

test('进位到 GB / TB(<100 的值保 1 位小数,含 .0)', () => {
  assert.strictEqual(humanBytes(2 * 1073741824), '2.0 GB');     // 2<100 → toFixed(1)
  assert.strictEqual(humanBytes(1.5 * 1099511627776), '1.5 TB');
});

test('TB 封顶不再往上(PB 也显示为 TB)', () => {
  const s = humanBytes(5000 * 1099511627776);
  assert.ok(s.endsWith(' TB'), `expected TB cap, got ${s}`);
});

test('纯函数:同输入同输出,不 mutate', () => {
  assert.strictEqual(humanBytes(1536), humanBytes(1536));
});
