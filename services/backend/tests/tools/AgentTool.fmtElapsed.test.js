'use strict';

/**
 * AgentTool._fmtElapsed — CC-aligned sub-agent completion duration.
 *
 * CC AgentTool/UI.tsx renders "Done (… formatDuration(totalDurationMs))" using
 * the shared CC duration formatter. Khy aligned that formatter elsewhere (turn
 * stats / cost line via ccFormat.ccFormatDuration: floor-to-seconds "3s",
 * "1m 30s") but the AgentTool itself kept formatting durations inline as
 * `(ms/1000).toFixed(1)+'s'` ("3.4s"), drifting from its own SSOT. _fmtElapsed
 * routes every completion/failure/fallback path through ccFormatDuration.
 *
 * Gate KHY_AGENT_ELAPSED_CC (default on) → SSOT; off → byte-identical legacy
 * fixed-1-decimal seconds. Pure, never throws.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { _fmtElapsed } = require('../../src/tools/AgentTool');

const withEnv = (key, val, fn) => {
  const prev = process.env[key];
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
};

describe('AgentTool._fmtElapsed (CC parity, default on)', () => {
  test('sub-minute durations floor to whole seconds (CC), not 3.4s', () => {
    assert.equal(_fmtElapsed(3400), '3s');
    assert.equal(_fmtElapsed(999), '0s');   // <1s but >=1ms → floor(0.999)=0 → "0s"
    assert.equal(_fmtElapsed(1500), '1s');
  });

  test('minute+ durations use the CC "Nm Ns" form, not raw seconds', () => {
    assert.equal(_fmtElapsed(90000), '1m 30s');
    assert.equal(_fmtElapsed(60000), '1m 0s');
  });

  test('zero is "0s" (matches CC and the existing 0s literals)', () => {
    assert.equal(_fmtElapsed(0), '0s');
  });

  test('non-finite input degrades to 0s without throwing (never breaks a sub-agent)', () => {
    assert.equal(_fmtElapsed(undefined), '0s');
    assert.equal(_fmtElapsed(NaN), '0s');
    assert.equal(_fmtElapsed('not a number'), '0s');
  });
});

describe('AgentTool._fmtElapsed gate KHY_AGENT_ELAPSED_CC=0 → byte-identical legacy', () => {
  test('falls back to the old fixed-1-decimal seconds', () => {
    withEnv('KHY_AGENT_ELAPSED_CC', '0', () => {
      assert.equal(_fmtElapsed(3400), '3.4s');   // legacy (elapsed/1000).toFixed(1)
      assert.equal(_fmtElapsed(90000), '90.0s'); // legacy never rolls into minutes
      assert.equal(_fmtElapsed(0), '0.0s');
    });
  });

  test('other falsy gate spellings also fall back', () => {
    for (const v of ['false', 'off', 'no']) {
      withEnv('KHY_AGENT_ELAPSED_CC', v, () => {
        assert.equal(_fmtElapsed(3400), '3.4s');
      });
    }
  });

  test('gate on (or unset) keeps the CC SSOT format', () => {
    withEnv('KHY_AGENT_ELAPSED_CC', undefined, () => {
      assert.equal(_fmtElapsed(3400), '3s');
    });
    withEnv('KHY_AGENT_ELAPSED_CC', '1', () => {
      assert.equal(_fmtElapsed(3400), '3s');
    });
  });
});
