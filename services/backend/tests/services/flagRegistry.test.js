'use strict';

// Read the actual FLAGS from the module to test real data
const { isRegistryEnabled, isFlagEnabled, resolveNumeric, listFlags, FLAGS, OFF_WORDS } = require('../../src/services/flagRegistry');

describe('flagRegistry', () => {
  describe('isRegistryEnabled', () => {
    test('returns true by default', () => {
      expect(isRegistryEnabled({})).toBe(true);
    });

    test('returns true when KHY_FLAG_REGISTRY is undefined', () => {
      expect(isRegistryEnabled({ KHY_FLAG_REGISTRY: undefined })).toBe(true);
    });

    test('returns false for off values', () => {
      expect(isRegistryEnabled({ KHY_FLAG_REGISTRY: '0' })).toBe(false);
      expect(isRegistryEnabled({ KHY_FLAG_REGISTRY: 'false' })).toBe(false);
      expect(isRegistryEnabled({ KHY_FLAG_REGISTRY: 'off' })).toBe(false);
      expect(isRegistryEnabled({ KHY_FLAG_REGISTRY: 'no' })).toBe(false);
    });

    test('returns true for on values', () => {
      expect(isRegistryEnabled({ KHY_FLAG_REGISTRY: '1' })).toBe(true);
      expect(isRegistryEnabled({ KHY_FLAG_REGISTRY: 'true' })).toBe(true);
    });

    test('is case-insensitive', () => {
      expect(isRegistryEnabled({ KHY_FLAG_REGISTRY: 'FALSE' })).toBe(false);
      expect(isRegistryEnabled({ KHY_FLAG_REGISTRY: 'Off' })).toBe(false);
    });

    test('returns true on error (conservative)', () => {
      expect(isRegistryEnabled(null)).toBe(true);
    });
  });

  describe('isFlagEnabled', () => {
    test('returns true for unknown flags (conservative)', () => {
      expect(isFlagEnabled('KHY_UNKNOWN_FLAG', {})).toBe(true);
    });

    test('returns default for known flags when not set', () => {
      expect(isFlagEnabled('KHY_GOAL', {})).toBe(true);
      expect(isFlagEnabled('KHY_GOAL_STOP_GATE', {})).toBe(true);
    });

    test('returns false when flag set to off values', () => {
      expect(isFlagEnabled('KHY_GOAL', { KHY_GOAL: '0' })).toBe(false);
      expect(isFlagEnabled('KHY_GOAL', { KHY_GOAL: 'false' })).toBe(false);
      expect(isFlagEnabled('KHY_GOAL', { KHY_GOAL: 'off' })).toBe(false);
      expect(isFlagEnabled('KHY_GOAL', { KHY_GOAL: 'no' })).toBe(false);
    });

    test('is case-insensitive for default-on flags', () => {
      expect(isFlagEnabled('KHY_GOAL', { KHY_GOAL: 'FALSE' })).toBe(false);
      expect(isFlagEnabled('KHY_GOAL', { KHY_GOAL: 'Off' })).toBe(false);
    });

    test('respects parent-child priority', () => {
      // Parent off -> child off even if child is on
      expect(isFlagEnabled('KHY_GOAL_STOP_GATE', { KHY_GOAL: '0', KHY_GOAL_STOP_GATE: '1' })).toBe(false);
      // Parent on -> child follows its own value
      expect(isFlagEnabled('KHY_GOAL_STOP_GATE', { KHY_GOAL: '1', KHY_GOAL_STOP_GATE: '0' })).toBe(false);
      expect(isFlagEnabled('KHY_GOAL_STOP_GATE', { KHY_GOAL: '1', KHY_GOAL_STOP_GATE: '1' })).toBe(true);
    });

    test('handles grandparent chain', () => {
      // Grandparent off -> all descendants off
      expect(isFlagEnabled('KHY_GOAL_EVIDENCE_GATE', { KHY_GOAL: '0' })).toBe(false);
      expect(isFlagEnabled('KHY_GOAL_EVIDENCE_GATE', { KHY_GOAL: '1', KHY_GOAL_STOP_GATE: '0' })).toBe(false);
    });

    test('handles EXTENDED off words', () => {
      expect(isFlagEnabled('KHY_TOOL_CONTRACT', { KHY_TOOL_CONTRACT: 'disable' })).toBe(false);
      expect(isFlagEnabled('KHY_TOOL_CONTRACT', { KHY_TOOL_CONTRACT: 'disabled' })).toBe(false);
    });

    test('handles MINIMAL off words', () => {
      expect(isFlagEnabled('KHY_PLAN_PRIORITY', { KHY_PLAN_PRIORITY: '0' })).toBe(false);
      expect(isFlagEnabled('KHY_PLAN_PRIORITY', { KHY_PLAN_PRIORITY: 'false' })).toBe(false);
      expect(isFlagEnabled('KHY_PLAN_PRIORITY', { KHY_PLAN_PRIORITY: 'off' })).toBe(false);
    });

    test('handles normalize=false (case-sensitive)', () => {
      // With normalize=false, 'OFF' should NOT match (case-sensitive)
      expect(isFlagEnabled('KHY_PLAN_PRIORITY', { KHY_PLAN_PRIORITY: 'OFF' })).toBe(true);
      // lowercase 'off' should match
      expect(isFlagEnabled('KHY_PLAN_PRIORITY', { KHY_PLAN_PRIORITY: 'off' })).toBe(false);
    });

    test('handles opt-in mode', () => {
      expect(isFlagEnabled('KHY_PROXY_CORE', { KHY_PROXY_CORE: 'true' })).toBe(true);
      expect(isFlagEnabled('KHY_PROXY_CORE', { KHY_PROXY_CORE: '1' })).toBe(true);
      expect(isFlagEnabled('KHY_PROXY_CORE', { KHY_PROXY_CORE: 'false' })).toBe(false);
      expect(isFlagEnabled('KHY_PROXY_CORE', {})).toBe(false);
    });

    test('handles numeric mode (always true for boolean check)', () => {
      expect(isFlagEnabled('KHY_FS_WALK_BUDGET_MS', { KHY_FS_WALK_BUDGET_MS: '5000' })).toBe(true);
    });

    test('returns true on error (conservative)', () => {
      expect(isFlagEnabled('KHY_GOAL', null)).toBe(true);
    });
  });

  describe('resolveNumeric', () => {
    test('returns numeric value', () => {
      expect(resolveNumeric('KHY_FS_WALK_BUDGET_MS', { KHY_FS_WALK_BUDGET_MS: '5000' })).toBe(5000);
    });

    test('returns default when not set', () => {
      expect(resolveNumeric('KHY_FS_WALK_BUDGET_MS', {})).toBe(8000);
    });

    test('returns default for non-numeric flags', () => {
      expect(resolveNumeric('KHY_GOAL', { KHY_GOAL: '1' })).toBe(0);
    });

    test('clamps to min', () => {
      expect(resolveNumeric('KHY_FS_WALK_BUDGET_MS', { KHY_FS_WALK_BUDGET_MS: '100' })).toBe(250);
    });

    test('clamps to max', () => {
      expect(resolveNumeric('KHY_FS_WALK_BUDGET_MS', { KHY_FS_WALK_BUDGET_MS: '99999999' })).toBe(600000);
    });

    test('returns fallback for invalid values', () => {
      expect(resolveNumeric('KHY_FS_WALK_BUDGET_MS', { KHY_FS_WALK_BUDGET_MS: 'abc' })).toBe(8000);
      expect(resolveNumeric('KHY_FS_WALK_BUDGET_MS', { KHY_FS_WALK_BUDGET_MS: '' })).toBe(8000);
    });

    test('handles null/undefined env', () => {
      expect(resolveNumeric('KHY_FS_WALK_BUDGET_MS', null)).toBe(8000);
      expect(resolveNumeric('KHY_FS_WALK_BUDGET_MS', undefined)).toBe(8000);
    });

    test('handles negative numbers', () => {
      expect(resolveNumeric('KHY_FS_WALK_BUDGET_MS', { KHY_FS_WALK_BUDGET_MS: '-5' })).toBe(8000);
    });

    test('handles float values', () => {
      expect(resolveNumeric('KHY_FS_WALK_BUDGET_MS', { KHY_FS_WALK_BUDGET_MS: '5000.5' })).toBe(5000);
    });
  });

  describe('listFlags', () => {
    test('returns array of flag names', () => {
      const flags = listFlags();
      expect(Array.isArray(flags)).toBe(true);
      expect(flags.length).toBeGreaterThan(0);
    });

    test('flags are sorted alphabetically', () => {
      const flags = listFlags();
      const names = flags.map(f => f.name);
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    });

    test('each flag has name property', () => {
      const flags = listFlags();
      flags.forEach(f => {
        expect(f).toHaveProperty('name');
        expect(typeof f.name).toBe('string');
      });
    });

    test('returns copies (not references)', () => {
      const flags1 = listFlags();
      flags1[0].name = 'MODIFIED';
      const flags2 = listFlags();
      expect(flags2[0].name).not.toBe('MODIFIED');
    });
  });

  describe('OFF_WORDS', () => {
    test('has CANON dialect', () => {
      expect(OFF_WORDS.CANON).toEqual(['0', 'false', 'off', 'no']);
    });

    test('has EXTENDED dialect', () => {
      expect(OFF_WORDS.EXTENDED).toEqual(['0', 'false', 'off', 'no', 'disable', 'disabled']);
    });

    test('has MINIMAL dialect', () => {
      expect(OFF_WORDS.MINIMAL).toEqual(['0', 'false', 'off']);
    });
  });

  describe('FLAGS', () => {
    test('contains KHY_GOAL', () => {
      expect(FLAGS.KHY_GOAL).toEqual({ mode: 'default-on', off: 'CANON', default: true });
    });

    test('contains KHY_GOAL_STOP_GATE with parent', () => {
      expect(FLAGS.KHY_GOAL_STOP_GATE.parent).toBe('KHY_GOAL');
    });

    test('contains numeric flag KHY_FS_WALK_BUDGET_MS', () => {
      expect(FLAGS.KHY_FS_WALK_BUDGET_MS.mode).toBe('numeric');
      expect(FLAGS.KHY_FS_WALK_BUDGET_MS.min).toBe(250);
      expect(FLAGS.KHY_FS_WALK_BUDGET_MS.max).toBe(600000);
    });

    test('contains opt-in flag KHY_PROXY_CORE', () => {
      expect(FLAGS.KHY_PROXY_CORE.mode).toBe('opt-in');
    });

    test('contains normalize=false flag KHY_PLAN_PRIORITY', () => {
      expect(FLAGS.KHY_PLAN_PRIORITY.normalize).toBe(false);
    });
  });
});

