'use strict';

/**
 * shouldFlushTerminalOutcome — the honesty gate for the TERMINAL outcome flush.
 *
 * The reported bug closed a no-deliverable turn on the synthetic forward line
 * "命令跑通了，我接着往下走。" — progress that never happened, because the model
 * produced no table and the loop salvaged the raw `dir` dump as the "answer".
 *
 * This gate suppresses that closing line when the turn produced no real
 * deliverable: no model text streamed (sawText=false) OR the answer was a raw
 * salvage dump (salvaged=true). Inter-tool flushes are unaffected (a tool
 * genuinely followed); only the terminal flush consults this.
 */

const { shouldFlushTerminalOutcome } = require('../../src/cli/tui/hooks/useQueryBridge');

describe('shouldFlushTerminalOutcome (terminal honesty gate)', () => {
  test('silent turn (no model text) → suppress the false forward line', () => {
    expect(shouldFlushTerminalOutcome({ sawText: false, salvaged: false, env: {} })).toBe(false);
  });

  test('salvage dump answer → suppress even if some text streamed', () => {
    expect(shouldFlushTerminalOutcome({ sawText: true, salvaged: true, env: {} })).toBe(false);
  });

  test('a real deliverable (model text, no salvage) → flush', () => {
    expect(shouldFlushTerminalOutcome({ sawText: true, salvaged: false, env: {} })).toBe(true);
  });

  test('opt-out KHY_OUTCOME_TERMINAL_HONEST=0 restores always-flush', () => {
    expect(shouldFlushTerminalOutcome({ sawText: false, salvaged: true, env: { KHY_OUTCOME_TERMINAL_HONEST: '0' } })).toBe(true);
  });

  test('never throws on missing input', () => {
    expect(shouldFlushTerminalOutcome()).toBe(false);
    expect(shouldFlushTerminalOutcome({})).toBe(false);
  });
});
