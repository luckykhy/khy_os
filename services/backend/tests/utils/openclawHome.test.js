'use strict';

const { openclawStateDir } = require('../../src/utils/openclawHome');

describe('openclawHome', () => {
  describe('openclawStateDir', () => {
    test('returns KHY_OPENCLAW_DATA_HOME when set', () => {
      const result = openclawStateDir({ homedir: '/home/user', env: { KHY_OPENCLAW_DATA_HOME: '/custom/path' } });
      expect(result).toBe('/custom/path');
    });

    test('returns OPENCLAW_STATE_DIR when KHY override not set', () => {
      const result = openclawStateDir({ homedir: '/home/user', env: { OPENCLAW_STATE_DIR: '/openclaw/path' } });
      expect(result).toBe('/openclaw/path');
    });

    test('returns default .openclaw when no override', () => {
      const result = openclawStateDir({ homedir: '/home/user', env: {} });
      expect(result).toContain('.openclaw');
    });

    test('includes profile when set', () => {
      const result = openclawStateDir({ homedir: '/home/user', env: { KHY_OPENCLAW_PROFILE: 'work' } });
      expect(result).toContain('.openclaw-work');
    });

    test('returns empty string when no homedir and no override', () => {
      expect(openclawStateDir({ homedir: '', env: {} })).toBe('');
    });

    test('returns empty string for null input', () => {
      expect(openclawStateDir({})).toBe('');
    });
  });
});

