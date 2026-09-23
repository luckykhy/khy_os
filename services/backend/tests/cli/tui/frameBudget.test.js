'use strict';

// frameBudget — rolling per-frame render-time guard (P0, [MGMT-RPT-031]).
// `node --test`. Pure leaf: no IO; verifies the ring-buffer math, the one-time
// breach warning, the lazy percentile, and the perfTunables SSOT wiring.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const BACKEND = path.resolve(__dirname, '../../..');
const { createGuard, DEFAULT_WINDOW, MAX_RING } = require(path.join(BACKEND, 'src/cli/tui/frameBudget'));
const perfTunables = require(path.join(BACKEND, 'src/cli/tui/perfTunables'));

test('frameBudget: record() fills the ring and stats() reports p50/p95/p99/max', () => {
  const g = createGuard({ windowSize: 10, budgetMs: 16 });
  // 9 fast frames + 1 slow frame.
  for (let i = 0; i < 9; i++) g.record(2);
  g.record(80);
  const s = g.stats();
  assert.equal(s.count, 10);
  assert.equal(s.max, 80);
  assert.equal(s.p50, 2);
  assert.equal(s.p95, 80); // nearest-rank p95 of 10 items = the 9th sorted = 2, but
  assert.ok(s.overBudget, 'p95 (80ms window-driven) exceeds the 16ms budget');
  assert.equal(s.budgetMs, 16);
});

test('frameBudget: ring evicts oldest frames beyond windowSize', () => {
  const g = createGuard({ windowSize: 5, budgetMs: 1000 });
  for (let i = 0; i < 10; i++) g.record(i); // 0..9
  assert.equal(g.stats().count, 5, 'count is capped at the window size');
  // Oldest five (0..4) evicted; remaining are 5..9.
  assert.equal(g.stats().p50, 7, 'median of [5,6,7,8,9]');
});

test('frameBudget: max ring cap is bounded (no unbounded growth)', () => {
  const g = createGuard({ windowSize: 100000, budgetMs: 16 });
  for (let i = 0; i < 5000; i++) g.record(1);
  assert.ok(g.stats().count <= MAX_RING, 'ring must never exceed the hard cap');
});

test('frameBudget: maybeWarn() fires exactly once on breach, not on clean windows', () => {
  const notes = [];
  const clean = createGuard({ windowSize: 10, budgetMs: 16, sink: { warn: (m) => notes.push(m) } });
  for (let i = 0; i < 5; i++) clean.record(2);
  clean.maybeWarn();
  clean.maybeWarn();
  assert.equal(notes.length, 0, 'no warning when p95 is within budget');

  const hot = createGuard({ windowSize: 10, budgetMs: 16, sink: { warn: (m) => notes.push(m) } });
  for (let i = 0; i < 5; i++) hot.record(60);
  hot.maybeWarn();
  hot.maybeWarn();
  hot.maybeWarn();
  assert.equal(notes.length, 1, 'breach warns exactly once (latched)');
  assert.match(notes[0], /渲染帧超预算/);
});

test('frameBudget: reset() re-arms the guard and empties the window', () => {
  const g = createGuard({ windowSize: 10, budgetMs: 16 });
  for (let i = 0; i < 8; i++) g.record(50);
  assert.ok(g.stats().overBudget);
  g.reset();
  assert.equal(g.stats().count, 0);
  assert.ok(!g.stats().overBudget, 'clean window after reset');
});

test('frameBudget: record() clamps garbage input to 0 (never negative/NaN)', () => {
  const g = createGuard({ windowSize: 4, budgetMs: 16 });
  g.record(NaN);
  g.record(-5);
  g.record(Infinity);
  g.record(3);
  const s = g.stats();
  assert.equal(s.max, 3, 'NaN / negative / Infinity are coerced to 0; only the real 3 remains');
});

test('frameBudget: perfTunables.frameBudgetMs is the SSOT (default 16, env override, reject-garbage)', () => {
  assert.equal(perfTunables.frameBudgetMs({}), 16, 'default 16ms floor');
  assert.equal(perfTunables.frameBudgetMs({ KHY_TUI_FRAME_BUDGET_MS: '32' }), 32, 'env override wins');
  assert.equal(perfTunables.frameBudgetMs({ KHY_TUI_FRAME_BUDGET_MS: 'garbage' }), 16, 'garbage -> default');
  assert.equal(perfTunables.frameBudgetMs({ KHY_TUI_FRAME_BUDGET_MS: '0' }), 16, 'zero -> default (must stay positive)');
});

test('frameBudget: DEFAULT_WINDOW / MAX_RING are exported and sane', () => {
  assert.ok(DEFAULT_WINDOW >= 30, 'default window covers ~half a second at 60fps');
  assert.ok(MAX_RING > DEFAULT_WINDOW, 'hard cap is larger than the default window');
});
