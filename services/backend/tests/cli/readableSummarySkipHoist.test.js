'use strict';

/**
 * readableSummarySkipHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the SKIP key-set in
 * _readableObjectSummary(): the noisy-key exclusion Set is now built once at
 * module load instead of per tool-result render. Behavior byte-identical.
 */

const test = require('node:test');
const assert = require('node:assert');

const trs = require('../../src/cli/toolResultSummary');
const { _readableObjectSummary } = trs;

test('skips noisy/internal keys, keeps meaningful scalars', () => {
  const out = _readableObjectSummary({
    success: true,
    ok: true,
    output: 'lots of text',
    content: 'body',
    text: 'body',
    _internal: 'hidden',
    files: 3,
    label: 'done',
  });
  // Skipped keys must not appear; kept scalars must.
  assert.ok(!out.includes('success='));
  assert.ok(!out.includes('output='));
  assert.ok(!out.includes('content='));
  assert.ok(!out.includes('_internal='));
  assert.ok(out.includes('files=3'));
  assert.ok(out.includes('label=done'));
});

test('nested objects/arrays are never serialized', () => {
  const out = _readableObjectSummary({ meta: { a: 1 }, list: [1, 2], count: 5 });
  assert.ok(!out.includes('{'));
  assert.ok(!out.includes('['));
  assert.ok(out.includes('count=5'));
});

test('repeated calls are independent (shared SKIP Set not corrupted)', () => {
  const a = _readableObjectSummary({ alpha: 1, output: 'x' });
  const b = _readableObjectSummary({ beta: 2, success: true });
  assert.ok(a.includes('alpha=1') && !a.includes('output='));
  assert.ok(b.includes('beta=2') && !b.includes('success='));
  // Re-run first: same result → SKIP membership stable across calls.
  const aAgain = _readableObjectSummary({ alpha: 1, output: 'x' });
  assert.strictEqual(aAgain, a);
});
