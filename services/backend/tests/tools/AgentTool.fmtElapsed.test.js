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
  test('minute+ durations use the CC "Nm Ns" form, not raw seconds', () => {
    expect(_fmtElapsed(90000)).toBe('1m 30s');
    expect(_fmtElapsed(60000)).toBe('1m 0s');
  });
  test('zero is "0s" (matches CC and the existing 0s literals)', () => {
    expect(_fmtElapsed(0)).toBe('0s');
  });
});
describe('AgentTool._fmtElapsed gate KHY_AGENT_ELAPSED_CC=0 → byte-identical legacy', () => {
});

describe('Agent Tool fmt Elapsed', () => {
  test('sub-minute durations floor to whole seconds (CC), not 3.4s', () => {
        expect(_fmtElapsed(3400)).toBe('3s');
        expect(_fmtElapsed(999)).toBe('0s');   // <1s but >=1ms → floor(0.999)=0 → "0s"
        expect(_fmtElapsed(1500)).toBe('1s');
  });

  test('non-finite input degrades to 0s without throwing (never breaks a sub-agent)', () => {
        expect(_fmtElapsed(undefined)).toBe('0s');
        expect(_fmtElapsed(NaN)).toBe('0s');
        expect(_fmtElapsed('not a number')).toBe('0s');
  });

  test('falls back to the old fixed-1-decimal seconds', () => {
        withEnv('KHY_AGENT_ELAPSED_CC', '0', () => {
          expect(_fmtElapsed(3400)).toBe('3.4s');   // legacy (elapsed/1000).toFixed(1)
          expect(_fmtElapsed(90000)).toBe('90.0s'); // legacy never rolls into minutes
          expect(_fmtElapsed(0)).toBe('0.0s');
        });
  });

  test('other falsy gate spellings also fall back', () => {
        for (const v of ['false', 'off', 'no']) {
          withEnv('KHY_AGENT_ELAPSED_CC', v, () => {
            expect(_fmtElapsed(3400)).toBe('3.4s');
          });
        }
  });

  test('gate on (or unset) keeps the CC SSOT format', () => {
        withEnv('KHY_AGENT_ELAPSED_CC', undefined, () => {
          expect(_fmtElapsed(3400)).toBe('3s');
        });
        withEnv('KHY_AGENT_ELAPSED_CC', '1', () => {
          expect(_fmtElapsed(3400)).toBe('3s');
        });
  });

});
