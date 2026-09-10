'use strict';

const { editStatLineEnabled, buildEditStatLine } = require('../../src/cli/editStatLine');

describe('editStatLine', () => {
  describe('editStatLineEnabled', () => {
    test('returns true by default', () => {
      expect(editStatLineEnabled({})).toBe(true);
    });

    test('returns false when disabled', () => {
      expect(editStatLineEnabled({ KHY_EDIT_STAT_LINE: '0' })).toBe(false);
      expect(editStatLineEnabled({ KHY_EDIT_STAT_LINE: 'false' })).toBe(false);
    });
  });

  describe('buildEditStatLine', () => {
    test('formats additions only', () => {
      expect(buildEditStatLine(3, 0)).toBe('Added 3 lines');
    });

    test('formats removals only with capital R', () => {
      expect(buildEditStatLine(0, 2)).toBe('Removed 2 lines');
    });

    test('formats both additions and removals', () => {
      expect(buildEditStatLine(3, 1)).toBe('Added 3 lines, removed 1 line');
    });

    test('handles singular', () => {
      expect(buildEditStatLine(1, 1)).toBe('Added 1 line, removed 1 line');
    });

    test('returns empty when both zero', () => {
      expect(buildEditStatLine(0, 0)).toBe('');
    });

    test('handles negative values', () => {
      expect(buildEditStatLine(-1, -1)).toBe('');
    });

    test('uses lowercase when disabled', () => {
      const result = buildEditStatLine(0, 2, { KHY_EDIT_STAT_LINE: '0' });
      expect(result).toBe('removed 2 lines');
    });
  });
});

