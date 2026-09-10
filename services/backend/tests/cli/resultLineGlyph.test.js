'use strict';

const { resultElbowEnabled, resultLineLead } = require('../../src/cli/resultLineGlyph');

describe('resultLineGlyph', () => {
  describe('resultElbowEnabled', () => {
    test('returns true when env not set', () => {
      expect(resultElbowEnabled({})).toBe(true);
    });

    test('returns true for empty string', () => {
      expect(resultElbowEnabled({ KHY_RESULT_ELBOW: '' })).toBe(true);
    });

    test('returns true for whitespace', () => {
      expect(resultElbowEnabled({ KHY_RESULT_ELBOW: '   ' })).toBe(true);
    });

    test('returns true for "1"', () => {
      expect(resultElbowEnabled({ KHY_RESULT_ELBOW: '1' })).toBe(true);
    });

    test('returns true for "true"', () => {
      expect(resultElbowEnabled({ KHY_RESULT_ELBOW: 'true' })).toBe(true);
    });

    test('returns false for "0"', () => {
      expect(resultElbowEnabled({ KHY_RESULT_ELBOW: '0' })).toBe(false);
    });

    test('returns false for "false"', () => {
      expect(resultElbowEnabled({ KHY_RESULT_ELBOW: 'false' })).toBe(false);
    });

    test('returns false for "off"', () => {
      expect(resultElbowEnabled({ KHY_RESULT_ELBOW: 'off' })).toBe(false);
    });

    test('returns false for "no"', () => {
      expect(resultElbowEnabled({ KHY_RESULT_ELBOW: 'no' })).toBe(false);
    });

    test('case insensitive', () => {
      expect(resultElbowEnabled({ KHY_RESULT_ELBOW: 'FALSE' })).toBe(false);
      expect(resultElbowEnabled({ KHY_RESULT_ELBOW: 'Off' })).toBe(false);
      expect(resultElbowEnabled({ KHY_RESULT_ELBOW: 'NO' })).toBe(false);
    });

    test('trims whitespace', () => {
      expect(resultElbowEnabled({ KHY_RESULT_ELBOW: '  false  ' })).toBe(false);
    });

    test('defaults to process.env when no arg', () => {
      expect(typeof resultElbowEnabled()).toBe('boolean');
    });
  });

  describe('resultLineLead', () => {
    test('returns elbow glyph when enabled', () => {
      const result = resultLineLead({});
      expect(result.glyph).toBe('âŽ?');
      expect(result.color).toBeUndefined();
      expect(result.dim).toBe(true);
    });

    test('returns legacy glyph when disabled', () => {
      const result = resultLineLead({ KHY_RESULT_ELBOW: '0' });
      expect(result.glyph).toBe('âœ?');
      expect(result.color).toBe('green');
      expect(result.dim).toBe(true);
    });

    test('defaults to process.env when no arg', () => {
      const result = resultLineLead();
      expect(result).toHaveProperty('glyph');
      expect(result).toHaveProperty('color');
      expect(result).toHaveProperty('dim');
    });
  });
});

