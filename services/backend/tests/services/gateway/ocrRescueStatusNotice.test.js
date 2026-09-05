'use strict';

const {
  isRescueStatusEnabled,
  buildOcrRescueStatus,
  isRescuePrepStatusEnabled,
  buildOcrRescuePrepStatus,
  isPrepClosureDedupEnabled,
  shouldSuppressPrepForClosure,
} = require('../../src/services/gateway/ocrRescueStatusNotice');

// Mock flagRegistry
jest.mock('../../src/services/flagRegistry', () => ({
  isFlagEnabled: jest.fn((flag, env) => {
    const offFlags = ['KHY_OCR_RESCUE_STATUS', 'KHY_OCR_RESCUE_STATUS_PREP', 'KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP'];
    if (offFlags.includes(flag) && env && env[flag] === '0') {
      return false;
    }
    return true;
  }),
}));

describe('ocrRescueStatusNotice', () => {
  describe('isRescueStatusEnabled', () => {
    test('returns true by default', () => {
      expect(isRescueStatusEnabled({})).toBe(true);
    });

    test('returns false when flag is off', () => {
      expect(isRescueStatusEnabled({ KHY_OCR_RESCUE_STATUS: '0' })).toBe(false);
    });
  });

  describe('buildOcrRescueStatus', () => {
    test('returns null when disabled', () => {
      expect(buildOcrRescueStatus({ count: 5, env: { KHY_OCR_RESCUE_STATUS: '0' } })).toBeNull();
    });

    test('returns null for invalid count', () => {
      expect(buildOcrRescueStatus({ count: 0, env: {} })).toBeNull();
      expect(buildOcrRescueStatus({ count: -1, env: {} })).toBeNull();
    });

    test('builds status for single image', () => {
      const result = buildOcrRescueStatus({ count: 1, adapterName: 'test-adapter', env: {} });
      expect(result).toContain('1 张图片');
      expect(result).toContain('test-adapter');
    });

    test('builds status for multiple images', () => {
      const result = buildOcrRescueStatus({ count: 3, adapterName: 'test-adapter', env: {} });
      expect(result).toContain('3 张图片');
    });
  });

  describe('isRescuePrepStatusEnabled', () => {
    test('returns true by default', () => {
      expect(isRescuePrepStatusEnabled({})).toBe(true);
    });

    test('returns false when flag is off', () => {
      expect(isRescuePrepStatusEnabled({ KHY_OCR_RESCUE_STATUS_PREP: '0' })).toBe(false);
    });
  });

  describe('buildOcrRescuePrepStatus', () => {
    test('returns null when disabled', () => {
      expect(buildOcrRescuePrepStatus({ count: 5, env: { KHY_OCR_RESCUE_STATUS_PREP: '0' } })).toBeNull();
    });

    test('builds prep status', () => {
      const result = buildOcrRescuePrepStatus({ count: 2, modelName: 'test-model', env: {} });
      expect(result).toContain('2 张图片');
      expect(result).toContain('test-model');
    });
  });

  describe('isPrepClosureDedupEnabled', () => {
    test('returns true by default', () => {
      expect(isPrepClosureDedupEnabled({})).toBe(true);
    });
  });

  describe('shouldSuppressPrepForClosure', () => {
    test('returns false when disabled', () => {
      expect(shouldSuppressPrepForClosure({ intermediateEnabled: true, closureEnabled: true, env: { KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP: '0' } })).toBe(false);
    });

    test('returns true when both enabled', () => {
      expect(shouldSuppressPrepForClosure({ intermediateEnabled: true, closureEnabled: true, env: {} })).toBe(true);
    });

    test('returns false when intermediate disabled', () => {
      expect(shouldSuppressPrepForClosure({ intermediateEnabled: false, closureEnabled: true, env: {} })).toBe(false);
    });
  });
});
