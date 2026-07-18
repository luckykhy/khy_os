'use strict';

/**
 * _buildOutcomeReflectionHint — the non-invasive "context reference" path
 * (goal 2026-06-24). Instead of force-rendering a fixed narration string into
 * the UI, the single-source outcome voice (toolPrefaceVoice.toolOutcomeNarration)
 * is wrapped as an OPTIONAL [SYSTEM: …] reference handed to the model alongside
 * the tool results — the model may adopt, rewrite, or ignore it.
 *
 * These tests pin: the hint is a suggestion (not a command), it is single-sourced,
 * it stays silent on failures / empty input, and KHY_OUTCOME_HINT=0 disables it.
 */

const { _buildOutcomeReflectionHint } = require('../../src/services/toolUseLoop');

describe('_buildOutcomeReflectionHint (non-invasive context reference)', () => {
  test('wraps the single-source narration as an OPTIONAL reference, not a command', () => {
    const hint = _buildOutcomeReflectionHint(
      [{ tool: 'LS', result: { success: true, count: 24 }, params: { path: '/home/x/Desktop' } }],
      {},
    );
    expect(hint.startsWith('[SYSTEM:')).toBe(true);
    expect(hint.endsWith(']')).toBe(true);
    // It is framed as adopt/rewrite/ignore — the model decides.
    expect(hint).toContain('采用');
    expect(hint).toContain('改写');
    expect(hint).toContain('忽略');
    // Carries the structured readout from the single source.
    expect(hint).toContain('24');
    expect(hint).toContain('Desktop');
  });

  test('aggregates multiple tool results into one reference block', () => {
    const hint = _buildOutcomeReflectionHint([
      { tool: 'read', result: { success: true, lines: 42 }, params: { file_path: '/a/foo.js' } },
      { tool: 'grep', result: { success: true, count: 3 }, params: { pattern: 'TODO' } },
    ], {});
    expect(hint).toContain('foo.js');
    expect(hint).toContain('42');
    expect(hint).toContain('3');
  });

  test('批2: failed / non-zero-exit steps now contribute a recovery beat by default', () => {
    const failHint = _buildOutcomeReflectionHint(
      [{ tool: 'read', result: { success: false }, params: { file_path: '/a/foo.js' } }],
      {},
    );
    expect(failHint).toContain('没走通');
    expect(failHint).toContain('foo.js');
  });

  test('批2: KHY_TOOL_OUTCOME_FAIL=0 keeps failure steps silent in the reference', () => {
    const prev = process.env.KHY_TOOL_OUTCOME_FAIL;
    process.env.KHY_TOOL_OUTCOME_FAIL = '0';
    try {
      expect(_buildOutcomeReflectionHint(
        [{ tool: 'read', result: { success: false }, params: { file_path: '/a/foo.js' } }],
        {},
      )).toBe('');
      expect(_buildOutcomeReflectionHint(
        [{ tool: 'bash', result: { success: true, exitCode: 2 }, params: { command: 'npm test' } }],
        {},
      )).toBe('');
    } finally {
      if (prev === undefined) delete process.env.KHY_TOOL_OUTCOME_FAIL;
      else process.env.KHY_TOOL_OUTCOME_FAIL = prev;
    }
  });

  test('KHY_OUTCOME_HINT=0 disables the reference entirely', () => {
    const results = [{ tool: 'LS', result: { success: true, count: 5 }, params: { path: '/x' } }];
    expect(_buildOutcomeReflectionHint(results, { KHY_OUTCOME_HINT: '0' })).toBe('');
    expect(_buildOutcomeReflectionHint(results, { KHY_OUTCOME_HINT: 'off' })).toBe('');
    // On by default.
    expect(_buildOutcomeReflectionHint(results, {})).not.toBe('');
  });

  test('empty / garbage input never throws and yields no hint', () => {
    expect(_buildOutcomeReflectionHint([], {})).toBe('');
    expect(_buildOutcomeReflectionHint(null, {})).toBe('');
    expect(_buildOutcomeReflectionHint(undefined, {})).toBe('');
    expect(_buildOutcomeReflectionHint([null, undefined], {})).toBe('');
    // A tool with no concrete structured readout → still '' (no filler).
    expect(_buildOutcomeReflectionHint(
      [{ tool: 'unknown_xyz', result: { success: true }, params: {} }],
      {},
    )).toBe('');
  });
});
