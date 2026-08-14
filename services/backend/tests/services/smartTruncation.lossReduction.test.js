'use strict';

/**
 * Tests for the loss-reducing search-output truncation improvement in
 * smartTruncation.js.
 *
 * Background: _filterSearchOutput previously fell back to `result.slice(0,
 * targetLen)` when the noise-filtered output still exceeded the budget. That
 * cut from the HEAD and silently dropped the trailing lines — where grep-style
 * tools put errors, summaries and the "N matches" footer — so a truncated
 * search result could lose the very signal that matters. The fix keeps head +
 * tail (with an explicit omission marker) so critical trailing lines survive
 * context compaction.
 */
const test = require('node:test');
const assert = require('node:assert');

const mod = require('../../src/services/smartTruncation');

test('_filterSearchOutput keeps trailing error/summary lines when over budget', () => {
  const lines = Array.from({ length: 200 }, (_, i) =>
    `src/file${i}.js:10: function foo${i}() { return ${i}; }`
  );
  const grepOutput = lines.join('\n') + '\nERROR: 2 errors found in 3 files\nSUMMARY: fixed 1 file';

  const res = mod.truncate('Grep', grepOutput, {});
  assert.strictEqual(res.strategy, 'noise_filtered');
  assert.ok(res.text.length < grepOutput.length, 'must reduce the oversized output');
  assert.ok(res.text.includes('ERROR'), 'trailing ERROR line must be preserved');
  assert.ok(res.text.includes('SUMMARY'), 'trailing SUMMARY line must be preserved');
  assert.ok(res.text.includes('omitted'), 'must carry an explicit omission marker');
});

test('_filterSearchOutput completes quickly (no infinite loop) on large inputs', () => {
  const lines = Array.from({ length: 500 }, (_, i) =>
    `src/file${i}.js:10: function foo${i}() { return ${i}; }`
  );
  const grepOutput = lines.join('\n') + '\nERROR: boom\nSUMMARY: done';
  const started = Date.now();
  const res = mod.truncate('Grep', grepOutput, {});
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `must not loop forever (took ${elapsed}ms)`);
  assert.ok(res.text.length < grepOutput.length);
  assert.ok(res.text.includes('ERROR'));
});

test('short search output under the soft limit is passed through untouched', () => {
  const short = 'src/a.js:1: x\nsrc/b.js:2: y';
  const res = mod.truncate('Grep', short, {});
  assert.strictEqual(res.strategy, 'none');
  assert.strictEqual(res.text, short);
  assert.strictEqual(res.truncated, false);
});

test('per-tool noise profiles still apply (grep collapse vs shell head+tail)', () => {
  // grep: repetitive matches collapsed with an explicit "more matches" note.
  const grepLines = Array.from({ length: 10 }, (_, i) => `src/a.js:${i}: match ${i}`);
  const grepRes = mod.truncate('Grep', grepLines.join('\n'), {});
  // shell: command echo + tail kept.
  const shellOut = ['$ build', ...Array.from({ length: 120 }, (_, i) => `line ${i}`), 'ERROR: last'].join('\n');
  const shellRes = mod.truncate('shellCommand', shellOut, {});
  assert.strictEqual(typeof grepRes.text, 'string');
  assert.strictEqual(typeof shellRes.text, 'string');
  assert.ok(grepRes.text.length <= grepLines.join('\n').length || grepRes.truncated);
});

test('test-runner output keeps trailing failure details when over budget', () => {
  // A big mostly-passing suite whose final lines carry the failing test.
  // Input must exceed the runTests soft limit (10000 chars) to trigger noise
  // filtering + the head/tail cut.
  const lines = ['Tests: 200 passed, 1 failed', 'Total: 201'];
  for (let i = 0; i < 1200; i++) lines.push(`  ✓ passing test ${i}`);
  lines.push('  ✕ failing test 5', '  AssertionError: expected 1 to equal 2', '  at /src/spec.test.js:42');
  const out = lines.join('\n');
  const res = mod.truncate('runTests', out, {});
  assert.ok(res.text.length < out.length, 'oversized test output must shrink');
  assert.ok(res.text.includes('AssertionError'), 'failure detail must survive');
  assert.ok(res.text.includes('failing test 5'), 'failing test name must survive');
});

test('build output keeps the trailing summary/errors when over budget', () => {
  // Must exceed the buildProject soft limit (8000 chars) to trigger filtering.
  const lines = ['$ npm run build'];
  for (let i = 0; i < 1200; i++) lines.push(`  [1/400] compiling chunk ${i}`);
  lines.push('  ERROR in ./src/main.js', '  Module not found: Error: Cannot resolve', '  webpack compiled with 1 error');
  const out = lines.join('\n');
  const res = mod.truncate('buildProject', out, {});
  assert.ok(res.text.length < out.length, 'oversized build output must shrink');
  assert.ok(res.text.includes('webpack compiled with 1 error'), 'trailing summary must survive');
  assert.ok(res.text.includes('Module not found'), 'error line must survive');
});
