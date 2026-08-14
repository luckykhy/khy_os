'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractSignals } = require('../src/services/contextScope/taskSignalExtractor');
const aiMapIndex = require('../src/services/contextScope/aiMapIndex');
const { rankCandidates } = require('../src/services/contextScope/scopeRanker');
const { applyBudget, enforceBudget } = require('../src/services/contextScope/budgetController');
const { buildSearchPlan } = require('../src/services/contextScope/searchPlanBuilder');
const planner = require('../src/services/contextScope');

describe('taskSignalExtractor', () => {
  test('extracts identifiers, file/dir/ext hints and intent', () => {
    const s = extractSignals('Fix the bug in syscall_dispatch inside kernel/src/syscall.c and check process_fork');
    assert.ok(s.identifiers.includes('syscall_dispatch'));
    assert.ok(s.identifiers.includes('process_fork'));
    assert.ok(s.fileHints.includes('kernel/src/syscall.c'));
    assert.ok(s.dirHints.includes('kernel'));
    assert.equal(s.intent, 'fix');
  });

  test('captures camelCase / PascalCase / quoted, drops stopwords', () => {
    const s = extractSignals('Explain how AgentContext and buildContextPacket work, see "routeContextStrategy"');
    assert.ok(s.identifiers.includes('AgentContext'));
    assert.ok(s.identifiers.includes('buildContextPacket'));
    assert.ok(s.quoted.includes('routeContextStrategy'));
    assert.equal(s.intent, 'explain');
    assert.ok(!s.keywords.includes('the'));
    assert.ok(!s.keywords.includes('how'));
  });

  test('handles empty / garbage input without throwing', () => {
    for (const v of [undefined, null, '', '   ', 123, {}]) {
      const s = extractSignals(v);
      assert.deepEqual(s.identifiers, []);
      assert.equal(s.intent, 'general');
    }
  });

  test('CJK keywords retained', () => {
    const s = extractSignals('看看调度器的抢占逻辑怎么实现');
    assert.ok(s.keywords.some((k) => k.includes('调度') || k.includes('抢占')));
  });
});

describe('aiMapIndex — runtime .ai/ consumption', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-scope-'));
    aiMapIndex._clearCacheForTest();
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  function writeAi(ctx, map) {
    fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
    if (ctx != null) fs.writeFileSync(path.join(tmp, '.ai', 'CONTEXT.yaml'), ctx, 'utf8');
    if (map != null) fs.writeFileSync(path.join(tmp, '.ai', 'MAP.md'), map, 'utf8');
  }

  test('parses file paths, @refs and symbols into an index', () => {
    writeAi(
      'syscall_dispatch: "uint64_t syscall_dispatch_frame(void*) @kernel/src/syscall.c:1791"\n'
      + 'process: { file: kernel/src/process.c, api: "int process_fork(const user_context*)" }\n',
      '- `kernel/src/sched.c` round-robin schedule()\n',
    );
    const idx = aiMapIndex.buildIndex(tmp);
    assert.equal(idx.ok, true);
    assert.ok(idx.files.has('kernel/src/syscall.c'));
    assert.ok(idx.files.has('kernel/src/process.c'));
    assert.ok(idx.files.has('kernel/src/sched.c'));
    assert.deepEqual(aiMapIndex.lookup(idx, 'syscall_dispatch_frame'), ['kernel/src/syscall.c']);
    assert.deepEqual(aiMapIndex.lookup(idx, 'process_fork'), ['kernel/src/process.c']);
  });

  test('absent .ai/ → ok:false, never throws', () => {
    const idx = aiMapIndex.buildIndex(tmp);
    assert.equal(idx.ok, false);
    assert.equal(idx.fileCount, 0);
    assert.deepEqual(aiMapIndex.lookup(idx, 'anything'), []);
  });

  test('mtime cache returns same object until source changes', () => {
    writeAi('a: "fn() @src/a.js:1"', null);
    const a = aiMapIndex.buildIndex(tmp);
    const b = aiMapIndex.buildIndex(tmp);
    assert.equal(a, b); // cached identity
  });
});

