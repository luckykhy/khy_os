'use strict';
/**
 * ai.subagentThinkingClamp.test.js — extended thinking stays with the main agent.
 *
 * EFFORT_PRESETS.max is the ONLY preset carrying a `thinking` budget. A sub-agent
 * must never draw it, so _clampSubagentEffort downgrades 'max'→'high' for
 * sub-agents (escape hatch: KHY_SUBAGENT_ALLOW_THINKING=1). Every other level is
 * already thinking-free and passes through unchanged. The main agent is never
 * clamped.
 */
const ai = require('../../src/cli/ai');
const { _clampSubagentEffort, EFFORT_PRESETS } = ai;
afterEach(() => { delete process.env.KHY_SUBAGENT_ALLOW_THINKING; });
describe('_clampSubagentEffort', () => {
});

describe('Ai subagent Thinking Clamp', () => {
  test('downgrades max→high for a sub-agent', () => {
        expect(_clampSubagentEffort('max')).toBe({ isSubagent: true });
  });

  test('leaves the main agent at max', () => {
        expect(_clampSubagentEffort('max')).toBe({ isSubagent: false });
        expect(_clampSubagentEffort('max')).toBe({});
  });

  test('passes through non-max levels for a sub-agent unchanged', () => {
        for (const level of ['high', 'medium', 'low']) {
          expect(_clampSubagentEffort(level)).toBe({ isSubagent: true });
        }
  });

  test('escape hatch allowThinking:true keeps max for a sub-agent', () => {
        expect(_clampSubagentEffort('max', { isSubagent: true, allowThinking: true })).toBe('max');
  });

  test('escape hatch via KHY_SUBAGENT_ALLOW_THINKING=1 keeps max', () => {
        process.env.KHY_SUBAGENT_ALLOW_THINKING = '1';
        expect(_clampSubagentEffort('max')).toBe({ isSubagent: true });
  });

  test('the clamped target (high) carries no thinking budget; max does', () => {
        // The invariant the clamp relies on: only `max` has a thinking budget.
        expect(EFFORT_PRESETS.max.thinking).toBeTruthy();
        expect(!EFFORT_PRESETS.high.thinking).toBeTruthy();
        const clamped = _clampSubagentEffort('max', { isSubagent: true });
        expect(!EFFORT_PRESETS[clamped].thinking).toBeTruthy();
  });

});
