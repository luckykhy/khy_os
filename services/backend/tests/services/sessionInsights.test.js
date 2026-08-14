'use strict';

// sessionInsights.test.js — 纯叶子「会话洞见」单一真源测试(node:test)。
const { test } = require('node:test');
const assert = require('node:assert');

const ins = require('../../src/services/sessionInsights');

function sampleSession() {
  return {
    sessionId: 'sess-1',
    title: '实现 goal 功能',
    model: 'claude-opus-4-8',
    createdAt: 1000,
    updatedAt: 1000 + 5 * 60 * 1000, // 5 分钟
    messages: [
      { role: 'user', content: '帮我实现 persistent goal 功能 goal goal', timestamp: 1000 },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '好的,我先读取文件。' },
          { type: 'tool_use', name: 'Read', id: 't1' },
          { type: 'tool_use', name: 'Edit', id: 't2' },
        ],
        timestamp: 2000,
      },
      { role: 'tool', content: 'file contents', timestamp: 2500 },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', id: 't3' }],
        timestamp: 3000,
      },
      { role: 'user', content: '再写个测试 testing testing', timestamp: 4000 },
      { role: 'assistant', content: '测试已写好。', timestamp: 1000 + 5 * 60 * 1000 },
    ],
  };
}

test('isEnabled: 默认开,仅 0/false/off/no 关', () => {
  assert.equal(ins.isEnabled({}), true);
  assert.equal(ins.isEnabled({ KHY_INSIGHTS: 'off' }), false);
  assert.equal(ins.isEnabled({ KHY_INSIGHTS: '0' }), false);
  assert.equal(ins.isEnabled({ KHY_INSIGHTS: 'true' }), true);
});

test('computeInsights: 计数/轮次/时长/平均长度', () => {
  const r = ins.computeInsights(sampleSession());
  assert.equal(r.ok, true);
  assert.equal(r.messageCount, 6);
  assert.equal(r.counts.user, 2);
  assert.equal(r.counts.assistant, 3);
  assert.equal(r.counts.tool, 1);
  assert.equal(r.turns, 2);
  assert.equal(r.durationMs, 5 * 60 * 1000);
});

test('computeInsights: 工具用量从 tool_use 块统计并按频次降序', () => {
  const r = ins.computeInsights(sampleSession());
  assert.equal(r.toolCallTotal, 3); // Read×2 + Edit×1
  assert.equal(r.tools[0].name, 'Read');
  assert.equal(r.tools[0].count, 2);
  assert.ok(r.tools.some((t) => t.name === 'Edit' && t.count === 1));
});

test('computeInsights: OpenAI 风格 tool_calls 也能解析', () => {
  const r = ins.computeInsights({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_calls', tool_calls: [{ function: { name: 'Bash' } }, { function: { name: 'Bash' } }] }], timestamp: 1 },
    ],
  });
  assert.equal(r.toolCallTotal, 2);
  assert.equal(r.tools[0].name, 'Bash');
  assert.equal(r.tools[0].count, 2);
});

test('computeInsights: 关键词过滤停用词、频次,且只取用户消息', () => {
  const r = ins.computeInsights(sampleSession());
  const terms = r.keywords.map((k) => k.term);
  assert.ok(terms.includes('goal')); // 出现 3 次
  assert.ok(terms.includes('testing'));
  assert.ok(!terms.includes('帮我')); // 停用词被滤
  // goal 频次最高 → 排第一
  assert.equal(r.keywords[0].term, 'goal');
});

test('computeInsights: 空会话 fail-soft', () => {
  const r = ins.computeInsights({});
  assert.equal(r.ok, true);
  assert.equal(r.messageCount, 0);
  assert.deepEqual(r.tools, []);
  const r2 = ins.computeInsights(null);
  assert.equal(r2.messageCount, 0);
});

test('computeInsights: content 为字符串与数组都能取文本', () => {
  const r = ins.computeInsights({
    messages: [
      { role: 'user', content: 'plain string keyword keyword', timestamp: 1 },
      { role: 'user', content: [{ type: 'text', text: 'arrayblock keyword' }], timestamp: 2 },
    ],
  });
  assert.equal(r.keywords[0].term, 'keyword');
  assert.equal(r.keywords[0].count, 3);
});

test('确定性: 同输入两次结果完全相等', () => {
  const a = ins.computeInsights(sampleSession());
  const b = ins.computeInsights(sampleSession());
  assert.deepEqual(a, b);
});

test('buildInsightsReport: 含概览/工具/关键词;空会话给占位语', () => {
  const r = ins.buildInsightsReport(ins.computeInsights(sampleSession()));
  assert.match(r, /# 会话洞见/);
  assert.match(r, /对话轮次:2/);
  assert.match(r, /Read × 2/);
  assert.match(r, /goal/);
  assert.match(ins.buildInsightsReport(ins.computeInsights({})), /暂无可分析/);
});

test('routeInsights: 门控关→空报告(字节回退);开→带报告', () => {
  const off = ins.routeInsights(sampleSession(), { KHY_INSIGHTS: 'off' });
  assert.equal(off.disabled, true);
  assert.equal(off.report, '');
  const on = ins.routeInsights(sampleSession(), {});
  assert.equal(on.ok, true);
  assert.match(on.report, /# 会话洞见/);
});
