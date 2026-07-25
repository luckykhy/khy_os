'use strict';

// contextBreakdown 叶子契约测试(node:test)。
// 核心:CC analyzeContext + ContextVisualization 后端逻辑对齐移植 —— per-category 分解、
// 10×10 网格算法(每类 round(tokens/window×100) 至少 1 格、末方块 squareFullness)、
// 图例行渲染、门控关逐字节回退。绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  contextBreakdownEnabled,
  analyzeContextBreakdown,
  buildContextGrid,
  renderContextBreakdownLines,
  formatTokens,
  RESERVED_NAME,
  FREE_NAME,
} = require('../../src/services/context/contextBreakdown');

// 简单确定性估算器:1 token / 4 字符(便于断言)。
const est = (t) => Math.ceil(String(t || '').length / 4);

test('门控默认开(unset / 空 / 未知值),{0,false,off,no} 关', () => {
  assert.strictEqual(contextBreakdownEnabled({}), true);
  assert.strictEqual(contextBreakdownEnabled({ KHY_CONTEXT_BREAKDOWN: '' }), true);
  assert.strictEqual(contextBreakdownEnabled({ KHY_CONTEXT_BREAKDOWN: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(contextBreakdownEnabled({ KHY_CONTEXT_BREAKDOWN: off }), false, `${off} 应关`);
  }
});

test('formatTokens 对齐 CC:<1k 原数,>=1k → x.xk(去 .0),>=1M → x.xM', () => {
  assert.strictEqual(formatTokens(0), '0');
  assert.strictEqual(formatTokens(999), '999');
  assert.strictEqual(formatTokens(1000), '1k');
  assert.strictEqual(formatTokens(1500), '1.5k');
  assert.strictEqual(formatTokens(128000), '128k');
  assert.strictEqual(formatTokens(2_000_000), '2M');
  assert.strictEqual(formatTokens(-5), '0'); // 负 → 0
});

test('analyzeContextBreakdown:tokens 优先,按 CATEGORY_ORDER 排序,追加 reserved+free', () => {
  const b = analyzeContextBreakdown({
    contextWindow: 100000,
    reservedTokens: 5000,
    sections: [
      { name: 'Messages', tokens: 20000 },
      { name: 'System prompt', tokens: 3000 },
      { name: 'System tools', tokens: 12000 },
    ],
  }, {});
  assert.ok(b);
  // 排序:System prompt < System tools < Messages < (reserved) < (free)
  const names = b.categories.map((c) => c.name);
  assert.deepStrictEqual(names, ['System prompt', 'System tools', 'Messages', RESERVED_NAME, FREE_NAME]);
  assert.strictEqual(b.actualUsage, 35000);
  assert.strictEqual(b.reservedTokens, 5000);
  assert.strictEqual(b.freeTokens, 100000 - 35000 - 5000); // 60000
  assert.strictEqual(b.percentage, 35);
});

test('analyzeContextBreakdown:text→estimate,0-token 类别丢弃', () => {
  const b = analyzeContextBreakdown({
    contextWindow: 10000,
    estimateTokens: est,
    sections: [
      { name: 'Memory files', text: 'x'.repeat(400) }, // 100 tokens
      { name: 'Skills', text: '' },                     // 0 → 丢弃
      { name: 'Custom agents', tokens: 0 },             // 0 → 丢弃
    ],
  }, {});
  assert.ok(b);
  const names = b.categories.map((c) => c.name);
  assert.ok(names.includes('Memory files'));
  assert.ok(!names.includes('Skills'));
  assert.ok(!names.includes('Custom agents'));
});

test('analyzeContextBreakdown:deferred 不计入 actualUsage', () => {
  const b = analyzeContextBreakdown({
    contextWindow: 100000,
    sections: [
      { name: 'System tools', tokens: 10000 },
      { name: 'MCP tools', tokens: 8000, isDeferred: true },
    ],
  }, {});
  assert.strictEqual(b.actualUsage, 10000); // deferred 8000 不计
  assert.strictEqual(b.freeTokens, 90000);
});

test('analyzeContextBreakdown:门控关 / window<=0 / 空 sections → null', () => {
  assert.strictEqual(
    analyzeContextBreakdown({ contextWindow: 100000, sections: [{ name: 'X', tokens: 1 }] }, { KHY_CONTEXT_BREAKDOWN: 'off' }),
    null,
  );
  assert.strictEqual(analyzeContextBreakdown({ contextWindow: 0, sections: [{ name: 'X', tokens: 1 }] }, {}), null);
  assert.strictEqual(analyzeContextBreakdown({ contextWindow: 100000, sections: [] }, {}), null);
});

test('buildContextGrid:10×10=100 方块,每类 round(tokens/window×100) 至少 1 格', () => {
  const b = analyzeContextBreakdown({
    contextWindow: 100000,
    sections: [
      { name: 'System tools', tokens: 30000 }, // 30 格
      { name: 'Messages', tokens: 500 },        // round(0.5)=1(至少 1)
    ],
  }, {});
  const grid = buildContextGrid(b.categories, b.contextWindow, { width: 10, height: 10 });
  assert.strictEqual(grid.length, 10);
  assert.strictEqual(grid[0].length, 10);
  const flat = grid.flat();
  assert.strictEqual(flat.length, 100);
  const sysCount = flat.filter((s) => s.categoryName === 'System tools').length;
  assert.strictEqual(sysCount, 30);
  const msgCount = flat.filter((s) => s.categoryName === 'Messages').length;
  assert.strictEqual(msgCount, 1); // 至少 1 格
  const freeCount = flat.filter((s) => s.free).length;
  assert.strictEqual(freeCount, 100 - 30 - 1); // 剩余补 Free space
});

test('renderContextBreakdownLines:网格行 + 图例(含符号 ⛁/⛶ 与百分比)', () => {
  const b = analyzeContextBreakdown({
    contextWindow: 100000,
    sections: [{ name: 'System tools', tokens: 25000 }],
  }, {});
  const lines = renderContextBreakdownLines(b, { model: 'claude-opus-4-8', width: 10, height: 10 }, {});
  assert.ok(lines.length > 10); // 10 网格行 + 图例
  // 图例首行含 model + used/limit + 百分比
  const legend = lines.find((l) => l.includes('claude-opus-4-8'));
  assert.ok(legend);
  assert.ok(legend.includes('25k/100k tokens (25%)'));
  // 类别图例行含符号与百分比
  assert.ok(lines.some((l) => l.includes('⛁ System tools:') && l.includes('25k tokens (25.0%)')));
  assert.ok(lines.some((l) => l.startsWith('⛶ ' + FREE_NAME)));
  // 网格行含方块符号
  assert.ok(lines.slice(0, 10).some((l) => l.includes('⛁') || l.includes('⛀')));
});

test('renderContextBreakdownLines:deferred 类别图例显 N/A、不进网格', () => {
  const b = analyzeContextBreakdown({
    contextWindow: 100000,
    sections: [
      { name: 'System tools', tokens: 10000 },
      { name: 'MCP tools', tokens: 5000, isDeferred: true },
    ],
  }, {});
  const lines = renderContextBreakdownLines(b, {}, {});
  assert.ok(lines.some((l) => l.includes('MCP tools:') && l.includes('(N/A)')));
});

test('门控关 / 空分解 → renderContextBreakdownLines 返回 []', () => {
  assert.deepStrictEqual(renderContextBreakdownLines(null, {}, {}), []);
  const b = analyzeContextBreakdown({ contextWindow: 100000, sections: [{ name: 'X', tokens: 1 }] }, {});
  assert.deepStrictEqual(renderContextBreakdownLines(b, {}, { KHY_CONTEXT_BREAKDOWN: 'off' }), []);
});

test('绝不抛:坏输入(undefined / null / 非数组 sections)', () => {
  assert.doesNotThrow(() => analyzeContextBreakdown(undefined, {}));
  assert.doesNotThrow(() => analyzeContextBreakdown({ contextWindow: 'x', sections: null }, {}));
  assert.doesNotThrow(() => buildContextGrid(null, 0, {}));
  assert.doesNotThrow(() => renderContextBreakdownLines({ categories: 'bad' }, {}, {}));
});
