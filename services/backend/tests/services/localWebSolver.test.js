'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const solver = require('../../src/services/localWebSolver');

const ON = () => { process.env.KHY_LOCAL_STRUCTURED = '1'; };

// ── buildReformulations: deterministic, deduped, original-first ──────────────
test('buildReformulations puts original first, then core_term, then keywords', () => {
  const plan = solver.buildReformulations('法国的首都是什么', {
    coreTerm: () => '法国 首都',
    keywords: () => ['法国', '首都', '巴黎'],
  });
  assert.strictEqual(plan[0].label, 'original');
  const labels = plan.map(p => p.label);
  assert.ok(labels.includes('core_term'));
  assert.ok(labels.includes('keywords'));
});

test('buildReformulations dedups reformulations equal to the original', () => {
  const plan = solver.buildReformulations('巴黎', {
    coreTerm: () => '巴黎',          // same as original → dropped
    keywords: () => ['巴黎'],        // same as original → dropped
  });
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].label, 'original');
});

// ── _dedupeResults ───────────────────────────────────────────────────────────
test('_dedupeResults removes duplicate URLs across strategies', () => {
  const merged = solver._dedupeResults([
    { title: 'a', url: 'https://x.com' },
    { title: 'a dup', url: 'https://x.com' },
    { title: 'b', url: 'https://y.com' },
  ]);
  assert.strictEqual(merged.length, 2);
});

// ── solve: multi-strategy aggregation + synthesis ────────────────────────────
test('solve reformulates when the original misses, then synthesizes from aggregate', async () => {
  ON();
  const queries = [];
  const search = async (q) => {
    queries.push(q);
    if (q === '法国 首都') return [
      { title: '巴黎', snippet: '法国的首都是巴黎。', url: 'https://a.com' },
      { title: 'Paris', snippet: '巴黎是法国首都。', url: 'https://b.com' },
    ];
    return null; // original misses
  };
  const r = await solver.solve('法国的首都是什么', {
    networkUp: true,
    search,
    synthesize: (q, results) => '答案：' + results.map(x => x.snippet).join(' '),
    coreTerm: () => '法国 首都',
    keywords: () => ['法国', '首都'],
  });
  assert.ok(r, 'should return a result');
  assert.ok(queries.length >= 2, 'tried more than one strategy');
  assert.match(r.answer, /巴黎/);
  assert.strictEqual(r.resultCount, 2);
  assert.ok(r.strategies.includes('original'));
});

test('solve early-exits once min results gathered', async () => {
  ON();
  const prev = process.env.KHY_LOCAL_WEB_SOLVER_MIN_RESULTS;
  process.env.KHY_LOCAL_WEB_SOLVER_MIN_RESULTS = '1';
  const queries = [];
  const search = async (q) => { queries.push(q); return [{ title: 't', snippet: 's', url: 'https://a.com' }]; };
  try {
    await solver.solve('问题', {
      networkUp: true, search,
      synthesize: () => '已综合',
      coreTerm: () => '核心', keywords: () => ['kw'],
    });
    assert.strictEqual(queries.length, 1, 'stopped after first strategy hit min results');
  } finally {
    if (prev === undefined) delete process.env.KHY_LOCAL_WEB_SOLVER_MIN_RESULTS;
    else process.env.KHY_LOCAL_WEB_SOLVER_MIN_RESULTS = prev;
  }
});

// ── solve: honest best-effort, NEVER a bare apology ──────────────────────────
test('solve returns honest best-effort message (no apology) when nothing found', async () => {
  ON();
  const r = await solver.solve('完全查不到的冷门问题', {
    networkUp: true,
    search: async () => null,
    synthesize: () => null,
    coreTerm: q => q,
    keywords: () => ['冷门'],
  });
  assert.ok(r, 'still returns a best-effort answer, not null');
  assert.strictEqual(r.resultCount, 0);
  assert.doesNotMatch(r.answer, /抱歉/, 'must not apologize');
  assert.match(r.answer, /已尝试|尝试/, 'reports what was tried (transparency)');
  assert.match(r.answer, /建议|继续|具体/, 'gives actionable next steps');
});

// ── solve: declines (null) when it should degrade to caller ──────────────────
test('solve returns null when offline', async () => {
  const r = await solver.solve('q', { networkUp: false, search: async () => [] });
  assert.strictEqual(r, null);
});

test('solve returns null when no search injected', async () => {
  const r = await solver.solve('q', { networkUp: true });
  assert.strictEqual(r, null);
});

test('solve respects KHY_LOCAL_WEB_SOLVER=off', async () => {
  const prev = process.env.KHY_LOCAL_WEB_SOLVER;
  process.env.KHY_LOCAL_WEB_SOLVER = 'off';
  try {
    const r = await solver.solve('q', { networkUp: true, search: async () => [{ url: 'https://a.com' }] });
    assert.strictEqual(r, null);
  } finally {
    if (prev === undefined) delete process.env.KHY_LOCAL_WEB_SOLVER;
    else process.env.KHY_LOCAL_WEB_SOLVER = prev;
  }
});

test('_formatBestEffortMiss is apology-free and lists strategies', () => {
  ON();
  const msg = solver._formatBestEffortMiss('某问题', ['original', 'core_term']);
  assert.doesNotMatch(msg, /抱歉/);
  assert.match(msg, /core_term|original/);
});
