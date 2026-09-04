'use strict';

const {
  getOutputStyleConfig,
  getActiveOutputStyleName,
  isValidStyleName,
  BUILT_IN_STYLES,
  STYLE_OFF_VALUES,
} = require('../../src/constants/outputStyles');

describe('outputStyles', () => {
  describe('BUILT_IN_STYLES', () => {
    test('contains senior-engineer style', () => {
      expect(BUILT_IN_STYLES['senior-engineer']).toBeDefined();
      expect(BUILT_IN_STYLES['senior-engineer'].name).toBe('senior-engineer');
      expect(BUILT_IN_STYLES['senior-engineer'].prompt).toContain('senior software engineer');
      expect(BUILT_IN_STYLES['senior-engineer'].keepCodingInstructions).toBe(true);
    });

    test('contains concise style', () => {
      expect(BUILT_IN_STYLES.concise).toBeDefined();
      expect(BUILT_IN_STYLES.concise.name).toBe('concise');
      expect(BUILT_IN_STYLES.concise.prompt).toContain('extremely concise');
    });

    test('contains verbose style', () => {
      expect(BUILT_IN_STYLES.verbose).toBeDefined();
      expect(BUILT_IN_STYLES.verbose.name).toBe('verbose');
      expect(BUILT_IN_STYLES.verbose.prompt).toContain('detailed');
    });

    test('contains code-only style', () => {
      expect(BUILT_IN_STYLES['code-only']).toBeDefined();
      expect(BUILT_IN_STYLES['code-only'].name).toBe('code-only');
      expect(BUILT_IN_STYLES['code-only'].prompt).toContain('code only');
    });
  });

  describe('STYLE_OFF_VALUES', () => {
    test('contains expected off values', () => {
      expect(STYLE_OFF_VALUES).toContain('off');
      expect(STYLE_OFF_VALUES).toContain('none');
      expect(STYLE_OFF_VALUES).toContain('false');
      expect(STYLE_OFF_VALUES).toContain('0');
    });
  });

  describe('getActiveOutputStyleName', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    test('returns senior-engineer by default', () => {
      delete process.env.KHY_OUTPUT_STYLE;
      expect(getActiveOutputStyleName()).toBe('senior-engineer');
    });

    test('returns env value when set', () => {
      process.env.KHY_OUTPUT_STYLE = 'concise';
      expect(getActiveOutputStyleName()).toBe('concise');
    });

    test('returns senior-engineer for empty string', () => {
      process.env.KHY_OUTPUT_STYLE = '';
      expect(getActiveOutputStyleName()).toBe('senior-engineer');
    });

    test('trims whitespace', () => {
      process.env.KHY_OUTPUT_STYLE = '  verbose  ';
      expect(getActiveOutputStyleName()).toBe('verbose');
    });
  });

  describe('isValidStyleName', () => {
    test('returns false for empty', () => {
      expect(isValidStyleName('')).toBe(false);
      expect(isValidStyleName(null)).toBe(false);
      expect(isValidStyleName(undefined)).toBe(false);
    });

    test('returns true for off values', () => {
      expect(isValidStyleName('off')).toBe(true);
      expect(isValidStyleName('none')).toBe(true);
      expect(isValidStyleName('false')).toBe(true);
      expect(isValidStyleName('0')).toBe(true);
    });

    test('returns true for built-in styles', () => {
      expect(isValidStyleName('senior-engineer')).toBe(true);
      expect(isValidStyleName('concise')).toBe(true);
      expect(isValidStyleName('verbose')).toBe(true);
      expect(isValidStyleName('code-only')).toBe(true);
    });

    test('is case-insensitive for built-in styles', () => {
      expect(isValidStyleName('CONCISE')).toBe(true);
      expect(isValidStyleName('Senior-Engineer')).toBe(true);
    });

    test('returns false for unknown styles', () => {
      expect(isValidStyleName('unknown-style')).toBe(false);
    });
  });

  describe('getOutputStyleConfig', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    test('returns null when no style name', async () => {
      delete process.env.KHY_OUTPUT_STYLE;
      const result = await getOutputStyleConfig();
      expect(result).toBeNull();
    });

    test('returns null for empty string', async () => {
      const result = await getOutputStyleConfig('');
      expect(result).toBeNull();
    });

    test('returns built-in style config', async () => {
      const result = await getOutputStyleConfig('concise');
      expect(result).toBeDefined();
      expect(result.name).toBe('concise');
      expect(result.prompt).toBeDefined();
      expect(result.keepCodingInstructions).toBe(true);
    });

    test('returns null for unknown style', async () => {
      const result = await getOutputStyleConfig('unknown-style');
      expect(result).toBeNull();
    });
  });
});
