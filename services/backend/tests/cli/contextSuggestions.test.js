'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  analyzeContextSuggestions,
  renderContextSuggestionLines,
  contextSuggestionsEnabled,
  NEAR_CAPACITY_PERCENT,
} = require('../../src/services/context/contextSuggestions');

const WIN = 100000;

test('gate off → empty', () => {
  const out = analyzeContextSuggestions({ percentage: 95, contextWindow: WIN }, { KHY_CONTEXT_SUGGESTIONS: '0' });
  assert.deepStrictEqual(out, []);
  assert.strictEqual(contextSuggestionsEnabled({ KHY_CONTEXT_SUGGESTIONS: 'off' }), false);
  assert.strictEqual(contextSuggestionsEnabled({}), true);
});

test('near capacity (>=80%) → warning /compact', () => {
  const out = analyzeContextSuggestions({ percentage: 85, contextWindow: WIN }, {});
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].severity, 'warning');
  assert.match(out[0].title, /85% full/);
  assert.match(out[0].detail, /Autocompact is disabled/); // isAutoCompactEnabled unknown → default disabled copy
});

test('near capacity with autocompact enabled → different copy', () => {
  const out = analyzeContextSuggestions(
    { percentage: 90, contextWindow: WIN, isAutoCompactEnabled: true },
    {},
  );
  assert.match(out[0].detail, /Autocompact will trigger soon/);
});

test('below near-capacity → no warning', () => {
  const out = analyzeContextSuggestions({ percentage: 40, contextWindow: WIN }, {});
  assert.strictEqual(out.filter((s) => s.severity === 'warning').length, 0);
});

test('large Bash tool result → info with 50% savings', () => {
  const out = analyzeContextSuggestions(
    {
      percentage: 30,
      contextWindow: WIN,
      toolCallsByType: [{ name: 'Bash', callTokens: 0, resultTokens: 20000 }], // 20% > 15%, >10k
    },
    {},
  );
  const bash = out.find((s) => /Bash results/.test(s.title));
  assert.ok(bash, 'expected Bash suggestion');
  assert.strictEqual(bash.savingsTokens, 10000); // floor(20000*0.5)
  assert.match(bash.title, /\(20%\)/);
});

test('large WebFetch result → 40% savings', () => {
  const out = analyzeContextSuggestions(
    {
      percentage: 30,
      contextWindow: WIN,
      toolCallsByType: [{ name: 'WebFetch', resultTokens: 16000 }], // 16% > 15%
    },
    {},
  );
  const wf = out.find((s) => /WebFetch results/.test(s.title));
  assert.ok(wf);
  assert.strictEqual(wf.savingsTokens, 6400); // floor(16000*0.4)
});

test('unknown tool needs >=20% to trigger', () => {
  const below = analyzeContextSuggestions(
    { percentage: 30, contextWindow: WIN, toolCallsByType: [{ name: 'Custom', resultTokens: 16000 }] },
    {},
  ); // 16% < 20% → skip
  assert.strictEqual(below.filter((s) => /Custom/.test(s.title)).length, 0);
  const above = analyzeContextSuggestions(
    { percentage: 30, contextWindow: WIN, toolCallsByType: [{ name: 'Custom', resultTokens: 22000 }] },
    {},
  ); // 22% >= 20%
  const c = above.find((s) => /Custom/.test(s.title));
  assert.ok(c);
  assert.strictEqual(c.savingsTokens, 4400); // floor(22000*0.2)
});

test('Read bloat (>=5% <15%) not double-counted with large-tool band', () => {
  // 12% read result: below 15% band → falls to bloat check
  const out = analyzeContextSuggestions(
    {
      percentage: 30,
      contextWindow: WIN,
      toolCallsByType: [{ name: 'Read', callTokens: 0, resultTokens: 12000 }], // 12%
    },
    {},
  );
  const reads = out.filter((s) => /File reads using/.test(s.title));
  assert.strictEqual(reads.length, 1); // only bloat, not large-tool
  assert.strictEqual(reads[0].savingsTokens, 3600); // floor(12000*0.3)
});

test('Read >=15% band uses large-tool path, not bloat', () => {
  const out = analyzeContextSuggestions(
    {
      percentage: 30,
      contextWindow: WIN,
      toolCallsByType: [{ name: 'Read', callTokens: 0, resultTokens: 20000 }], // 20% >=15%
    },
    {},
  );
  assert.strictEqual(out.filter((s) => /File reads using/.test(s.title)).length, 0);
  assert.strictEqual(out.filter((s) => /Read results using/.test(s.title)).length, 1);
});

