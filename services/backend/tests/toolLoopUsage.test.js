'use strict';

/**
 * toolLoopUsage.test.js — guards the loop/usage.js extraction (P0 decomposition
 * slice 1). Imports DIRECTLY from the new module (not via toolUseLoopCore) so a
 * regression in the relocated code is caught at its new home, and pins
 * createUsageTotals' initial shape.
 *
 * The behavioral contract of _accumUsage/_cumulativeUsage is already pinned by
 * toolUseLoop.loopEndFallback.test.js (which imports them via the core's
 * re-export); together the two files prove the re-export + the module are
 * byte-identical to the pre-extraction definitions.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createUsageTotals,
  _accumUsage,
  _cumulativeUsage,
} = require('../src/services/tool/loop/usage');

// Reach the same functions through the core's re-export to assert identity.
const core = require('../src/services/tool/toolUseLoopCore');

describe('loop/usage — extraction preserves the exact functions', () => {
  test('toolUseLoopCore re-exports the identical _accumUsage/_cumulativeUsage', () => {
    assert.equal(core._accumUsage, _accumUsage, 'core re-export must be the same reference');
    assert.equal(core._cumulativeUsage, _cumulativeUsage);
    assert.equal(core.createUsageTotals, createUsageTotals);
  });
});

describe('loop/usage — createUsageTotals initial shape', () => {
  test('returns a zeroed accumulator with all six fields', () => {
    const totals = createUsageTotals();
    assert.deepEqual(totals, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      rounds: 0,
    });
  });

  test('each call returns a fresh object (no shared state across requests)', () => {
    const a = createUsageTotals();
    const b = createUsageTotals();
    assert.notEqual(a, b);
    _accumUsage(a, { prompt_tokens: 5, completion_tokens: 3 });
    assert.equal(b.rounds, 0, 'mutating one accumulator must not touch another');
  });

  test('accumulated totals feed _cumulativeUsage exactly (round-trip)', () => {
    const totals = createUsageTotals();
    _accumUsage(totals, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    _accumUsage(totals, { inputTokens: 20, outputTokens: 7 });
    const usage = _cumulativeUsage(totals, null);
    assert.equal(usage.promptTokens, 30);
    assert.equal(usage.completionTokens, 12);
    assert.equal(usage.rounds, 2);
    assert.equal(usage.cumulative, true);
    assert.equal(usage.total_tokens, usage.totalTokens, 'snake_case mirrors camelCase');
  });
});
