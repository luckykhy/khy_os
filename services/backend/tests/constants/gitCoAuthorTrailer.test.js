'use strict';

const {
  isEnabled,
  appendCoAuthorTrailer,
  resolveTrailerLine,
  DEFAULT_TRAILER,
} = require('../../src/constants/gitCoAuthorTrailer');

describe('gitCoAuthorTrailer', () => {
  describe('isEnabled', () => {
    test('returns true by default', () => {
      expect(isEnabled({})).toBe(true);
    });

    test('returns true for non-off values', () => {
      expect(isEnabled({ KHY_GIT_COAUTHOR_TRAILER: '1' })).toBe(true);
      expect(isEnabled({ KHY_GIT_COAUTHOR_TRAILER: 'true' })).toBe(true);
    });

    test('returns false for off values', () => {
      expect(isEnabled({ KHY_GIT_COAUTHOR_TRAILER: '0' })).toBe(false);
      expect(isEnabled({ KHY_GIT_COAUTHOR_TRAILER: 'false' })).toBe(false);
      expect(isEnabled({ KHY_GIT_COAUTHOR_TRAILER: 'off' })).toBe(false);
      expect(isEnabled({ KHY_GIT_COAUTHOR_TRAILER: 'no' })).toBe(false);
    });

    test('is case-insensitive', () => {
      expect(isEnabled({ KHY_GIT_COAUTHOR_TRAILER: 'FALSE' })).toBe(false);
    });
  });

  describe('resolveTrailerLine', () => {
    test('returns default trailer when no override', () => {
      expect(resolveTrailerLine({})).toBe(DEFAULT_TRAILER);
    });

    test('returns override when valid', () => {
      const custom = 'Co-Authored-By: Test <test@example.com>';
      expect(resolveTrailerLine({ KHY_GIT_COAUTHOR_TRAILER_LINE: custom })).toBe(custom);
    });

    test('returns default when override is invalid', () => {
      expect(resolveTrailerLine({ KHY_GIT_COAUTHOR_TRAILER_LINE: 'invalid' })).toBe(DEFAULT_TRAILER);
    });

    test('returns default when override is empty', () => {
      expect(resolveTrailerLine({ KHY_GIT_COAUTHOR_TRAILER_LINE: '' })).toBe(DEFAULT_TRAILER);
    });
  });

  describe('appendCoAuthorTrailer', () => {
    test('returns message as-is when disabled', () => {
      const message = 'feat: add feature';
      expect(appendCoAuthorTrailer(message, { KHY_GIT_COAUTHOR_TRAILER: '0' })).toBe(message);
    });

    test('appends trailer when enabled', () => {
      const message = 'feat: add feature';
      const result = appendCoAuthorTrailer(message, {});
      expect(result).toContain(message);
      expect(result).toContain(DEFAULT_TRAILER);
    });

    test('does not duplicate trailer', () => {
      const message = `feat: add feature\n\n${DEFAULT_TRAILER}`;
      const result = appendCoAuthorTrailer(message, {});
      expect(result).toBe(message);
    });

    test('trims trailing whitespace from body', () => {
      const message = 'feat: add feature   \n  ';
      const result = appendCoAuthorTrailer(message, {});
      expect(result).toContain('feat: add feature\n\n');
      expect(result).toContain(DEFAULT_TRAILER);
    });

    test('returns non-string input as-is', () => {
      expect(appendCoAuthorTrailer(null, {})).toBeNull();
      expect(appendCoAuthorTrailer(123, {})).toBe(123);
    });

    test('returns empty message as-is', () => {
      expect(appendCoAuthorTrailer('', {})).toBe('');
    });

    test('uses custom trailer when provided', () => {
      const custom = 'Co-Authored-By: AI <ai@example.com>';
      const message = 'feat: add feature';
      const result = appendCoAuthorTrailer(message, {
        KHY_GIT_COAUTHOR_TRAILER_LINE: custom,
      });
      expect(result).toContain(custom);
    });
  });

  describe('DEFAULT_TRAILER', () => {
    test('is a valid trailer line', () => {
      expect(DEFAULT_TRAILER).toMatch(/^Co-Authored-By:\s*.+<.+>$/);
    });
  });
});
