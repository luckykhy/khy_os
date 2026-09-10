'use strict';

const { cronStepGuardEnabled, cronStepUsable } = require('../../src/services/cronStepGuard');

describe('cronStepGuard', () => {
  describe('cronStepGuardEnabled', () => {
    test('returns true by default', () => {
      expect(cronStepGuardEnabled({}).toBe(true);
    });

    test('returns false when disabled', () => {
      expect(cronStepGuardEnabled({ KHY_CRON_STEP_GUARD: '0' }).toBe(false);
    });
  });

  describe('cronStepUsable', () => {
    test('returns true for positive integer', () => {
      expect(cronStepUsable(5, {}).toBe(true);
    });

    test('returns false for zero', () => {
      expect(cronStepUsable(0, {}).toBe(false);
    });

    test('returns false for negative', () => {
      expect(cronStepUsable(-1, {}).toBe(false);
    });

    test('returns false for non-integer', () => {
      expect(cronStepUsable(1.5, {}).toBe(false);
    });

    test('returns null when disabled', () => {
      expect(cronStepUsable(5, { KHY_CRON_STEP_GUARD: '0' }).toBeNull();
    });
  });
});