describe('scopeRanker', () => {
  function fakeIndex(map) {
    const files = new Map();
    const byKeyword = new Map();
    for (const [file, syms] of Object.entries(map)) {
      files.set(file, { path: file, keywords: new Set(), symbols: new Set(syms) });
      for (const s of syms) {
        const k = s.toLowerCase();
        if (!byKeyword.has(k)) byKeyword.set(k, new Set());
        byKeyword.get(k).add(file);
      }
      const base = file.split('/').pop();
      if (!byKeyword.has(base.toLowerCase())) byKeyword.set(base.toLowerCase(), new Set());
      byKeyword.get(base.toLowerCase()).add(file);
    }
    return { ok: true, fileCount: files.size, files, byKeyword };
  }

  test('exact symbol hit ranks above filename-only match', () => {
    const idx = fakeIndex({
      'kernel/src/syscall.c': ['syscall_dispatch', 'syscall_invoke'],
      'kernel/src/syscall_helpers.c': ['helper'],
    });
    const signals = extractSignals('look at syscall_dispatch');
    const ranked = rankCandidates(signals, idx);
    assert.equal(ranked[0].path, 'kernel/src/syscall.c');
    assert.ok(ranked[0].score > (ranked[1] ? ranked[1].score : 0));
    assert.ok(ranked[0].reasons.some((r) => /symbol/.test(r)));
  });

  test('partial symbol match maps a base identifier to its longer .ai symbol', () => {
    const idx = fakeIndex({
      'kernel/src/syscall.c': ['syscall_dispatch_frame', 'syscall_dispatch_raw'],
      'kernel/bridge/agentframe.c': ['frame_encode'],
    });
    const signals = extractSignals('fix syscall_dispatch trap frame');
    const ranked = rankCandidates(signals, idx);
    assert.equal(ranked[0].path, 'kernel/src/syscall.c');
    assert.ok(ranked[0].reasons.some((r) => /⊂ symbol/.test(r)));
  });

  test('directory + extension hints add to score, recentFiles boosts', () => {
    const idx = fakeIndex({ 'kernel/src/sched.c': ['schedule'] });
    const signals = extractSignals('check schedule in kernel .c');
    const ranked = rankCandidates(signals, idx, { recentFiles: ['kernel/src/sched.c'] });
    assert.equal(ranked[0].path, 'kernel/src/sched.c');
    assert.ok(ranked[0].reasons.some((r) => /recently touched/.test(r)));
  });
});

