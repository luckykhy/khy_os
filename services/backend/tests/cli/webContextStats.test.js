'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  analyzeWebContextStats,
  webContextStatsEnabled,
  DEFAULT_CONTEXT_WINDOW,
} = require('../../src/services/context/webContextStats');

// 简易确定性 token 估算器:1 token ≈ 4 字符(与真实 SSOT 无关,仅测算法)。
const est = (s) => Math.ceil(String(s || '').length / 4);

test('gate off → null (caller omits field)', () => {
  const r = analyzeWebContextStats(
    { messages: [{ role: 'user', content: 'hi' }], estimateTokens: est },
    { KHY_WEB_CONTEXT_STATS: '0' },
  );
  assert.strictEqual(r, null);
  assert.strictEqual(webContextStatsEnabled({ KHY_WEB_CONTEXT_STATS: 'off' }), false);
  assert.strictEqual(webContextStatsEnabled({}), true);
});

test('no estimator → null', () => {
  const r = analyzeWebContextStats({ messages: [{ role: 'user', content: 'hi' }] }, {});
  assert.strictEqual(r, null);
});

test('non-object input → null', () => {
  assert.strictEqual(analyzeWebContextStats(null, {}), null);
  assert.strictEqual(analyzeWebContextStats(42, {}), null);
});

test('empty messages → zero totals, empty categories, no throw', () => {
  const r = analyzeWebContextStats({ messages: [], estimateTokens: est }, {});
  assert.ok(r);
  assert.strictEqual(r.totalTokens, 0);
  assert.deepStrictEqual(r.categories, []);
  assert.strictEqual(r.remainingTokens, r.contextWindow);
  assert.strictEqual(r.contextWindow, DEFAULT_CONTEXT_WINDOW);
});

test('contextWindow resolution: explicit > env > default', () => {
  const a = analyzeWebContextStats({ messages: [], estimateTokens: est, contextWindow: 50000 }, {});
  assert.strictEqual(a.contextWindow, 50000);
  const b = analyzeWebContextStats({ messages: [], estimateTokens: est }, { KHY_CONTEXT_WINDOW: '77000' });
  assert.strictEqual(b.contextWindow, 77000);
  const c = analyzeWebContextStats({ messages: [], estimateTokens: est }, {});
  assert.strictEqual(c.contextWindow, DEFAULT_CONTEXT_WINDOW);
});

test('user + assistant text categories populated, zero-token categories omitted', () => {
  const r = analyzeWebContextStats({
    messages: [
      { role: 'user', content: 'x'.repeat(40) },
      { role: 'assistant', content: 'y'.repeat(80) },
    ],
    estimateTokens: est,
    contextWindow: 100000,
  }, {});
  const names = r.categories.map((c) => c.name);
  assert.ok(names.includes('User messages'));
  assert.ok(names.includes('Assistant messages'));
  // no tool activity → these categories omitted
  assert.ok(!names.includes('Tool calls'));
  assert.ok(!names.includes('Tool results'));
  assert.ok(r.totalTokens > 0);
  assert.ok(r.percentage > 0 && r.percentage < 1);
});

test('System tools category from toolDefsJson', () => {
  const defs = JSON.stringify([{ name: 'Bash', description: 'run', parameters: {} }]);
  const r = analyzeWebContextStats({
    messages: [{ role: 'user', content: 'hi' }],
    estimateTokens: est,
    toolDefsJson: defs,
    contextWindow: 100000,
  }, {});
  const sys = r.categories.find((c) => c.name === 'System tools');
  assert.ok(sys && sys.tokens > 0);
  assert.strictEqual(sys.tokens, est(defs));
});

test('tool_use / tool_result produce per-tool breakdown + categories', () => {
  const messages = [
    { role: 'user', content: 'read the file' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/a' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'Z'.repeat(400) },
      ],
    },
  ];
  const r = analyzeWebContextStats({ messages, estimateTokens: est, contextWindow: 100000 }, {});
  const names = r.categories.map((c) => c.name);
  assert.ok(names.includes('Tool calls'));
  assert.ok(names.includes('Tool results'));
  const read = r.toolCallsByType.find((t) => t.name === 'Read');
  assert.ok(read, 'Read tool tracked');
  assert.ok(read.resultTokens > read.callTokens, 'large result dominates');
});

test('near-capacity produces a warning suggestion', () => {
  // Craft a big single user message that fills > 80% of a tiny window.
  const big = 'w'.repeat(4 * 900); // ≈ 900 tokens
  const r = analyzeWebContextStats({
    messages: [{ role: 'user', content: big }],
    estimateTokens: est,
    contextWindow: 1000,
  }, {});
  assert.ok(r.percentage >= 80);
  const warn = r.suggestions.find((s) => s.severity === 'warning');
  assert.ok(warn, 'near-capacity warning present');
});

test('remainingTokens never negative even when over budget', () => {
  const big = 'w'.repeat(4 * 500);
  const r = analyzeWebContextStats({
    messages: [{ role: 'user', content: big }],
    estimateTokens: est,
    contextWindow: 100,
  }, {});
  assert.ok(r.remainingTokens >= 0);
  assert.strictEqual(r.remainingTokens, 0);
});

test('never throws on malformed messages', () => {
  assert.doesNotThrow(() => analyzeWebContextStats({
    messages: [null, 5, { role: 'user' }, { content: {} }],
    estimateTokens: est,
  }, {}));
});
