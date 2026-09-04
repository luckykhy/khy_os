'use strict';

const {
  clampInt,
  pickEnum,
  normalizeCapabilityMatrix,
  normalizeStyleProfile,
  normalizeStringList,
  mergeProfiles,
  calculateSpecialtyMatch,
  matchWhen,
  styleDistance,
  normalizeProfile,
  isPlainObject,
} = require('../../src/utils/styleMatchers');

describe('styleMatchers', () => {
  describe('clampInt', () => {
    test('clamps value within range', () => {
      expect(clampInt(5, 0, 10, 0)).toBe(5);
    });

    test('clamps value below lower bound', () => {
      expect(clampInt(-5, 0, 10, 0)).toBe(0);
    });

    test('clamps value above upper bound', () => {
      expect(clampInt(15, 0, 10, 0)).toBe(10);
    });

    test('returns fallback for non-finite', () => {
      expect(clampInt(NaN, 0, 10, 3)).toBe(3);
    });
  });

  describe('pickEnum', () => {
    test('returns valid enum value', () => {
      expect(pickEnum('concise', ['concise', 'detailed'], 'default')).toBe('concise');
    });

    test('returns fallback for invalid value', () => {
      expect(pickEnum('invalid', ['concise', 'detailed'], 'default')).toBe('default');
    });

    test('is case-insensitive', () => {
      expect(pickEnum('CONCISE', ['concise', 'detailed'], 'default')).toBe('concise');
    });
  });

  describe('normalizeCapabilityMatrix', () => {
    test('returns default matrix for empty input', () => {
      const result = normalizeCapabilityMatrix({});
      expect(result.text).toBe(3);
      expect(result.code).toBe(3);
    });

    test('clamps values to 0-5', () => {
      const result = normalizeCapabilityMatrix({ text: 10, code: -1 });
      expect(result.text).toBe(5);
      expect(result.code).toBe(0);
    });

    test('fills missing dimensions from base', () => {
      const result = normalizeCapabilityMatrix({}, { text: 4 });
      expect(result.text).toBe(4);
    });
  });

  describe('normalizeStyleProfile', () => {
    test('returns defaults for empty input', () => {
      const result = normalizeStyleProfile({});
      expect(result.prompt_preference).toBe('structured');
      expect(result.response_style).toBe('direct');
      expect(result.tool_usage_tendency).toBe('balanced');
      expect(result.scaffolding_comfort_level).toBe(5);
    });

    test('uses base for missing values', () => {
      const result = normalizeStyleProfile({}, { prompt_preference: 'concise' });
      expect(result.prompt_preference).toBe('concise');
    });
  });

  describe('normalizeStringList', () => {
    test('normalizes and deduplicates', () => {
      expect(normalizeStringList(['A', 'B', 'A'])).toEqual(['a', 'b']);
    });

    test('returns empty for non-array', () => {
      expect(normalizeStringList(null)).toEqual([]);
    });

    test('filters non-strings', () => {
      expect(normalizeStringList(['a', 1, 'b'])).toEqual(['a', 'b']);
    });
  });

  describe('mergeProfiles', () => {
    test('merges two profiles', () => {
      const base = { a: 1, b: { c: 2 } };
      const patch = { a: 3, b: { d: 4 } };
      const result = mergeProfiles(base, patch);
      expect(result.a).toBe(3);
      expect(result.b.c).toBe(2);
      expect(result.b.d).toBe(4);
    });

    test('handles union arrays', () => {
      const base = { strengths: ['a'] };
      const patch = { strengths: ['b'] };
      const result = mergeProfiles(base, patch);
      expect(result.strengths).toEqual(['a', 'b']);
    });

    test('returns base for non-object patch', () => {
      const base = { a: 1 };
      expect(mergeProfiles(base, null)).toEqual(base);
    });
  });

  describe('calculateSpecialtyMatch', () => {
    test('returns baseline for empty task', () => {
      expect(calculateSpecialtyMatch({}, '')).toBe(0.2);
    });

    test('increases for strengths', () => {
      const profile = { specialty_areas: { strengths: ['coding'] } };
      expect(calculateSpecialtyMatch(profile, 'coding')).toBeCloseTo(0.7);
    });

    test('decreases for weaknesses', () => {
      const profile = { specialty_areas: { weaknesses: ['coding'] } };
      expect(calculateSpecialtyMatch(profile, 'coding')).toBeCloseTo(0);
    });
  });

  describe('matchWhen', () => {
    test('returns true for empty when', () => {
      expect(matchWhen({}, {})).toBe(true);
    });

    test('matches task_type', () => {
      expect(matchWhen({ task_type: 'coding' }, { taskType: 'coding' })).toBe(true);
      expect(matchWhen({ task_type: 'coding' }, { taskType: 'writing' })).toBe(false);
    });

    test('matches context_tokens_gt', () => {
      expect(matchWhen({ context_tokens_gt: 100 }, { contextTokens: 200 })).toBe(true);
      expect(matchWhen({ context_tokens_gt: 100 }, { contextTokens: 50 })).toBe(false);
    });
  });

  describe('styleDistance', () => {
    test('returns 0 for empty prefs', () => {
      expect(styleDistance({}, {})).toBe(0);
    });

    test('calculates distance', () => {
      const profile = { style_profile: { prompt_preference: 'concise' } };
      const prefs = { promptPreference: 'detailed' };
      expect(styleDistance(profile, prefs)).toBeGreaterThan(0);
    });
  });

  describe('normalizeProfile', () => {
    test('returns complete profile for empty input', () => {
      const result = normalizeProfile({});
      expect(result.confidence).toBe('prior');
      expect(result.source).toBe('default');
      expect(result.capability_matrix).toBeDefined();
      expect(result.style_profile).toBeDefined();
    });

    test('preserves valid values', () => {
      const result = normalizeProfile({ confidence: 'measured' });
      expect(result.confidence).toBe('measured');
    });
  });

  describe('isPlainObject', () => {
    test('returns true for plain object', () => {
      expect(isPlainObject({})).toBe(true);
    });

    test('returns false for null', () => {
      expect(isPlainObject(null)).toBe(false);
    });

    test('returns false for array', () => {
      expect(isPlainObject([])).toBe(false);
    });
  });
});
