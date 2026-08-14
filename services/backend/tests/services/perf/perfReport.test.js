'use strict';

/**
 * perfReport.test.js — 纯叶子会话性能报告聚合 + 渲染契约(node:test,零 IO)。
 *
 * 锁定:analyzePerf 从 sessionUsage(records)聚合 token/成本/按模型分解、从 transcript 聚合回合/墙钟;
 * formatPerfReport md/json/csv 三态确定性;诚实边界(空 records/空 transcript 不抛、不编造);门控梯。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzePerf,
  formatPerfReport,
  isEnabled,
} = require('../../../src/services/perf/perfReport');

function sampleUsage() {
  return {
    inputTokens: 300,
    outputTokens: 150,
    totalTokens: 450,
    requests: 3,
    costUSD: 0.012,
    records: [
      { provider: 'Anthropic', model: 'claude-opus-4-8', inputTokens: 100, outputTokens: 50, total: 150, costUSD: 0.006, timestamp: 1000 },
      { provider: 'Anthropic', model: 'claude-opus-4-8', inputTokens: 100, outputTokens: 50, total: 150, costUSD: 0.004, timestamp: 2000 },
      { provider: 'OpenAI', model: 'gpt-4o', inputTokens: 100, outputTokens: 50, total: 150, costUSD: 0.002, timestamp: 3000 },
    ],
  };
}

function sampleTranscript() {
  return [
    { role: 'user', timestamp: 1000 },
    { role: 'assistant', timestamp: 1500 },
    { role: 'user', timestamp: 2000 },
    { role: 'assistant', timestamp: 5000 },
    { role: 'user', timestamp: 3000, isMeta: true },
  ];
}

describe('analyzePerf 聚合', () => {
  test('token/成本/请求数从 sessionUsage 取', () => {
    const s = analyzePerf({ sessionUsage: sampleUsage() });
    assert.equal(s.tokens.input, 300);
    assert.equal(s.tokens.output, 150);
    assert.equal(s.tokens.total, 450);
    assert.equal(s.requests, 3);
    assert.ok(Math.abs(s.costUSD - 0.012) < 1e-9);
    assert.equal(s.avgTokensPerRequest, 150);
    assert.ok(Math.abs(s.avgCostPerRequest - 0.004) < 1e-9);
  });

  test('按模型分解:同 provider+model 合并、总 token 降序', () => {
    const s = analyzePerf({ sessionUsage: sampleUsage() });
    assert.equal(s.byModel.length, 2);
    // opus 两条合并 total=300,排第一(>gpt-4o 的 150)。
    assert.equal(s.byModel[0].model, 'claude-opus-4-8');
    assert.equal(s.byModel[0].requests, 2);
    assert.equal(s.byModel[0].total, 300);
    assert.ok(Math.abs(s.byModel[0].costUSD - 0.010) < 1e-9);
    assert.equal(s.byModel[1].model, 'gpt-4o');
    assert.equal(s.byModel[1].requests, 1);
  });

  test('回合数 + 墙钟来自 transcript', () => {
    const s = analyzePerf({ sessionUsage: sampleUsage(), transcript: sampleTranscript() });
    assert.equal(s.turns.user, 2);
    assert.equal(s.turns.assistant, 2);
    assert.equal(s.turns.meta, 1);
    assert.equal(s.turns.total, 4);
    assert.equal(s.firstAt, 1000);
    assert.equal(s.lastAt, 5000);
    assert.equal(s.wallClockMs, 4000);
  });

  test('totalTokens 缺失 → 由 input+output 回填', () => {
    const s = analyzePerf({ sessionUsage: { inputTokens: 10, outputTokens: 5, records: [] } });
    assert.equal(s.tokens.total, 15);
  });

  test('requests 缺失 → 由 records 数回填;costUSD 缺失 → 由 records 求和', () => {
    const su = { records: [{ model: 'm', provider: 'p', costUSD: 0.001 }, { model: 'm', provider: 'p', costUSD: 0.002 }] };
    const s = analyzePerf({ sessionUsage: su });
    assert.equal(s.requests, 2);
    assert.ok(Math.abs(s.costUSD - 0.003) < 1e-9);
  });
});

describe('诚实边界 / 防呆', () => {
  test('空入参不抛,返回全 0', () => {
    const s = analyzePerf();
    assert.equal(s.tokens.total, 0);
    assert.equal(s.requests, 0);
    assert.equal(s.costUSD, 0);
    assert.deepEqual(s.byModel, []);
    assert.equal(s.turns.total, 0);
    assert.equal(s.wallClockMs, 0);
    assert.equal(s.firstAt, null);
    assert.equal(s.lastAt, null);
  });

  test('非法字段不抛(NaN/undefined → 0)', () => {
    const s = analyzePerf({ sessionUsage: { inputTokens: 'x', records: [null, 42, { costUSD: 'y' }] } });
    assert.equal(s.tokens.input, 0);
    assert.ok(Number.isFinite(s.costUSD));
  });

  test('避免除零:requests=0 → 平均值 0 不是 NaN', () => {
    const s = analyzePerf({ sessionUsage: { records: [] } });
    assert.equal(s.avgTokensPerRequest, 0);
    assert.equal(s.avgCostPerRequest, 0);
  });
});

describe('formatPerfReport 渲染', () => {
  test('md(默认):含概览/按模型/诚实边界注脚', () => {
    const s = analyzePerf({ sessionUsage: sampleUsage(), transcript: sampleTranscript() });
    const out = formatPerfReport(s, 'md', { sessionId: 'sess-1', generatedAt: '2026-06-30T00:00:00Z' });
    assert.match(out, /# 会话性能报告/);
    assert.match(out, /sess-1/);
    assert.match(out, /## 概览/);
    assert.match(out, /## 按模型分解/);
    assert.match(out, /claude-opus-4-8/);
    assert.match(out, /不记录每工具耗时/); // 诚实边界注脚
  });

  test('空 byModel → md 提示「尚无已记录的模型用量」,不伪造表格', () => {
    const s = analyzePerf({ sessionUsage: { records: [] } });
    const out = formatPerfReport(s, 'md');
    assert.match(out, /尚无已记录的模型用量/);
    assert.doesNotMatch(out, /\| 模型 \|/);
  });

  test('json:可解析且含 sessionId/generatedAt + 统计字段', () => {
    const s = analyzePerf({ sessionUsage: sampleUsage() });
    const out = formatPerfReport(s, 'json', { sessionId: 'sid', generatedAt: 123 });
    const obj = JSON.parse(out);
    assert.equal(obj.sessionId, 'sid');
    assert.equal(obj.generatedAt, 123);
    assert.equal(obj.requests, 3);
    assert.ok(Array.isArray(obj.byModel));
  });

  test('csv:表头 + 每模型一行 + TOTAL 汇总行', () => {
    const s = analyzePerf({ sessionUsage: sampleUsage() });
    const out = formatPerfReport(s, 'csv');
    const lines = out.split('\n');
    assert.match(lines[0], /^model,provider,requests,/);
    assert.ok(lines.some((l) => l.startsWith('claude-opus-4-8,')));
    assert.ok(lines.some((l) => l.startsWith('TOTAL,')));
  });

  test('未知 format → 回退 md', () => {
    const s = analyzePerf({ sessionUsage: sampleUsage() });
    const out = formatPerfReport(s, 'xml');
    assert.match(out, /# 会话性能报告/);
  });

  test('stats 非法 → 不抛,渲染空报告', () => {
    const out = formatPerfReport(null, 'md');
    assert.match(out, /# 会话性能报告/);
  });
});

describe('门控 isEnabled', () => {
  test('默认(未设)→ 开', () => {
    assert.equal(isEnabled({}), true);
    assert.equal(isEnabled({ KHY_PERF_ISSUE: 'true' }), true);
  });
  test('falsy → 关', () => {
    for (const v of ['0', 'false', 'off', 'no', '']) {
      assert.equal(isEnabled({ KHY_PERF_ISSUE: v }), false);
    }
  });
});
