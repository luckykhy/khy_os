'use strict';

/**
 * localReasoning.test.js (node:test)
 *
 * Goal "无模型也要能简单思考": verifies the model-free reasoning engine that
 * gives local mode a basic substitute for an LLM when a network is available.
 * Four capabilities are covered, all driven by an injected hermetic `search()`
 * so no real network/model is touched:
 *   1. 对比/利弊推理   (_reasonCompare)
 *   2. 问题拆解+多查询  (_reasonDecompose / splitSubQuestions)
 *   3. 跨源事实核验     (_reasonVerify)
 *   4. 离线逻辑(无网络) (_reasonOfflineLogic)
 * Plus the honesty gate: when nothing can be reasoned, `reason()` returns null
 * so the caller degrades to the plain web-search fallback / capability menu.
 */

const test = require('node:test');
const assert = require('node:assert');

const lr = require('../../src/services/localReasoning');

// A deterministic search stub that echoes the query term (real engines do too),
// so relevance scoring and dimension extraction have material to work with.
function makeSearch(map) {
  return async (q) => {
    if (map && map[q]) return map[q];
    return [
      { title: `${q} 概述`, snippet: `${q} 的优点是性能好、速度快、效率高；缺点是成本高、比较贵。`, url: `https://example.com/${encodeURIComponent(q)}/a` },
      { title: `${q} 评测`, snippet: `${q} 易于使用，生态成熟，社区活跃，文档完善。`, url: `https://example.com/${encodeURIComponent(q)}/b` },
    ];
  };
}

test('splitSubQuestions: splits on connectors and bare 并 (verb-coordination)', () => {
  assert.deepStrictEqual(
    lr.splitSubQuestions('如何学习机器学习并找到工作'),
    ['如何学习机器学习', '找到工作'],
  );
  assert.deepStrictEqual(
    lr.splitSubQuestions('先做需求分析，然后编写代码，最后做测试'),
    ['先做需求分析', '编写代码', '最后做测试'],
  );
  // Single clause → no spurious split.
  assert.deepStrictEqual(lr.splitSubQuestions('什么是机器学习'), ['什么是机器学习']);
});

test('splitSubQuestions: does NOT split inside compound words containing 并', () => {
  // 并发 / 并行 / 合并 must stay intact (negative look-ahead / look-behind).
  assert.deepStrictEqual(lr.splitSubQuestions('并发编程很难学习'), ['并发编程很难学习']);
  assert.deepStrictEqual(
    lr.splitSubQuestions('合并数据然后导出报表'),
    ['合并数据', '导出报表'],
  );
  assert.deepStrictEqual(
    lr.splitSubQuestions('学习Go并掌握并发'),
    ['学习Go', '掌握并发'],
  );
});

test('reason: 对比 — dual-entity comparison yields a leaning conclusion', async () => {
  const out = await lr.reason('Python 和 Go 哪个好', { search: makeSearch(), networkUp: true });
  assert.ok(out, 'compare should produce output');
  assert.ok(out.includes('结论'), 'has a conclusion section');
  assert.ok(out.includes('无模型'), 'labelled as no-model output');
  assert.ok(out.includes('依据'), 'has optional expansion section');
});

test('reason: 拆解 — multi-part question is decomposed and synthesized', async () => {
  const out = await lr.reason('如何学习机器学习并找到工作', { search: makeSearch(), networkUp: true });
  assert.ok(out, 'decompose should produce output');
  assert.ok(/拆为\s*2\s*个子问题/.test(out), 'reports the sub-question count');
  assert.ok(out.includes('1.') && out.includes('2.'), 'numbered sub-blocks');
});

test('reason: 核验 — consistent cross-source facts give a high-confidence answer', async () => {
  const search = makeSearch({
    '珠穆朗玛峰有多高': [
      { title: 'a', snippet: '珠穆朗玛峰的高度为8848米。', url: 'https://x.com/1' },
      { title: 'b', snippet: '珠穆朗玛峰海拔8848米。', url: 'https://x.com/2' },
      { title: 'c', snippet: '珠穆朗玛峰高度约8848米。', url: 'https://x.com/3' },
    ],
  });
  const out = await lr.reason('珠穆朗玛峰有多高', { search, networkUp: true });
  assert.ok(out, 'verify should produce output');
  assert.ok(out.includes('8848米'), 'surfaces the agreed value');
  assert.ok(out.includes('高置信'), 'majority agreement → high confidence');
});

test('reason: 核验 — conflicting sources are flagged, not guessed', async () => {
  const search = makeSearch({
    '某产品售价多少': [
      { title: 'a', snippet: '某产品售价为100元。', url: 'https://x.com/1' },
      { title: 'b', snippet: '某产品售价为200元。', url: 'https://x.com/2' },
    ],
  });
  const out = await lr.reason('某产品售价多少', { search, networkUp: true });
  assert.ok(out, 'verify should still respond on conflict');
  assert.ok(out.includes('不一致') || out.includes('甄别'), 'flags disagreement honestly');
});

test('reason: 离线逻辑 — real arithmetic is computed without network', async () => {
  const out = await lr.reason('2的10次方', { search: null, networkUp: false });
  assert.ok(out, 'offline calc should respond');
  assert.ok(out.includes('1024'), 'computes the result');
  assert.ok(out.includes('高置信'), 'deterministic → high confidence');
});

test('reason: 算术兜底 — embedded arithmetic resolves even when online (fact-shaped)', async () => {
  // "…等于多少" matches the fact pattern, so verify runs first and returns null;
  // arithmetic must still be caught by the final offline-logic fallback.
  const out = await lr.reason('2的10次方等于多少', { search: async () => [], networkUp: true });
  assert.ok(out, 'arithmetic should resolve via final fallback');
  assert.ok(out.includes('1024'), 'computes the result regardless of network state');
});

test('reason: 离线逻辑 — degenerate calc parse is rejected (no "123 = 123")', async () => {
  // calc may mis-parse "123 乘以 456 等于多少" down to a bare "123"; the engine
  // must NOT present that as a result. With no network it degrades to null.
  const out = await lr.reason('123 乘以 456 等于多少', { search: null, networkUp: false });
  assert.strictEqual(out, null, 'degenerate single-number parse must not be surfaced');
});

test('reason: honesty gate — unreasonable + offline input degrades to null', async () => {
  const out = await lr.reason('你好啊', { search: null, networkUp: false });
  assert.strictEqual(out, null, 'no reasoning possible → null so caller can degrade');
});

test('reason: offline-first — no network skips search-backed routes', async () => {
  let searchCalled = false;
  const search = async () => { searchCalled = true; return []; };
  // A compare-shaped query, but offline: must not hit the network.
  await lr.reason('Python 和 Go 哪个好', { search, networkUp: false });
  assert.strictEqual(searchCalled, false, 'offline must not invoke injected search');
});

test('_render: structured output with confidence, sources, expansion', () => {
  const out = lr._render({
    title: '示例标题',
    conclusion: '示例结论',
    expansion: '示例依据',
    sources: ['https://example.com/very/long/path?with=query&and=more'],
    confidence: 'medium',
    sourceCount: 2,
  });
  assert.ok(out.includes('# 示例标题'), 'title heading rendered');
  assert.ok(out.includes('示例结论'), 'conclusion present');
  assert.ok(out.includes('中置信'), 'confidence label rendered');
  assert.ok(out.includes('基于 2 个来源'), 'source count rendered');
  assert.ok(out.includes('无模型'), 'no-model status marked');
  // Long URL must appear intact on its own line (selectable in terminal).
  assert.ok(out.includes('1. https://example.com/very/long/path?with=query&and=more'));
});
