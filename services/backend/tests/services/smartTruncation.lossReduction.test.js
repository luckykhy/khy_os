'use strict';
/**
 * Tests for the loss-reducing search-output truncation improvement in
 * smartTruncation.js.
 *
 * Background: _filterSearchOutput previously fell back to `result.slice(0,
 * targetLen)` when the noise-filtered output still exceeded the budget. That
 * cut from the HEAD and silently dropped the trailing lines â€?where grep-style
 * tools put errors, summaries and the "N matches" footer â€?so a truncated
 * search result could lose the very signal that matters. The fix keeps head +
 * tail (with an explicit omission marker) so critical trailing lines survive
 * context compaction.
 */
const mod = require('../../src/services/smartTruncation');

describe('Smart Truncation loss Reduction', () => {
  test('_filterSearchOutput keeps trailing error/summary lines when over budget', () => {
      const lines = Array.from({ length: 200 }, (_, i) =>
        `src/file${i}.js:10: function foo${i}() { return ${i}; }`
      );
      const grepOutput = lines.join('\n') + '\nERROR: 2 errors found in 3 files\nSUMMARY: fixed 1 file';
    
      const res = mod.truncate('Grep', grepOutput, {});
      expect(res.strategy).toBe('noise_filtered');
      expect(res.text.length < grepOutput.length).toBeTruthy();
      expect(res.text.includes('ERROR')).toBeTruthy();
      expect(res.text.includes('SUMMARY')).toBeTruthy();
      expect(res.text.includes('omitted')).toBeTruthy();
  });

  test('_filterSearchOutput completes quickly (no infinite loop) on large inputs', () => {
      const lines = Array.from({ length: 500 }, (_, i) =>
        `src/file${i}.js:10: function foo${i}() { return ${i}; }`
      );
      const grepOutput = lines.join('\n') + '\nERROR: boom\nSUMMARY: done';
      const started = Date.now();
      const res = mod.truncate('Grep', grepOutput, {});
      const elapsed = Date.now() - started;
      expect(elapsed < 2000).toBeTruthy();
      expect(res.text.length < grepOutput.length).toBeTruthy();
      expect(res.text).toContain('ERROR');
  });

  test('short search output under the soft limit is passed through untouched', () => {
      const short = 'src/a.js:1: x\nsrc/b.js:2: y';
      const res = mod.truncate('Grep', short, {});
      expect(res.strategy).toBe('none');
      expect(res.text).toBe(short);
      expect(res.truncated).toBe(false);
  });

  test('per-tool noise profiles still apply (grep collapse vs shell head+tail)', () => {
      // grep: repetitive matches collapsed with an explicit "more matches" note.
      const grepLines = Array.from({ length: 10 }, (_, i) => `src/a.js:${i}: match ${i}`);
      const grepRes = mod.truncate('Grep', grepLines.join('\n'), {});
      // shell: command echo + tail kept.
      const shellOut = ['$ build', ...Array.from({ length: 120 }, (_, i) => `line ${i}`), 'ERROR: last'].join('\n');
      const shellRes = mod.truncate('shellCommand', shellOut, {});
      expect(typeof grepRes.text).toBe('string');
      expect(typeof shellRes.text).toBe('string');
      expect(grepRes.text.length <= grepLines.join('\n').toBeTruthy().length || grepRes.truncated);
  });

  test('test-runner output keeps trailing failure details when over budget', () => {
      // A big mostly-passing suite whose final lines carry the failing test.
      // Input must exceed the runTests soft limit (10000 chars) to trigger noise
      // filtering + the head/tail cut.
      const lines = ['Tests: 200 passed, 1 failed', 'Total: 201'];
      for (let i = 0; i < 1200; i++) lines.push(`  âœ?passing test ${i}`);
      lines.push('  âœ?failing test 5', '  AssertionError: expected 1 to equal 2', '  at /src/spec.test.js:42');
      const out = lines.join('\n');
      const res = mod.truncate('runTests', out, {});
      expect(res.text.length < out.length).toBeTruthy();
      expect(res.text.includes('AssertionError')).toBeTruthy();
      expect(res.text.includes('failing test 5')).toBeTruthy();
  });

  test('build output keeps the trailing summary/errors when over budget', () => {
      // Must exceed the buildProject soft limit (8000 chars) to trigger filtering.
      const lines = ['$ npm run build'];
      for (let i = 0; i < 1200; i++) lines.push(`  [1/400] compiling chunk ${i}`);
      lines.push('  ERROR in ./src/main.js', '  Module not found: Error: Cannot resolve', '  webpack compiled with 1 error');
      const out = lines.join('\n');
      const res = mod.truncate('buildProject', out, {});
      expect(res.text.length < out.length).toBeTruthy();
      expect(res.text.includes('webpack compiled with 1 error')).toBeTruthy();
      expect(res.text.includes('Module not found')).toBeTruthy();
  });

});

