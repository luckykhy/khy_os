'use strict';

const {
  getCommandSchema,
  getRouterCommandNames,
  getRouterSubCommands,
  getBuiltinSlashCommands,
  getStaticSlashCommands,
  getCommandAliases,
  inferCategory,
} = require('../../src/constants/commandSchema');

describe('commandSchema', () => {
  describe('getRouterCommandNames', () => {
    test('returns array of command names', () => {
      const result = getRouterCommandNames();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('ai');
      expect(result).toContain('gateway');
      expect(result).toContain('help');
    });

    test('returns a copy (not original)', () => {
      const result = getRouterCommandNames();
      result.push('test');
      const result2 = getRouterCommandNames();
      expect(result2).not.toContain('test');
    });
  });

  describe('getRouterSubCommands', () => {
    test('returns object with sub-commands', () => {
      const result = getRouterSubCommands();
      expect(typeof result).toBe('object');
      expect(result.ai).toBeDefined();
      expect(result.gateway).toBeDefined();
    });

    test('returns copies (not originals)', () => {
      const result = getRouterSubCommands();
      result.ai.push('test');
      const result2 = getRouterSubCommands();
      expect(result2.ai).not.toContain('test');
    });
  });

  describe('getBuiltinSlashCommands', () => {
    test('returns array of slash commands', () => {
      const result = getBuiltinSlashCommands();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    test('each command has required fields', () => {
      const result = getBuiltinSlashCommands();
      for (const cmd of result) {
        expect(cmd).toHaveProperty('cmd');
        expect(cmd).toHaveProperty('category');
      }
    });
  });

  describe('getStaticSlashCommands', () => {
    test('returns same as getBuiltinSlashCommands', () => {
      const result = getStaticSlashCommands();
      expect(result).toEqual(getBuiltinSlashCommands());
    });
  });

  describe('getCommandSchema', () => {
    test('returns array of command schema objects', () => {
      const result = getCommandSchema();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    test('each entry has required fields', () => {
      const result = getCommandSchema();
      for (const entry of result) {
        expect(entry).toHaveProperty('name');
        expect(entry).toHaveProperty('subCommands');
        expect(entry).toHaveProperty('category');
      }
    });

    test('contains known commands', () => {
      const result = getCommandSchema();
      const names = result.map(e => e.name);
      expect(names).toContain('ai');
      expect(names).toContain('gateway');
    });
  });

  describe('getCommandAliases', () => {
    test('returns object of aliases', () => {
      const result = getCommandAliases();
      expect(typeof result).toBe('object');
    });
  });

  describe('inferCategory', () => {
    test('returns category for known command', () => {
      expect(inferCategory('ai')).toBeDefined();
      expect(typeof inferCategory('ai')).toBe('string');
    });

    test('returns system for unknown command', () => {
      expect(inferCategory('unknown-command')).toBe('system');
    });

    test('returns system for empty string', () => {
      expect(inferCategory('')).toBe('system');
    });

    test('returns system for null/undefined', () => {
      expect(inferCategory(null)).toBe('system');
      expect(inferCategory(undefined)).toBe('system');
    });

    test('trims whitespace', () => {
      expect(inferCategory('  ai  ')).toBe(inferCategory('ai'));
    });
  });
});