describe('budgetController — sufficiency stop (no omniscience)', () => {
  test('hard ceiling caps file count', () => {
    const ranked = Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.js`, score: 100 - i }));
    const r = applyBudget(ranked, { maxFiles: 3, satisfiedConfidence: 2 /* unreachable */ });
    assert.equal(r.selected.length, 3);
    assert.equal(r.stopReason, 'budget_full');
  });

  test('diminishing returns stops before the ceiling', () => {
    const ranked = [
      { path: 'a.js', score: 50 }, { path: 'b.js', score: 40 },
      { path: 'c.js', score: 3 }, { path: 'd.js', score: 2 },
    ];
    const r = applyBudget(ranked, { maxFiles: 8, marginalFloorRatio: 0.2, satisfiedConfidence: 2 });
    assert.ok(r.selected.length >= 2 && r.selected.length < 4);
    assert.equal(r.stopReason, 'diminishing_returns');
  });

  test('confidence satisfied stops early on a strong hit', () => {
    const ranked = [{ path: 'a.js', score: 60 }, { path: 'b.js', score: 55 }];
    const r = applyBudget(ranked, { maxFiles: 8, satisfiedConfidence: 0.85, confidenceScale: 18 });
    assert.equal(r.stopReason, 'confidence_satisfied');
    assert.ok(r.confidence >= 0.85);
  });

  test('always emits a stopReason; empty → no_candidates', () => {
    assert.equal(applyBudget([], {}).stopReason, 'no_candidates');
    const r = applyBudget([{ path: 'x.js', score: 5 }], { satisfiedConfidence: 2 });
    assert.equal(r.stopReason, 'exhausted');
  });

  test('enforceBudget clamps an external selection within the ceiling & universe', () => {
    const universe = [{ path: 'a.js', score: 9 }, { path: 'b.js', score: 8 }, { path: 'c.js', score: 7 }];
    const clamped = enforceBudget(universe, ['c.js', 'a.js', 'ghost.js', 'b.js'], { maxFiles: 2 });
    assert.equal(clamped.length, 2);
    assert.deepEqual(clamped.map((c) => c.path), ['c.js', 'a.js']);
    assert.ok(!clamped.some((c) => c.path === 'ghost.js')); // cannot inject outside universe
  });
});

describe('searchPlanBuilder', () => {
  test('builds globs from dir+ext hints and grep from identifiers', () => {
    const signals = extractSignals('grep handleLogin in services .js files');
    const plan = buildSearchPlan(signals, { hasRepoCandidates: true });
    assert.ok(plan.globs.some((g) => /services\/\*\*\/\*\.js/.test(g)));
    assert.ok(plan.grepPatterns.includes('handleLogin'));
    assert.deepEqual(plan.searchQueries, []); // codebase task → no web search
  });

  test('emits web query only for external markers', () => {
    const signals = extractSignals('what is the latest version of node fetch best practice');
    const plan = buildSearchPlan(signals, { hasRepoCandidates: false });
    assert.ok(plan.searchQueries.length >= 1);
  });

  test('regex-escapes grep tokens', () => {
    const signals = extractSignals('find "a.b(c)" usage');
    const plan = buildSearchPlan(signals);
    assert.ok(plan.grepPatterns.some((p) => p.includes('\\.') && p.includes('\\(')));
  });
});

describe('ContextScopePlanner facade', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-scope-fac-'));
    aiMapIndex._clearCacheForTest();
    fs.mkdirSync(path.join(tmp, '.ai'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.ai', 'CONTEXT.yaml'),
      'sched: "void schedule(void) @kernel/src/sched.c:270 ; void yield(void)"\n'
      + 'process: "int process_fork(const user_context*) @kernel/src/process.c:373"\n', 'utf8');
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  test('end-to-end deterministic plan maps task → .ai/ files with a stop', async () => {
    const plan = await planner.planScope({ task: 'explain how schedule() works', cwd: tmp });
    assert.equal(plan.ok, true);
    assert.equal(plan.aiMap.ok, true);
    assert.ok(plan.readPlan.files.some((f) => f.path === 'kernel/src/sched.c'));
    assert.ok(['confidence_satisfied', 'diminishing_returns', 'exhausted', 'budget_full'].includes(plan.readPlan.stopReason));
    assert.equal(plan.source, 'deterministic');
  });

  test('model refinement stays within candidate universe & budget', async () => {
    const plan = await planner.planScope({
      task: 'look at schedule and process_fork',
      cwd: tmp,
      budget: { maxFiles: 1 },
      modelPlanner: async ({ candidates }) => ({
        // try to choose more than the budget + a ghost file
        chosenPaths: [...candidates.map((c) => c.path), 'kernel/EVIL.c'],
      }),
    });
    assert.equal(plan.source, 'model_refined');
    assert.equal(plan.readPlan.files.length, 1); // clamped to maxFiles
    assert.ok(!plan.readPlan.files.some((f) => /EVIL/.test(f.path))); // ghost rejected
  });

  test('model planner failure falls back to deterministic floor', async () => {
    const plan = await planner.planScope({
      task: 'look at schedule',
      cwd: tmp,
      modelPlanner: async () => { throw new Error('model down'); },
    });
    assert.equal(plan.source, 'deterministic');
    assert.equal(plan.ok, true);
  });

  test('no .ai/ → still produces a plan from signals + globs', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-bare-'));
    try {
      const plan = await planner.planScope({ task: 'grep handleLogin in src .js', cwd: bare });
      assert.equal(plan.ok, true);
      assert.equal(plan.aiMap.ok, false);
      assert.ok(plan.searchPlan.grepPatterns.includes('handleLogin'));
      assert.ok(plan.searchPlan.globs.length >= 1);
    } finally { fs.rmSync(bare, { recursive: true, force: true }); }
  });
});
