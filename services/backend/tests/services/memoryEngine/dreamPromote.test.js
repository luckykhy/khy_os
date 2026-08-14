'use strict';

/**
 * memoryEngine/dreamPromote — pure selector that bridges dream insights into the
 * markdown store (node:test). Asserts mapType table + fallback, selectPromotable
 * filtering/sorting/cap, ledger dedup, and gate-off no-op. Zero IO.
 */
const test = require('node:test');
const assert = require('node:assert');

const dp = require('../../../src/services/memoryEngine/dreamPromote');

test('mapType 全表 + 未知/缺失 → feedback', () => {
  assert.strictEqual(dp.mapType('preference'), 'user');
  assert.strictEqual(dp.mapType('lesson'), 'feedback');
  assert.strictEqual(dp.mapType('milestone'), 'project');
  assert.strictEqual(dp.mapType('decision'), 'project');
  assert.strictEqual(dp.mapType('commitment'), 'project');
  assert.strictEqual(dp.mapType('fact'), 'reference');
  assert.strictEqual(dp.mapType('deep'), 'feedback');
  assert.strictEqual(dp.mapType(undefined), 'feedback');
  assert.strictEqual(dp.mapType('nonsense'), 'feedback');
});

test('isEnabled 关闭词', () => {
  assert.strictEqual(dp.isEnabled({}), true);
  assert.strictEqual(dp.isEnabled({ KHY_MEMORY_DREAM_PROMOTE: 'off' }), false);
  assert.strictEqual(dp.isEnabled({ KHY_MEMORY_DREAM_PROMOTE: '0' }), false);
  assert.strictEqual(dp.isEnabled({ KHY_MEMORY_DREAM_PROMOTE: 'no' }), false);
  assert.strictEqual(dp.isEnabled({ KHY_MEMORY_DREAM_PROMOTE: 'true' }), true);
});

const ENTRIES = [
  { id: 'd1', content: '洞察一:自愈要极端保守。', source: 'deep', score: 0.95, createdAt: 100, type: 'lesson' },
  { id: 'p1', content: '模式:门控默认开。', source: 'pattern', score: 0.9, createdAt: 200 },
  { id: 's1', content: '普通会话记忆。', source: 'session', score: 1.0, createdAt: 300 }, // wrong source
  { id: 'd2', content: '低分洞察。', source: 'deep', score: 0.5, createdAt: 400 }, // below minScore
  { id: 'd3', content: '   ', source: 'deep', score: 0.99, createdAt: 500 }, // empty content
];

test('selectPromotable: 仅 deep/pattern ∧ score>=阈 ∧ 非空 content', () => {
  const out = dp.selectPromotable(ENTRIES, new Set(), {});
  const ids = out.map((o) => o.id).sort();
  assert.deepStrictEqual(ids, ['d1', 'p1']);
  // 映射正确
  const d1 = out.find((o) => o.id === 'd1');
  assert.strictEqual(d1.memdirType, 'feedback'); // lesson → feedback
  assert.ok(d1.name.startsWith('记忆洞察: '));
  assert.ok(d1.description.length > 0);
  const p1 = out.find((o) => o.id === 'p1');
  assert.strictEqual(p1.memdirType, 'feedback'); // no type → feedback
});

test('selectPromotable: 排序 score desc, createdAt desc', () => {
  const out = dp.selectPromotable(ENTRIES, new Set(), {});
  assert.strictEqual(out[0].id, 'd1'); // 0.95 > 0.9
});

test('selectPromotable: ledger 已回流的 id 被跳过', () => {
  const out = dp.selectPromotable(ENTRIES, new Set(['d1']), {});
  assert.deepStrictEqual(out.map((o) => o.id), ['p1']);
});

test('selectPromotable: maxPerRun 截断', () => {
  const many = [];
  for (let i = 0; i < 10; i++) many.push({ id: `x${i}`, content: `c${i}`, source: 'deep', score: 0.99, createdAt: i });
  const out = dp.selectPromotable(many, new Set(), { KHY_MEMORY_DREAM_PROMOTE_MAX: '2' });
  assert.strictEqual(out.length, 2);
});

test('selectPromotable: 门控关 → []', () => {
  assert.deepStrictEqual(dp.selectPromotable(ENTRIES, new Set(), { KHY_MEMORY_DREAM_PROMOTE: 'off' }), []);
});

test('selectPromotable: 坏输入 → []（fail-soft）', () => {
  assert.deepStrictEqual(dp.selectPromotable(null, null, {}), []);
  assert.deepStrictEqual(dp.selectPromotable([{ bad: true }], new Set(), {}), []);
});
