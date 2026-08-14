'use strict';

/**
 * liveSealThresholdChars — pure resolver for the KHY_TUI_LIVE_SEAL_KB gate
 * behind the live-region capacity seal guard (useQueryBridge onChunk text
 * branch). Contract pinned here: default 64KB, explicit opt-out values return
 * 0 (guard disabled), invalid input falls back to the default, never throws.
 */

const { liveSealThresholdChars, DEFAULT_KB } = require('../../src/cli/tui/hooks/liveSealThreshold');

const DEFAULT_CHARS = DEFAULT_KB * 1024;

describe('liveSealThresholdChars — KHY_TUI_LIVE_SEAL_KB parsing', () => {
  test('default is 64KB (65536 chars) when the var is unset or empty', () => {
    expect(DEFAULT_CHARS).toBe(65536);
    expect(liveSealThresholdChars({})).toBe(DEFAULT_CHARS);
    expect(liveSealThresholdChars({ KHY_TUI_LIVE_SEAL_KB: '' })).toBe(DEFAULT_CHARS);
    expect(liveSealThresholdChars({ KHY_TUI_LIVE_SEAL_KB: '   ' })).toBe(DEFAULT_CHARS);
  });

  test('explicit opt-out values disable the guard (returns 0)', () => {
    for (const v of ['0', 'off', 'false', 'no', 'OFF', ' False ']) {
      expect(liveSealThresholdChars({ KHY_TUI_LIVE_SEAL_KB: v })).toBe(0);
    }
  });

  test('a positive KB value scales to characters (×1024)', () => {
    expect(liveSealThresholdChars({ KHY_TUI_LIVE_SEAL_KB: '64' })).toBe(65536);
    expect(liveSealThresholdChars({ KHY_TUI_LIVE_SEAL_KB: '128' })).toBe(131072);
    expect(liveSealThresholdChars({ KHY_TUI_LIVE_SEAL_KB: '1' })).toBe(1024);
    // Fractions are allowed and floored to whole characters.
    expect(liveSealThresholdChars({ KHY_TUI_LIVE_SEAL_KB: '0.5' })).toBe(512);
  });

  test('invalid values fall back to the default', () => {
    for (const v of ['abc', '-3', 'NaN', 'Infinity', '64kb', '{}']) {
      expect(liveSealThresholdChars({ KHY_TUI_LIVE_SEAL_KB: v })).toBe(DEFAULT_CHARS);
    }
  });

  test('never throws on hostile env inputs', () => {
    expect(liveSealThresholdChars(null)).toBe(DEFAULT_CHARS);
    expect(liveSealThresholdChars(undefined)).toBe(DEFAULT_CHARS);
    expect(liveSealThresholdChars('not-an-object')).toBe(DEFAULT_CHARS);
    expect(liveSealThresholdChars({ KHY_TUI_LIVE_SEAL_KB: { bad: true } })).toBe(DEFAULT_CHARS);
  });
});
