'use strict';

// thinkbackReport 叶子契约测试(node:test)。
// 覆盖:门控开关、聚合(token/请求/成本/活跃天/最活跃日)、习惯画像(会话/模型/话题)、
// 数据不足提示、注入 fmtTokens、坏输入不抛、门控关 → []。
const test = require('node:test');
const assert = require('node:assert');

const {
  thinkbackEnabled,
  buildThinkbackReport,
} = require('../../src/cli/thinkbackReport');

const ON = { KHY_THINKBACK: '1' };

test('门控默认开(unset/空/未知),{0,false,off,no} 关', () => {
  assert.strictEqual(thinkbackEnabled({}), true);
  assert.strictEqual(thinkbackEnabled({ KHY_THINKBACK: '' }), true);
  assert.strictEqual(thinkbackEnabled({ KHY_THINKBACK: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(thinkbackEnabled({ KHY_THINKBACK: off }), false, `${JSON.stringify(off)} 应关`);
  }
});

test('门控关 → [] 逐字节回退(不追加任何行)', () => {
  const full = {
    history: [{ date: '2026-06-30', totalTokens: 1000, requests: 5, costUSD: 0.5 }],
    habits: { timeProfile: { totalSessions: 3 } },
    periodLabel: '近 30 天',
  };
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.deepStrictEqual(buildThinkbackReport(full, { KHY_THINKBACK: off }), []);
  }
});

test('数据全空 → 数据不足提示(不编造)', () => {
  const lines = buildThinkbackReport({ history: [], habits: {}, periodLabel: '近 7 天' }, ON);
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /使用回顾（近 7 天）/);
  assert.match(lines[0], /暂无足够数据/);
});

test('聚合按日历史:token/请求/成本/活跃天/最活跃日', () => {
  const history = [
    { date: '2026-06-28', totalTokens: 1000, requests: 4, costUSD: 0.10 },
    { date: '2026-06-29', totalTokens: 0, requests: 0, costUSD: 0 },      // 非活跃日
    { date: '2026-06-30', totalTokens: 5000, requests: 20, costUSD: 0.90 }, // 峰值
  ];
  const lines = buildThinkbackReport(
    { history, habits: {}, periodLabel: '近 30 天' },
    ON,
    { fmtTokens: (n) => `${n}` },
  );
  assert.strictEqual(lines[0], '使用回顾（近 30 天）');
  assert.ok(lines.includes('  Token 合计: 6000'));
  assert.ok(lines.includes('  请求合计: 24'));
  assert.ok(lines.includes('  成本合计: $1.00'));
  assert.ok(lines.includes('  活跃天数: 2'));
  assert.ok(lines.includes('  最活跃日: 2026-06-30（5000 tokens）'));
});

test('习惯画像:会话数+平均、最常用模型、高频话题', () => {
  const habits = {
    timeProfile: { totalSessions: 12, avgSession: '18 min' },
    modelRanking: [
      { model: 'claude-opus-4-8', count: 30, quality: '90%' },
      { model: 'gpt-x', count: 5 },
    ],
    topics: [
      { topic: '重构', count: 9 },
      { topic: '测试', count: 6 },
      { topic: '文档', count: 3 },
    ],
  };
  const lines = buildThinkbackReport({ history: [], habits, periodLabel: '近 30 天' }, ON);
  assert.ok(lines.includes('  会话数: 12,平均 18 min'));
  assert.ok(lines.includes('  最常用模型: claude-opus-4-8（30 次）'));
  assert.ok(lines.includes('  高频话题: 重构、测试、文档'));
});

test('缺 avgSession → 会话数无平均后缀;缺 model 名 → 省略模型行', () => {
  const lines = buildThinkbackReport(
    { history: [], habits: { timeProfile: { totalSessions: 4 }, modelRanking: [{ count: 2 }] } },
    ON,
  );
  assert.ok(lines.includes('  会话数: 4'));
  assert.ok(!lines.some((l) => /平均/.test(l)));
  assert.ok(!lines.some((l) => /最常用模型/.test(l)));
});

test('缺省 fmtTokens → 朴素整数串(floor)', () => {
  const lines = buildThinkbackReport(
    { history: [{ date: '2026-06-30', totalTokens: 1234.7, requests: 3, costUSD: 0 }], habits: {} },
    ON,
  );
  assert.ok(lines.includes('  Token 合计: 1234'));
});

test('periodLabel 缺省 → 本期', () => {
  const lines = buildThinkbackReport(
    { history: [{ date: '2026-06-30', totalTokens: 100, requests: 1, costUSD: 0 }], habits: {} },
    ON,
  );
  assert.strictEqual(lines[0], '使用回顾（本期）');
});

test('坏输入不抛(null/undefined/非数字段)', () => {
  assert.doesNotThrow(() => buildThinkbackReport(null, ON));
  assert.doesNotThrow(() => buildThinkbackReport(undefined, ON));
  assert.doesNotThrow(() => buildThinkbackReport({ history: 'bad', habits: 42 }, ON));
  assert.doesNotThrow(() => buildThinkbackReport(
    { history: [null, { date: 1, totalTokens: 'x', requests: null }], habits: {} }, ON,
  ));
  // 全空(含无效行)→ 数据不足单行
  const lines = buildThinkbackReport({ history: [null, {}], habits: {} }, ON);
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /暂无足够数据/);
});
