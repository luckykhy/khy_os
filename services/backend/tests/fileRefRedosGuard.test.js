'use strict';

/**
 * fileRefRedosGuard.test.js — regression for the _extractFileReferences ReDoS fix.
 *
 * DEFECT (reachable P1): _extractFileReferences runs on the raw userMessage for
 * every medium/large AI task (ai.js caller). Its regex
 *   /(?:[\w./\\-]+\.(?:js|ts|…))\b/gi
 * has a char class `[\w./\\-]+` that overlaps the required `\.(ext)` suffix, so a
 * long token that never ends in a known extension backtracks O(n²). A user pasting
 * ~80KB of dotted / path-like text hangs the request for 10+ seconds (empirically
 * measured 16.6s at 100KB; quadratic — larger pastes reach minutes). This is a
 * denial-of-service on real human input.
 *
 * FIX (gated KHY_FILEREF_REDOS_GUARD, default on): whitespace can never appear
 * inside a match (the char class excludes it), so splitting on whitespace and
 * skipping over-long tokens (real paths are short) is byte-identical for every
 * realistic input while bounding worst-case cost to linear. Guard off = the
 * original single-pass scan, byte-for-byte.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ai = require('../src/cli/ai.js');
const extract = ai.__test__._extractFileReferences;
const gateEnabled = ai.__test__._fileRefRedosGuardEnabled;

// Recompute the original single-pass extractor for fidelity comparison.
function origExtract(text) {
  const pattern = /(?:[\w./\\-]+\.(?:js|ts|jsx|tsx|py|go|java|rs|vue|css|html|json|yaml|yml|md|rb|php|c|cpp|h|sh|sql))\b/gi;
  const files = [];
  let m;
  while ((m = pattern.exec(String(text == null ? '' : text))) !== null) {
    if (!files.includes(m[0])) files.push(m[0]);
  }
  return files.slice(0, 10);
}

const REALISTIC = [
  'please look at src/cli/ai.js and services/backend/router.js',
  'see (foo.js) and [bar.ts] plus baz.py, also a/b/c.vue',
  'no files here, just prose about coding',
  'compare a.js a.js b.ts a.js',
  'path with backslash src\\cli\\router.js on windows',
  'file at ./relative/thing.json and ../up/one.yaml end',
  '中文消息 里面有 模块.py 和 index.tsx 文件',
  '',
  'trailing.md.',
  'x.js '.repeat(30),
  'main.c helper.h build.sh query.sql notes.md',
  'https://example.com/path/to/file.js?q=1 mixed with text.py',
];

// ── 1. gate semantics ──

test('gate defaults on and respects disable tokens', () => {
  assert.equal(gateEnabled({}), true);
  assert.equal(gateEnabled({ KHY_FILEREF_REDOS_GUARD: '1' }), true);
  assert.equal(gateEnabled({ KHY_FILEREF_REDOS_GUARD: 'anything' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'FALSE', 'Off']) {
    assert.equal(gateEnabled({ KHY_FILEREF_REDOS_GUARD: off }), false, `token ${off}`);
  }
});

// ── 2. fidelity: guarded output byte-identical to legacy on realistic input ──

test('guarded extraction is byte-identical to the legacy scan on realistic input', () => {
  const prev = process.env.KHY_FILEREF_REDOS_GUARD;
  delete process.env.KHY_FILEREF_REDOS_GUARD; // guard ON (default)
  try {
    for (const s of REALISTIC) {
      assert.deepEqual(extract(s), origExtract(s), `input: ${JSON.stringify(s).slice(0, 60)}`);
    }
  } finally {
    if (prev === undefined) delete process.env.KHY_FILEREF_REDOS_GUARD;
    else process.env.KHY_FILEREF_REDOS_GUARD = prev;
  }
});

// ── 3. never throws on hostile / non-string input ──

test('extraction never throws on hostile or non-string input', () => {
  const hostile = [null, undefined, 42, {}, [], '\x00\x01\x02', '中'.repeat(10000)];
  for (const h of hostile) {
    assert.doesNotThrow(() => extract(h), `input: ${String(h).slice(0, 20)}`);
  }
});

// ── 4. ReDoS eliminated: pathological input completes fast with guard on ──

test('guard ON: pathological dotted input is linear (no ReDoS hang)', () => {
  const prev = process.env.KHY_FILEREF_REDOS_GUARD;
  delete process.env.KHY_FILEREF_REDOS_GUARD;
  try {
    const payloads = [
      'a.'.repeat(50000),        // 100KB dotted — legacy ~16.6s
      '.'.repeat(100000) + 'X',
      './'.repeat(50000),
      'a.'.repeat(500000),       // 1MB
    ];
    for (const p of payloads) {
      const t0 = Date.now();
      const r = extract(p);
      const ms = Date.now() - t0;
      assert.ok(Array.isArray(r), 'returns array');
      assert.ok(ms < 1000, `guarded extraction of ${p.length} chars took ${ms}ms (must be <1000)`);
    }
  } finally {
    if (prev === undefined) delete process.env.KHY_FILEREF_REDOS_GUARD;
    else process.env.KHY_FILEREF_REDOS_GUARD = prev;
  }
});

// ── 5. load-bearing: guard OFF reproduces the slow legacy backtracking ──

test('guard OFF reproduces the legacy O(n^2) backtracking (proves the fix is load-bearing)', () => {
  const prev = process.env.KHY_FILEREF_REDOS_GUARD;
  process.env.KHY_FILEREF_REDOS_GUARD = 'off';
  try {
    // 40KB of dots takes hundreds of ms on the legacy path (vs ~0ms guarded).
    const payload = 'a.'.repeat(20000);
    const t0 = Date.now();
    extract(payload);
    const legacyMs = Date.now() - t0;

    process.env.KHY_FILEREF_REDOS_GUARD = '';
    delete process.env.KHY_FILEREF_REDOS_GUARD;
    const t1 = Date.now();
    extract(payload);
    const guardedMs = Date.now() - t1;

    // The guarded path must be dramatically faster — this asserts the guard is
    // actually doing the work, not a no-op. Legacy is typically >500ms, guarded ~0.
    assert.ok(legacyMs > guardedMs * 5 + 50,
      `expected legacy(${legacyMs}ms) >> guarded(${guardedMs}ms); guard not load-bearing`);
  } finally {
    if (prev === undefined) delete process.env.KHY_FILEREF_REDOS_GUARD;
    else process.env.KHY_FILEREF_REDOS_GUARD = prev;
  }
});

// ── 6. long-token boundary: a >256-char single token is skipped, short kept ──

test('over-long single tokens are skipped; short path tokens still extracted', () => {
  const prev = process.env.KHY_FILEREF_REDOS_GUARD;
  delete process.env.KHY_FILEREF_REDOS_GUARD;
  try {
    // A legitimate short path adjacent to a giant junk token: short one survives.
    const giant = 'x'.repeat(300) + '.js'; // >256 → skipped by guard
    const out = extract(`real.js ${giant} other.ts`);
    assert.deepEqual(out, ['real.js', 'other.ts']);
  } finally {
    if (prev === undefined) delete process.env.KHY_FILEREF_REDOS_GUARD;
    else process.env.KHY_FILEREF_REDOS_GUARD = prev;
  }
});
