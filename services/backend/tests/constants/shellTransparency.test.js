'use strict';

const {
  isEnabled,
  buildToolAvoidanceBlock,
  buildTransparencyItem,
  LEGACY_BLOCK,
  TRANSPARENT_BLOCK,
  TRANSPARENCY_ITEM,
} = require('../../src/constants/shellTransparency');

describe('shellTransparency', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('isEnabled', () => {
    test('returns true by default', () => {
      delete process.env.KHY_SHELL_TRANSPARENCY;
      expect(isEnabled()).toBe(true);
    });

    test('returns true for non-off values', () => {
      process.env.KHY_SHELL_TRANSPARENCY = '1';
      expect(isEnabled()).toBe(true);
      process.env.KHY_SHELL_TRANSPARENCY = 'true';
      expect(isEnabled()).toBe(true);
    });

    test('returns false for off values', () => {
      process.env.KHY_SHELL_TRANSPARENCY = '0';
      expect(isEnabled()).toBe(false);
      process.env.KHY_SHELL_TRANSPARENCY = 'false';
      expect(isEnabled()).toBe(false);
      process.env.KHY_SHELL_TRANSPARENCY = 'off';
      expect(isEnabled()).toBe(false);
      process.env.KHY_SHELL_TRANSPARENCY = 'no';
      expect(isEnabled()).toBe(false);
    });

    test('is case-insensitive', () => {
      process.env.KHY_SHELL_TRANSPARENCY = 'FALSE';
      expect(isEnabled()).toBe(false);
    });
  });

  describe('buildToolAvoidanceBlock', () => {
    test('returns transparent block when enabled', () => {
      delete process.env.KHY_SHELL_TRANSPARENCY;
      expect(buildToolAvoidanceBlock()).toBe(TRANSPARENT_BLOCK);
    });

    test('returns legacy block when disabled', () => {
      process.env.KHY_SHELL_TRANSPARENCY = '0';
      expect(buildToolAvoidanceBlock()).toBe(LEGACY_BLOCK);
    });
  });

  describe('buildTransparencyItem', () => {
    test('returns transparency item when enabled', () => {
      delete process.env.KHY_SHELL_TRANSPARENCY;
      expect(buildTransparencyItem()).toBe(TRANSPARENCY_ITEM);
    });

    test('returns null when disabled', () => {
      process.env.KHY_SHELL_TRANSPARENCY = '0';
      expect(buildTransparencyItem()).toBeNull();
    });
  });

  describe('LEGACY_BLOCK', () => {
    test('contains avoidance text', () => {
      expect(LEGACY_BLOCK).toContain('Avoid using this tool');
      expect(LEGACY_BLOCK).toContain('find, grep, cat, head, tail, sed, awk, or echo');
    });
  });

  describe('TRANSPARENT_BLOCK', () => {
    test('contains transparency text', () => {
      expect(TRANSPARENT_BLOCK).toContain('TRANSPARENCY');
      expect(TRANSPARENT_BLOCK).toContain('echo');
      expect(TRANSPARENT_BLOCK).toContain('head');
      expect(TRANSPARENT_BLOCK).toContain('tail');
    });
  });

  describe('TRANSPARENCY_ITEM', () => {
    test('is a string', () => {
      expect(typeof TRANSPARENCY_ITEM).toBe('string');
      expect(TRANSPARENCY_ITEM.length).toBeGreaterThan(0);
    });

    test('contains transparency guidance', () => {
      expect(TRANSPARENCY_ITEM).toContain('echo');
      expect(TRANSPARENCY_ITEM).toContain('head');
      expect(TRANSPARENCY_ITEM).toContain('tail');
    });
  });
});
