'use strict';

// salvageSummaryFocus 叶子契约测试(node:test)。
// 核心:兜底归纳(_salvageToolResults)把用户提问作为 focus 传给 summarizeToolData,
// 让 localNlp 相关性排序把命中提问的句子排最前;门控关 / 空消息 → {} 逐字节回退。绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  salvageQueryFocusEnabled,
  normalizeFocusQuery,
  buildSalvageSummaryOpts,
} = require('../../src/services/salvageSummaryFocus');

test('门控默认开(unset / 空 / 未知值),{0,false,off,no} 关', () => {
  assert.strictEqual(salvageQueryFocusEnabled({}), true);
  assert.strictEqual(salvageQueryFocusEnabled({ KHY_SALVAGE_QUERY_FOCUS: '' }), true);
  assert.strictEqual(salvageQueryFocusEnabled({ KHY_SALVAGE_QUERY_FOCUS: 'yes' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      salvageQueryFocusEnabled({ KHY_SALVAGE_QUERY_FOCUS: off }),
      false,
      `${JSON.stringify(off)} 应关`,
    );
  }
});

test('normalizeFocusQuery:空白折叠 + 去空 + 截断上限;空/畸形 → ""', () => {
  assert.strictEqual(normalizeFocusQuery('  X 的  发布   日期 '), 'X 的 发布 日期');
  assert.strictEqual(normalizeFocusQuery(''), '');
  assert.strictEqual(normalizeFocusQuery('   '), '');
  assert.strictEqual(normalizeFocusQuery(null), '');
  assert.strictEqual(normalizeFocusQuery(undefined), '');
  // 非字符串不抛
  assert.strictEqual(normalizeFocusQuery(42), '42');
  // 截断到 500
  const long = 'a'.repeat(1200);
  assert.strictEqual(normalizeFocusQuery(long).length, 500);
});

test('buildSalvageSummaryOpts 门控开 + 非空消息 → { query }', () => {
  const opts = buildSalvageSummaryOpts('what is the release date of X', { KHY_SALVAGE_QUERY_FOCUS: '1' });
  assert.deepStrictEqual(opts, { query: 'what is the release date of X' });
});

test('buildSalvageSummaryOpts 空/缺失消息 → {}(byte-identical 无焦点)', () => {
  assert.deepStrictEqual(buildSalvageSummaryOpts('', {}), {});
  assert.deepStrictEqual(buildSalvageSummaryOpts('   ', {}), {});
  assert.deepStrictEqual(buildSalvageSummaryOpts(null, {}), {});
  assert.deepStrictEqual(buildSalvageSummaryOpts(undefined, {}), {});
});

test('buildSalvageSummaryOpts 门控关 → {}(丢焦点·逐字节回退今日)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.deepStrictEqual(
      buildSalvageSummaryOpts('some real question', { KHY_SALVAGE_QUERY_FOCUS: off }),
      {},
      `门控关(${off})应回退 {} 无 query`,
    );
  }
});

test('畸形输入绝不抛,均回退安全 opts', () => {
  // 对象消息 String() → '[object Object]'(非空)→ 门控开返 { query }
  assert.deepStrictEqual(
    buildSalvageSummaryOpts({}, { KHY_SALVAGE_QUERY_FOCUS: '1' }),
    { query: '[object Object]' },
  );
  // 门控关下同样对象消息 → {}
  assert.deepStrictEqual(buildSalvageSummaryOpts({}, { KHY_SALVAGE_QUERY_FOCUS: 'off' }), {});
  // env 缺失走 process.env(默认开),不抛
  assert.ok(typeof buildSalvageSummaryOpts('q') === 'object');
});
