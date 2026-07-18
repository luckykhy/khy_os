'use strict';

// cacheWarning 会话累计命中率契约测试 — 纯叶子(承 KHY_CACHE_SESSION_AGGREGATE)。
// 对标 Reasonix SessionCache:整会话 hit/miss 累加,aggregate=hit/(hit+miss),比单轮稳。
// 零 IO 零网络;无状态(session 计数由调用方持有)。
const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/cacheWarning');

// 单轮 usage:read=800 write=0 input=200 → 单轮命中率 80%。
const U80 = { inputTokens: 200, cacheWriteInputTokens: 0, cacheReadInputTokens: 800 };
// 预热轮:read=100 write=100 input=800 → 单轮命中率 100/1000=10%。
const U10 = { inputTokens: 800, cacheWriteInputTokens: 100, cacheReadInputTokens: 100 };
// 无缓存数据(read+write=0):不计入 turns。
const UNOCACHE = { inputTokens: 500, cacheWriteInputTokens: 0, cacheReadInputTokens: 0 };

test('sessionAggregateEnabled:默认开,标准 falsy 串关', () => {
  assert.strictEqual(leaf.sessionAggregateEnabled({}), true);
  assert.strictEqual(leaf.sessionAggregateEnabled(undefined), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(leaf.sessionAggregateEnabled({ KHY_CACHE_SESSION_AGGREGATE: off }), false, `应关: ${off}`);
  }
});

test('accumulateSessionCache:hit+=read, miss+=input+write, turns+1;不改 prev', () => {
  const s0 = leaf.accumulateSessionCache(null, U10); // hit100 miss900 turns1
  assert.deepStrictEqual(s0, { hit: 100, miss: 900, turns: 1 });
  const s1 = leaf.accumulateSessionCache(s0, U80); // +hit800 +miss200 turns2
  assert.deepStrictEqual(s1, { hit: 900, miss: 1100, turns: 2 });
  assert.deepStrictEqual(s0, { hit: 100, miss: 900, turns: 1 }, 'prev 不被改动(返回新对象)');
});

test('accumulateSessionCache:无缓存数据的一轮不计入 turns', () => {
  const s0 = leaf.accumulateSessionCache(null, U80);
  const s1 = leaf.accumulateSessionCache(s0, UNOCACHE);
  assert.deepStrictEqual(s1, s0, '无 read/write → 原样(不计 turn)');
});

test('aggregateCacheRate:hit/(hit+miss)*100;无数据 → null', () => {
  assert.strictEqual(leaf.aggregateCacheRate({ hit: 900, miss: 1100 }), 45);
  assert.strictEqual(leaf.aggregateCacheRate({ hit: 0, miss: 0 }), null);
  assert.strictEqual(leaf.aggregateCacheRate(null), null);
});

test('会话累计比单轮稳:预热 10% 后连命中 → 累计单调爬升', () => {
  // 模拟:第1轮预热 10%,其后连续多轮 80%。单轮从 10 跳到 80(抖);累计平滑爬升。
  let s = leaf.accumulateSessionCache(null, U10); // 10%
  let agg1 = leaf.aggregateCacheRate(s); // 100/1000=10
  s = leaf.accumulateSessionCache(s, U80);
  s = leaf.accumulateSessionCache(s, U80);
  s = leaf.accumulateSessionCache(s, U80);
  const aggN = leaf.aggregateCacheRate(s);
  assert.ok(agg1 < aggN, `累计应爬升: ${agg1} → ${aggN}`);
  assert.ok(aggN > 10 && aggN < 80, `累计介于预热与稳态之间(平滑),实际 ${aggN}`);
});

test('buildSessionAggregateLine:中文一行含轮数;turns<1 或无数据 → null', () => {
  assert.strictEqual(leaf.buildSessionAggregateLine({ hit: 0, miss: 0, turns: 0 }), null);
  const line = leaf.buildSessionAggregateLine({ hit: 900, miss: 100, turns: 3 });
  assert.strictEqual(line, '会话累计命中率 90%(3 轮)');
});

test('sessionAggregateFor:门控关 → null(逐字节回退到只显示单轮)', () => {
  const r = leaf.sessionAggregateFor({ usage: U80, session: null }, { KHY_CACHE_SESSION_AGGREGATE: 'off' });
  assert.strictEqual(r, null);
});

test('sessionAggregateFor:首轮累计但不显示文案(turns<2 无额外信息)', () => {
  const r = leaf.sessionAggregateFor({ usage: U80, session: null }, {});
  assert.deepStrictEqual(r.session, { hit: 800, miss: 200, turns: 1 });
  assert.strictEqual(r.text, null, '单轮=会话,不打印避免噪声');
  assert.strictEqual(Math.round(r.rate), 80);
});

test('sessionAggregateFor:≥2 轮显示会话行;session 供调用方写回', () => {
  const r1 = leaf.sessionAggregateFor({ usage: U10, session: null }, {});
  const r2 = leaf.sessionAggregateFor({ usage: U80, session: r1.session }, {});
  assert.strictEqual(r2.session.turns, 2);
  assert.ok(r2.text, '≥2 轮应有文案');
  assert.match(r2.text, /会话累计命中率/);
});

test('坏输入绝不抛:非对象 usage / 坏 session', () => {
  assert.doesNotThrow(() => leaf.accumulateSessionCache('bad', null));
  assert.doesNotThrow(() => leaf.sessionAggregateFor(null, {}));
  assert.doesNotThrow(() => leaf.sessionAggregateFor({ usage: 'nope', session: 'bad' }, {}));
});
