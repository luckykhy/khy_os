'use strict';

/**
 * Regression tests for the second wave of path-regex ReDoS fixes.
 *
 * Round-3 fixed intentCoverage.js; a follow-up hunt found 3 MORE same-shape
 * catastrophic-backtracking regexes reachable from raw user input, all quadratic
 * on a long [\w.-]-run ending in `/`:
 *   1. errorEnumerationGuard PATH_RE  — runs on originalUserMessage (per-line)
 *   2. subagentContextSummary re      — runs on parent-conversation user turns
 *   3. deliveryGate FILE_REF_RE       — runs on model finalResponse (echo risk)
 * All fixed by bounding path components to {1,255} (filesystem hard limit),
 * byte-identical for realistic input, gated with default-on + legacy fallback.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const eg = require(path.resolve(__dirname, '../src/services/errorEnumerationGuard.js'));
const sc = require(path.resolve(__dirname, '../src/services/subagentContextSummary.js'));
const dg = require(path.resolve(__dirname, '../src/services/deliveryGate.js'));

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

const EVIL = 'a'.repeat(80000) + '/';
const EVIL_MID = 'a'.repeat(40000) + '/';

// ── errorEnumerationGuard.PATH_RE (via extractErrorSignals / _keysFromErrorLine) ──

test('errorEnumerationGuard: guard ON stays linear on ultra-long error line', () => {
  const t = Date.now();
  eg.extractErrorSignals('Error: ' + EVIL);
  const ms = Date.now() - t;
  assert.ok(ms < 1000, `expected <1000ms, got ${ms}ms`);
});

test('errorEnumerationGuard: guard OFF reproduces legacy O(n^2) (load-bearing)', () => {
  const guarded = (() => { const t = Date.now(); eg.extractErrorSignals('Error: ' + EVIL_MID); return Date.now() - t; })();
  const legacy = withEnv('KHY_ERROR_PATH_REDOS_GUARD', '0', () => {
    const t = Date.now(); eg.extractErrorSignals('Error: ' + EVIL_MID); return Date.now() - t;
  });
  assert.ok(legacy > guarded * 5 + 50, `legacy (${legacy}ms) not >> guarded (${guarded}ms)`);
});

test('errorEnumerationGuard: normal error line still extracts path signals', () => {
  const sig = eg.extractErrorSignals('Error: cannot find module in src/cli/ai.js:62');
  // extractErrorSignals returns a structured object; just assert it ran & found something referencing the file
  const blob = JSON.stringify(sig);
  assert.ok(blob.includes('ai.js') || blob.includes('ai'), `expected ai.js signal, got ${blob.slice(0, 120)}`);
});

// ── subagentContextSummary.extractFilePaths ──

test('subagentContextSummary: extractFilePaths guard ON linear; ON==OFF on realistic', () => {
  const t = Date.now();
  sc.extractFilePaths(EVIL, true);
  const ms = Date.now() - t;
  assert.ok(ms < 1000, `expected <1000ms, got ${ms}ms`);

  const REAL = [
    '看 src/cli/ai.js 和 ./x.js deep/nested/main.go README.md',
    'utils/helper.ts components/Button.vue lib/x.py 保留',
    '../rel.yaml ./deep/a.b.c.tsx a_b-c.jsx',
    '',
  ];
  for (const s of REAL) {
    assert.deepStrictEqual(sc.extractFilePaths(s, true), sc.extractFilePaths(s, false),
      `mismatch: ${JSON.stringify(s)}`);
  }
});

test('subagentContextSummary: extractFilePaths default arg == guarded', () => {
  const s = 'src/cli/ai.js and lib/x.py';
  assert.deepStrictEqual(sc.extractFilePaths(s), sc.extractFilePaths(s, true));
});

test('subagentContextSummary: buildContextSummary does not hang on evil user turn', () => {
  const conv = [{ role: 'user', content: EVIL }];
  const t = Date.now();
  sc.buildContextSummary(conv);
  const ms = Date.now() - t;
  assert.ok(ms < 1000, `expected <1000ms, got ${ms}ms`);
});

test('subagentContextSummary: guard OFF reproduces legacy O(n^2)', () => {
  const guarded = (() => { const t = Date.now(); sc.extractFilePaths(EVIL_MID, true); return Date.now() - t; })();
  const legacy = (() => { const t = Date.now(); sc.extractFilePaths(EVIL_MID, false); return Date.now() - t; })();
  assert.ok(legacy > guarded * 5 + 50, `legacy (${legacy}ms) not >> guarded (${guarded}ms)`);
});

// ── deliveryGate.evidence_in_response (FILE_REF_RE) ──

test('deliveryGate: evidence_in_response guard ON linear on evil finalResponse', () => {
  const v = dg.CUSTOM_VALIDATORS.evidence_in_response;
  const t = Date.now();
  const r = v({ finalResponse: EVIL + ' .js' });
  const ms = Date.now() - t;
  assert.ok(ms < 1000, `expected <1000ms, got ${ms}ms`);
  assert.ok(r && typeof r.status === 'string');
});

test('deliveryGate: evidence_in_response still detects real file references', () => {
  const v = dg.CUSTOM_VALIDATORS.evidence_in_response;
  const r = v({ finalResponse: 'I edited src/cli/ai.js and config.json to fix it.' });
  assert.strictEqual(r.status, 'pass');
});

test('deliveryGate: guard OFF reproduces legacy O(n^2)', () => {
  const v = dg.CUSTOM_VALIDATORS.evidence_in_response;
  const guarded = (() => { const t = Date.now(); v({ finalResponse: EVIL_MID + ' .js' }); return Date.now() - t; })();
  const legacy = withEnv('KHY_DELIVERY_FILEREF_REDOS_GUARD', '0', () => {
    const t = Date.now(); v({ finalResponse: EVIL_MID + ' .js' }); return Date.now() - t;
  });
  assert.ok(legacy > guarded * 5 + 50, `legacy (${legacy}ms) not >> guarded (${guarded}ms)`);
});

test('all three never throw on hostile / non-string input', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.doesNotThrow(() => sc.extractFilePaths(bad, true));
    assert.doesNotThrow(() => eg.extractErrorSignals(bad));
    assert.doesNotThrow(() => dg.CUSTOM_VALIDATORS.evidence_in_response({ finalResponse: bad }));
  }
});
