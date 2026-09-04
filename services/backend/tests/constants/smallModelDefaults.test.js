'use strict';

const {
  RETRY_BUDGET_DEFAULTS,
  FEW_SHOT_COUNT_DEFAULTS,
  ESCALATION_THRESHOLD_DEFAULTS,
  MAX_ESCALATIONS_DEFAULT,
  CARRYFORWARD_TOKEN_DEFAULTS,
  MICRO_DESCRIPTION_MAX_CHARS_DEFAULT,
  SCHEMA_LEVELS,
  getRetryBudgets,
  getRetryBudget,
  getFewShotCounts,
  getFewShotCount,
  getEscalationThresholds,
  getMaxEscalations,
  getCarryForwardTokenBudgets,
  getMicroDescriptionMaxChars,
  resolveSchemaLevel,
} = require('../../src/constants/smallModelDefaults');

describe('smallModelDefaults', () => {
  describe('default constants', () => {
    test('RETRY_BUDGET_DEFAULTS has correct values', () => {
      expect(RETRY_BUDGET_DEFAULTS).toEqual({ T3: 3, T2: 2, T1: 1, T0: 0 });
    });

    test('FEW_SHOT_COUNT_DEFAULTS has correct values', () => {
      expect(FEW_SHOT_COUNT_DEFAULTS).toEqual({ T3: 2, T2: 1, T1: 0, T0: 0 });
    });

    test('ESCALATION_THRESHOLD_DEFAULTS has correct values', () => {
      expect(ESCALATION_THRESHOLD_DEFAULTS).toEqual({
        toolFailureCount: 3,
        paramCorrectionRetries: 2,
        selfCheckFailures: 1,
        emptyReplyCount: 2,
      });
    });

    test('MAX_ESCALATIONS_DEFAULT is 2', () => {
      expect(MAX_ESCALATIONS_DEFAULT).toBe(2);
    });

    test('CARRYFORWARD_TOKEN_DEFAULTS has correct values', () => {
      expect(CARRYFORWARD_TOKEN_DEFAULTS).toEqual({ summary: 500, carryforward: 2000 });
    });

    test('MICRO_DESCRIPTION_MAX_CHARS_DEFAULT is 80', () => {
      expect(MICRO_DESCRIPTION_MAX_CHARS_DEFAULT).toBe(80);
    });

    test('SCHEMA_LEVELS contains expected values', () => {
      expect(SCHEMA_LEVELS).toEqual(['full', 'small', 'micro']);
    });
  });

  describe('getRetryBudgets', () => {
    test('returns defaults when no env', () => {
      expect(getRetryBudgets({})).toEqual(RETRY_BUDGET_DEFAULTS);
    });

    test('merges partial env override', () => {
      const result = getRetryBudgets({ KHY_SMALL_MODEL_RETRY_BUDGET: '{"T3":5}' });
      expect(result.T3).toBe(5);
      expect(result.T2).toBe(2);
    });

    test('ignores invalid JSON', () => {
      const result = getRetryBudgets({ KHY_SMALL_MODEL_RETRY_BUDGET: 'invalid' });
      expect(result).toEqual(RETRY_BUDGET_DEFAULTS);
    });

    test('ignores negative values', () => {
      const result = getRetryBudgets({ KHY_SMALL_MODEL_RETRY_BUDGET: '{"T3":-1}' });
      expect(result.T3).toBe(3);
    });
  });

  describe('getRetryBudget', () => {
    test('returns budget for known tier', () => {
      expect(getRetryBudget('T3', {})).toBe(3);
      expect(getRetryBudget('T2', {})).toBe(2);
      expect(getRetryBudget('T1', {})).toBe(1);
      expect(getRetryBudget('T0', {})).toBe(0);
    });

    test('returns T2 for unknown tier', () => {
      expect(getRetryBudget('T99', {})).toBe(2);
    });

    test('respects env override', () => {
      expect(getRetryBudget('T3', { KHY_SMALL_MODEL_RETRY_BUDGET: '{"T3":10}' })).toBe(10);
    });
  });

  describe('getFewShotCounts', () => {
    test('returns defaults when no env', () => {
      expect(getFewShotCounts({})).toEqual(FEW_SHOT_COUNT_DEFAULTS);
    });

    test('merges partial env override', () => {
      const result = getFewShotCounts({ KHY_SMALL_MODEL_FEW_SHOT_COUNT: '{"T3":5}' });
      expect(result.T3).toBe(5);
      expect(result.T2).toBe(1);
    });
  });

  describe('getFewShotCount', () => {
    test('returns count for known tier', () => {
      expect(getFewShotCount('T3', {})).toBe(2);
      expect(getFewShotCount('T2', {})).toBe(1);
    });

    test('returns 0 for unknown tier', () => {
      expect(getFewShotCount('T99', {})).toBe(0);
    });
  });

  describe('getEscalationThresholds', () => {
    test('returns defaults when no env', () => {
      expect(getEscalationThresholds({})).toEqual(ESCALATION_THRESHOLD_DEFAULTS);
    });

    test('merges partial env override', () => {
      const result = getEscalationThresholds({ KHY_SMALL_MODEL_ESCALATION_THRESHOLDS: '{"toolFailureCount":10}' });
      expect(result.toolFailureCount).toBe(10);
      expect(result.paramCorrectionRetries).toBe(2);
    });
  });

  describe('getMaxEscalations', () => {
    test('returns default when no env', () => {
      expect(getMaxEscalations({})).toBe(2);
    });

    test('returns env value when set', () => {
      expect(getMaxEscalations({ KHY_SMALL_MODEL_MAX_ESCALATIONS: '5' })).toBe(5);
    });

    test('returns default for invalid value', () => {
      expect(getMaxEscalations({ KHY_SMALL_MODEL_MAX_ESCALATIONS: 'invalid' })).toBe(2);
    });

    test('returns default for negative value', () => {
      expect(getMaxEscalations({ KHY_SMALL_MODEL_MAX_ESCALATIONS: '-1' })).toBe(2);
    });
  });

  describe('getCarryForwardTokenBudgets', () => {
    test('returns defaults when no env', () => {
      expect(getCarryForwardTokenBudgets({})).toEqual(CARRYFORWARD_TOKEN_DEFAULTS);
    });

    test('merges JSON env override', () => {
      const result = getCarryForwardTokenBudgets({ KHY_SMALL_MODEL_CARRYFORWARD_TOKENS: '{"summary":1000}' });
      expect(result.summary).toBe(1000);
      expect(result.carryforward).toBe(2000);
    });

    test('respects scalar summary override', () => {
      const result = getCarryForwardTokenBudgets({ KHY_SMALL_MODEL_SUMMARY_TOKENS: '1500' });
      expect(result.summary).toBe(1500);
    });

    test('respects scalar carryforward override', () => {
      const result = getCarryForwardTokenBudgets({ KHY_SMALL_MODEL_CARRYFORWARD_BUDGET: '3000' });
      expect(result.carryforward).toBe(3000);
    });
  });

  describe('getMicroDescriptionMaxChars', () => {
    test('returns default when no env', () => {
      expect(getMicroDescriptionMaxChars({})).toBe(80);
    });

    test('returns env value when set', () => {
      expect(getMicroDescriptionMaxChars({ KHY_SMALL_MODEL_MICRO_DESC_MAX: '120' })).toBe(120);
    });

    test('returns default for zero', () => {
      expect(getMicroDescriptionMaxChars({ KHY_SMALL_MODEL_MICRO_DESC_MAX: '0' })).toBe(80);
    });

    test('returns default for negative', () => {
      expect(getMicroDescriptionMaxChars({ KHY_SMALL_MODEL_MICRO_DESC_MAX: '-1' })).toBe(80);
    });
  });

  describe('resolveSchemaLevel', () => {
    test('returns forced level from env', () => {
      expect(resolveSchemaLevel('T3', false, { KHY_SMALL_MODEL_SCHEMA_LEVEL: 'micro' })).toBe('micro');
      expect(resolveSchemaLevel('T0', false, { KHY_SMALL_MODEL_SCHEMA_LEVEL: 'full' })).toBe('full');
    });

    test('ignores invalid forced level', () => {
      expect(resolveSchemaLevel('T3', false, { KHY_SMALL_MODEL_SCHEMA_LEVEL: 'invalid' })).toBe('small');
    });

    test('returns micro for T3 with shortContext', () => {
      expect(resolveSchemaLevel('T3', true, {})).toBe('micro');
    });

    test('returns small for T3 without shortContext', () => {
      expect(resolveSchemaLevel('T3', false, {})).toBe('small');
    });

    test('returns small for T2 with shortContext', () => {
      expect(resolveSchemaLevel('T2', true, {})).toBe('small');
    });

    test('returns full for T2 without shortContext', () => {
      expect(resolveSchemaLevel('T2', false, {})).toBe('full');
    });

    test('returns full for T1', () => {
      expect(resolveSchemaLevel('T1', false, {})).toBe('full');
    });

    test('returns full for T0', () => {
      expect(resolveSchemaLevel('T0', false, {})).toBe('full');
    });
  });
});
