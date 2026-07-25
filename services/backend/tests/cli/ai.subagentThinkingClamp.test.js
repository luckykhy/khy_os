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

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ai = require('../../src/cli/ai');
const { _clampSubagentEffort, EFFORT_PRESETS } = ai;

afterEach(() => { delete process.env.KHY_SUBAGENT_ALLOW_THINKING; });

describe('_clampSubagentEffort', () => {
  test('downgrades max→high for a sub-agent', () => {
    assert.equal(_clampSubagentEffort('max', { isSubagent: true }), 'high');
  });

  test('leaves the main agent at max', () => {
    assert.equal(_clampSubagentEffort('max', { isSubagent: false }), 'max');
    assert.equal(_clampSubagentEffort('max', {}), 'max');
  });

  test('passes through non-max levels for a sub-agent unchanged', () => {
    for (const level of ['high', 'medium', 'low']) {
      assert.equal(_clampSubagentEffort(level, { isSubagent: true }), level);
    }
  });

  test('escape hatch allowThinking:true keeps max for a sub-agent', () => {
    assert.equal(_clampSubagentEffort('max', { isSubagent: true, allowThinking: true }), 'max');
  });

  test('escape hatch via KHY_SUBAGENT_ALLOW_THINKING=1 keeps max', () => {
    process.env.KHY_SUBAGENT_ALLOW_THINKING = '1';
    assert.equal(_clampSubagentEffort('max', { isSubagent: true }), 'max');
  });

  test('the clamped target (high) carries no thinking budget; max does', () => {
    // The invariant the clamp relies on: only `max` has a thinking budget.
    assert.ok(EFFORT_PRESETS.max.thinking, 'max must carry a thinking budget');
    assert.ok(!EFFORT_PRESETS.high.thinking, 'high must be thinking-free');
    const clamped = _clampSubagentEffort('max', { isSubagent: true });
    assert.ok(!EFFORT_PRESETS[clamped].thinking, 'clamped preset must be thinking-free');
  });
});