test('memory bloat with per-file detail lists largest 3', () => {
  const out = analyzeContextSuggestions(
    {
      percentage: 30,
      contextWindow: WIN,
      memoryFiles: [
        { path: '/a/CLAUDE.md', tokens: 4000 },
        { path: '/b/MEMORY.md', tokens: 3000 },
        { path: '/c/notes.md', tokens: 1000 },
      ], // total 8000 = 8% >5% and >=5k
    },
    {},
  );
  const mem = out.find((s) => /Memory files using/.test(s.title));
  assert.ok(mem);
  assert.match(mem.detail, /Largest: CLAUDE\.md \(4k\), MEMORY\.md \(3k\), notes\.md \(1k\)/);
  assert.strictEqual(mem.savingsTokens, 2400); // floor(8000*0.3)
});

test('memory bloat category fallback when no per-file data', () => {
  const out = analyzeContextSuggestions(
    {
      percentage: 30,
      contextWindow: WIN,
      categories: [{ name: 'Memory files', tokens: 7000 }], // 7% >5% >=5k
    },
    {},
  );
  const mem = out.find((s) => /Memory files using/.test(s.title));
  assert.ok(mem);
  assert.match(mem.detail, /Use \/memory to review/);
  assert.doesNotMatch(mem.detail, /Largest:/); // no per-file detail
});

test('memory below threshold → no suggestion', () => {
  const out = analyzeContextSuggestions(
    { percentage: 30, contextWindow: WIN, memoryFiles: [{ path: '/a.md', tokens: 2000 }] }, // 2% <5%
    {},
  );
  assert.strictEqual(out.filter((s) => /Memory files/.test(s.title)).length, 0);
});

test('autocompact disabled at 50-80% → info', () => {
  const out = analyzeContextSuggestions(
    { percentage: 60, contextWindow: WIN, isAutoCompactEnabled: false },
    {},
  );
  assert.ok(out.find((s) => s.title === 'Autocompact is disabled'));
  // not triggered when unknown
  const unknown = analyzeContextSuggestions({ percentage: 60, contextWindow: WIN }, {});
  assert.strictEqual(unknown.filter((s) => s.title === 'Autocompact is disabled').length, 0);
});

test('sort: warning first then savings desc', () => {
  const out = analyzeContextSuggestions(
    {
      percentage: 85, // warning
      contextWindow: WIN,
      toolCallsByType: [
        { name: 'Bash', resultTokens: 20000 }, // save 10000
        { name: 'WebFetch', resultTokens: 16000 }, // save 6400
      ],
    },
    {},
  );
  assert.strictEqual(out[0].severity, 'warning');
  const infos = out.filter((s) => s.severity === 'info');
  assert.ok(infos[0].savingsTokens >= infos[1].savingsTokens);
});

test('render lines: glyphs + savings suffix + detail indent', () => {
  const sug = [
    { severity: 'warning', title: 'Context is 90% full', detail: 'Use /compact now.' },
    { severity: 'info', title: 'Bash results using 20.0k tokens (20%)', detail: 'Redirect output.', savingsTokens: 10000 },
  ];
  const lines = renderContextSuggestionLines(sug, { title: '优化建议' }, {});
  assert.strictEqual(lines[0], '优化建议');
  assert.strictEqual(lines[1], '⚠ Context is 90% full');
  assert.strictEqual(lines[2], '  Use /compact now.');
  assert.match(lines[3], /^ℹ Bash results using 20\.0k tokens \(20%\) — 可省 ~10k$/);
  assert.strictEqual(lines[4], '  Redirect output.');
});

test('render gate off → empty', () => {
  const lines = renderContextSuggestionLines([{ severity: 'info', title: 'x' }], {}, { KHY_CONTEXT_SUGGESTIONS: 'false' });
  assert.deepStrictEqual(lines, []);
});

test('empty / invalid input → []', () => {
  assert.deepStrictEqual(analyzeContextSuggestions(null, {}), []);
  assert.deepStrictEqual(analyzeContextSuggestions({}, {}), []); // pct 0, no signals
  assert.strictEqual(NEAR_CAPACITY_PERCENT, 80);
});
