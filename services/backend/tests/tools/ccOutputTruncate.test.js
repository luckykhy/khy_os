'use strict';

// 纯叶子 ccOutputTruncate 的单测:对齐 CC `src/utils/toolErrors.ts` `formatError` 的
// 「头一半 + 尾一半 + 中段字符数标记」裁剪,取代历史 pure-head 截断(丢结尾结论)。
//  - 门控开:超 limit → 保留 floor(limit/2) 头 + floor(limit/2) 尾,中间 `... [N characters truncated] ...`,
//    且**结尾内容被保住**(jest 摘要等);未超 → 原样;
//  - 门控关:逐字节回退历史 `slice(0,limit) + '\n... [truncated]'`(pure-head);
//  - 防呆:非串 / 非正 limit → 原样,绝不抛。
const test = require('node:test');
const assert = require('node:assert');
const {
  ccOutputTruncateEnabled,
  ccMiddleTruncate,
  capOutput,
  LEGACY_HEAD_MARKER,
} = require('../../src/tools/ccOutputTruncate');

test('ccOutputTruncateEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(ccOutputTruncateEnabled({}), true);
  assert.strictEqual(ccOutputTruncateEnabled({ KHY_CC_OUTPUT_TRUNCATE: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(ccOutputTruncateEnabled({ KHY_CC_OUTPUT_TRUNCATE: off }), false, `应关: ${off}`);
  }
});

test('ccMiddleTruncate:未超 limit → 原样', () => {
  assert.strictEqual(ccMiddleTruncate('hello', 10), 'hello');
  assert.strictEqual(ccMiddleTruncate('exactly10!', 10), 'exactly10!'); // 恰好 = limit 不裁
});

test('ccMiddleTruncate:超 limit → 头一半 + 尾一半 + 字符数标记(与 CC formatError 同形)', () => {
  // CC: limit=10000 → half=5000、start=slice(0,5000)、end=slice(-5000)。
  const text = 'A'.repeat(6000) + 'Z'.repeat(6000); // len 12000 > 10000
  const out = ccMiddleTruncate(text, 10000);
  const half = 5000;
  const start = text.slice(0, half);
  const end = text.slice(-half);
  const omitted = text.length - half * 2; // 2000
  assert.strictEqual(out, `${start}\n\n... [${omitted} characters truncated] ...\n\n${end}`);
  // 关键:**结尾内容(Z…)被保住** —— pure-head 会丢光 Z。
  assert.ok(out.includes('Z'.repeat(half)), 'tail must survive');
  assert.ok(out.includes('A'.repeat(half)), 'head must survive');
  assert.match(out, /\.\.\. \[2000 characters truncated\] \.\.\./);
});

test('ccMiddleTruncate:结尾的「测试摘要」结论被保留(pure-head 会丢)', () => {
  const noise = 'x'.repeat(20000);
  const summary = '\nTests: 3 failed, 97 passed, 100 total';
  const text = noise + summary;
  const out = ccMiddleTruncate(text, 8000);
  assert.ok(out.includes('Tests: 3 failed, 97 passed, 100 total'), '尾部测试摘要必须存活');
});

test('capOutput:门控开 → 走 ccMiddleTruncate(头尾)', () => {
  const text = 'H'.repeat(100) + 'T'.repeat(100); // len 200
  const out = capOutput(text, 100, { KHY_CC_OUTPUT_TRUNCATE: '1' });
  assert.ok(out.includes('T'.repeat(50)), '尾存活');
  assert.match(out, /characters truncated/);
});

test('capOutput:门控关 → 逐字节回退历史 pure-head `slice(0,limit)+"\\n... [truncated]"`', () => {
  const text = 'H'.repeat(100) + 'T'.repeat(100); // len 200
  const out = capOutput(text, 100, { KHY_CC_OUTPUT_TRUNCATE: 'off' });
  assert.strictEqual(out, text.slice(0, 100) + LEGACY_HEAD_MARKER);
  assert.strictEqual(out, 'H'.repeat(100) + '\n... [truncated]');
  assert.ok(!out.includes('T'), 'pure-head 下尾部被丢(证明历史行为被逐字节保留)');
});

test('capOutput:未超 limit → 两态都原样(与历史「不超不动」一致)', () => {
  for (const env of [{ KHY_CC_OUTPUT_TRUNCATE: '1' }, { KHY_CC_OUTPUT_TRUNCATE: 'off' }]) {
    assert.strictEqual(capOutput('short', 100, env), 'short');
  }
});

test('capOutput:默认(未设环境变量)= 开 → 头尾保留', () => {
  const text = 'H'.repeat(100) + 'T'.repeat(100);
  const out = capOutput(text, 100, {});
  assert.ok(out.includes('T'.repeat(50)) && out.includes('characters truncated'));
});

test('防呆:非串 / 非正 limit → 原样,绝不抛', () => {
  const env = { KHY_CC_OUTPUT_TRUNCATE: '1' };
  assert.strictEqual(capOutput(null, 100, env), null);
  assert.strictEqual(capOutput(undefined, 100, env), undefined);
  assert.strictEqual(capOutput(12345, 100, env), 12345);
  assert.strictEqual(capOutput('abc', 0, env), 'abc');
  assert.strictEqual(capOutput('abc', -5, env), 'abc');
  assert.strictEqual(capOutput('abc', NaN, env), 'abc');
  assert.strictEqual(ccMiddleTruncate(null, 100), null);
  assert.strictEqual(ccMiddleTruncate('abc', 0), 'abc');
});

test('capOutput:极小 limit(half→0)退化为头截不抛', () => {
  const out = capOutput('abcdef', 1, { KHY_CC_OUTPUT_TRUNCATE: '1' });
  assert.strictEqual(out, 'a'); // floor(1/2)=0 → slice(0,1)
});
