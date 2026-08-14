'use strict';

/**
 * spinnerTokenEstimate.test.js — spinner「~N tok」增量估算(纯叶子,node:test)。
 *
 * 关键不变量:
 *  - 门控:默认 on;off/0/false/no 关。
 *  - **逐字节等价**:对任意 append 序列(含 CJK/ASCII/混合/空/reset),增量估算的每一步
 *    结果 === estimateTokens(整串)。跨随机长度前缀的 append 全序列扫描证明。
 *  - resetKey 变化(新 turn)→ 全量重扫,不跨 turn 串味。
 *  - 长度回落(截断)→ 全量重扫。
 *  - 门控关 → 直接调 fullFn(逐字节回退真源)。
 *  - fullFn 缺失/抛错 → 安全默认(0 或自算),绝不抛。
 *
 * 运行:node --test services/backend/tests/cli/spinnerTokenEstimate.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/tui/ink-components/spinnerTokenEstimate');
const { estimateTokens } = require('../../src/services/tokenUsageService');

function fresh() { leaf._reset(); }

test('isEnabled:默认 on;off/0/false/no 关', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_SPINNER_TOKEN_INCREMENTAL: 'off' }), false);
  assert.equal(leaf.isEnabled({ KHY_SPINNER_TOKEN_INCREMENTAL: '0' }), false);
  assert.equal(leaf.isEnabled({ KHY_SPINNER_TOKEN_INCREMENTAL: 'false' }), false);
  assert.equal(leaf.isEnabled({ KHY_SPINNER_TOKEN_INCREMENTAL: 'no' }), false);
  assert.equal(leaf.isEnabled({ KHY_SPINNER_TOKEN_INCREMENTAL: 'on' }), true);
});

test('_countCjk / _estimate 与 estimateTokens 同源', () => {
  // _estimate(cjk,len) 复刻 estimateTokens 的最终折算
  const samples = ['', 'abcd', '你好世界', '你a好b世c界d', 'x'.repeat(37), '中'.repeat(11)];
  for (const s of samples) {
    const cjk = leaf._countCjk(s);
    assert.equal(leaf._estimate(cjk, s.length), estimateTokens(s), `_estimate 等价:${JSON.stringify(s)}`);
  }
});

test('增量:append 全序列每步 === estimateTokens(整串)', () => {
  fresh();
  const on = {}; // 默认 on
  const key = 'turn-1';
  // 混合 CJK/ASCII/换行/emoji-adjacent，逐字符 append,断言每一前缀等价
  const full = '你好, world! 这是一个混合文本\n第二行 with English 和中文 123。' +
    '再追加一些内容以拉长长度'.repeat(3);
  let acc = '';
  for (let i = 0; i < full.length; i++) {
    acc += full[i];
    const got = leaf.estimateIncremental(acc, estimateTokens, key, on);
    assert.equal(got, estimateTokens(acc), `前缀[0..${i}] 等价`);
  }
});

test('增量:分块 append(非单字符)每步等价', () => {
  fresh();
  const key = 42;
  const chunks = ['Hello ', '世界', '\n新的一行 ', 'more ASCII text ', '再来一段中文内容', '尾巴'];
  let acc = '';
  for (const c of chunks) {
    acc += c;
    assert.equal(leaf.estimateIncremental(acc, estimateTokens, key, {}), estimateTokens(acc));
  }
});

test('resetKey 变化 → 全量重扫,不串味', () => {
  fresh();
  // turn-A 累到较长
  const a = '第一轮的一些很长的中文回答内容'.repeat(4);
  assert.equal(leaf.estimateIncremental(a, estimateTokens, 'A', {}), estimateTokens(a));
  // turn-B 首帧文本更短但 key 不同 → 必须全量重扫(不能把 B 当作 A 的 append)
  const b = 'short new turn';
  assert.equal(leaf.estimateIncremental(b, estimateTokens, 'B', {}), estimateTokens(b));
  // turn-B 首帧文本更长(比 A 还长)且 key 不同 → 仍须全量,不能误当 append
  const b2 = 'B turn 全新且更长的内容'.repeat(10);
  assert.equal(leaf.estimateIncremental(b2, estimateTokens, 'B2', {}), estimateTokens(b2));
});

test('同 key 但长度回落(截断)→ 全量重扫', () => {
  fresh();
  const long = 'aaa你好bbb世界ccc';
  leaf.estimateIncremental(long, estimateTokens, 'k', {});
  const shorter = 'aaa你好'; // 更短,同 key
  assert.equal(leaf.estimateIncremental(shorter, estimateTokens, 'k', {}), estimateTokens(shorter));
  // 之后再增长,仍等价
  const grow = shorter + 'ddd新增';
  assert.equal(leaf.estimateIncremental(grow, estimateTokens, 'k', {}), estimateTokens(grow));
});

test('空/非字符串 → 0 并复位锚点', () => {
  fresh();
  assert.equal(leaf.estimateIncremental('', estimateTokens, 'k', {}), 0);
  assert.equal(leaf.estimateIncremental(null, estimateTokens, 'k', {}), 0);
  assert.equal(leaf.estimateIncremental(undefined, estimateTokens, 'k', {}), 0);
  assert.equal(leaf.estimateIncremental(123, estimateTokens, 'k', {}), 0);
  // 复位后继续 append 仍等价
  const s = '空后重新开始的内容';
  assert.equal(leaf.estimateIncremental(s, estimateTokens, 'k', {}), estimateTokens(s));
});

test('门控关 → 直接调 fullFn(逐字节回退,不用增量状态)', () => {
  fresh();
  const off = { KHY_SPINNER_TOKEN_INCREMENTAL: 'off' };
  let calls = 0;
  const spy = (t) => { calls++; return estimateTokens(t); };
  const s1 = '第一段中文 with english';
  const s2 = s1 + ' 追加内容';
  assert.equal(leaf.estimateIncremental(s1, spy, 'k', off), estimateTokens(s1));
  assert.equal(leaf.estimateIncremental(s2, spy, 'k', off), estimateTokens(s2));
  assert.equal(calls, 2, '门控关每次都走 fullFn');
});

test('fullFn 缺失/抛错 → 安全默认,绝不抛', () => {
  fresh();
  // 门控关 + 无 fullFn → 自算(_estimate),不抛
  const off = { KHY_SPINNER_TOKEN_INCREMENTAL: 'off' };
  assert.equal(leaf.estimateIncremental('你好abc', null, 'k', off), estimateTokens('你好abc'));
  // 门控关 + fullFn 抛错 → catch → 再退自算路径(fullFn 抛,catch 内又调 fullFn 抛 → 0)
  fresh();
  const boom = () => { throw new Error('boom'); };
  const r = leaf.estimateIncremental('文本', boom, 'k', off);
  assert.equal(r, 0, 'fullFn 抛错兜底 0,不抛');
});

test('增量 ON 与全量 OFF 交叉一致(同一 append 序列两种模式结果相同)', () => {
  const seq = [];
  let acc = '';
  const pieces = ['起', '手', '的', 'text ', '和 CJK 混排', ' more', '再来一段较长中文内容'.repeat(2)];
  for (const p of pieces) { acc += p; seq.push(acc); }

  fresh();
  const onResults = seq.map((s) => leaf.estimateIncremental(s, estimateTokens, 'T', {}));
  fresh();
  const offResults = seq.map((s) => leaf.estimateIncremental(s, estimateTokens, 'T', { KHY_SPINNER_TOKEN_INCREMENTAL: 'off' }));
  assert.deepEqual(onResults, offResults, 'ON/OFF 逐步结果一致');
  // 且都等于真源
  assert.deepEqual(onResults, seq.map(estimateTokens));
});
