'use strict';

const registry = require('../../src/cli/commandRegistry');

describe('commandRegistry', () => {
  // Save and restore registry state between tests to avoid pollution
  const registeredBefore = [];

  describe('module exports', () => {
    test('exports register function', () => {
      expect(typeof registry.register).toBe('function');
    });

    test('exports registerBulk function', () => {
      expect(typeof registry.registerBulk).toBe('function');
    });

    test('exports getAll function', () => {
      expect(typeof registry.getAll).toBe('function');
    });

    test('exports getByCategory function', () => {
      expect(typeof registry.getByCategory).toBe('function');
    });

    test('exports getCompletions function', () => {
      expect(typeof registry.getCompletions).toBe('function');
    });

    test('exports PRIORITY and CATEGORIES objects', () => {
      expect(typeof registry.PRIORITY).toBe('object');
      expect(typeof registry.CATEGORIES).toBe('object');
    });
  });

  describe('PRIORITY', () => {
    test('builtin has highest priority', () => {
      expect(registry.PRIORITY.builtin).toBeGreaterThan(registry.PRIORITY.tool);
      expect(registry.PRIORITY.tool).toBeGreaterThan(registry.PRIORITY.plugin);
      expect(registry.PRIORITY.plugin).toBeGreaterThan(registry.PRIORITY.mcp);
      expect(registry.PRIORITY.mcp).toBeGreaterThan(registry.PRIORITY.user);
    });
  });

  describe('CATEGORIES', () => {
    test('includes expected categories', () => {
      expect(registry.CATEGORIES).toHaveProperty('model');
      expect(registry.CATEGORIES).toHaveProperty('data');
      expect(registry.CATEGORIES).toHaveProperty('security');
      expect(registry.CATEGORIES).toHaveProperty('dev');
      expect(registry.CATEGORIES).toHaveProperty('workflow');
      expect(registry.CATEGORIES).toHaveProperty('system');
    });
  });

  describe('register() and lookup', () => {
    test('registers a command and it appears in getAll()', () => {
      registry.register({ cmd: '/test-cmd-1', label: 'Test', desc: 'A test command' }, 'user');
      const all = registry.getAll();
      const found = all.find(c => c.cmd === '/test-cmd-1');
      expect(found).toBeDefined();
      expect(found.label).toBe('Test');
      expect(found.desc).toBe('A test command');
    });

    test('higher priority source wins over lower priority', () => {
      registry.register({ cmd: '/priority-test', label: 'user-ver', desc: 'user' }, 'user');
      registry.register({ cmd: '/priority-test', label: 'builtin-ver', desc: 'builtin' }, 'builtin');
      const all = registry.getAll();
      const found = all.find(c => c.cmd === '/priority-test');
      expect(found.label).toBe('builtin-ver');
    });

    test('lower priority source does NOT overwrite higher priority', () => {
      registry.register({ cmd: '/prio-test-2', label: 'builtin', desc: 'original' }, 'builtin');
      registry.register({ cmd: '/prio-test-2', label: 'user', desc: 'override attempt' }, 'user');
      const all = registry.getAll();
      const found = all.find(c => c.cmd === '/prio-test-2');
      expect(found.label).toBe('builtin');
    });

    test('ignores null or missing cmd in register()', () => {
      expect(() => registry.register(null)).not.toThrow();
      expect(() => registry.register({})).not.toThrow();
    });
  });

  describe('getCompletions()', () => {
    test('returns commands matching a partial prefix', () => {
      registry.register({ cmd: '/demo-alpha', label: 'DA', desc: '' }, 'user');
      registry.register({ cmd: '/demo-beta', label: 'DB', desc: '' }, 'user');
      const completions = registry.getCompletions('/demo-');
      expect(completions).toContain('/demo-alpha');
      expect(completions).toContain('/demo-beta');
    });

    test('returns empty array for empty input', () => {
      expect(registry.getCompletions('')).toEqual([]);
    });
  });

  describe('unregister()', () => {
    test('removes a previously registered command', () => {
      registry.register({ cmd: '/removeme', label: 'R', desc: '' }, 'user');
      const before = registry.getAll().find(c => c.cmd === '/removeme');
      expect(before).toBeDefined();

      registry.unregister('/removeme');
      const after = registry.getAll().find(c => c.cmd === '/removeme');
      expect(after).toBeUndefined();
    });
  });

  describe('count() and toSlashCommands()', () => {
    test('count() returns a number >= 0', () => {
      expect(typeof registry.count()).toBe('number');
      expect(registry.count()).toBeGreaterThanOrEqual(0);
    });

    test('toSlashCommands() returns array of { cmd, label, desc } objects', () => {
      const arr = registry.toSlashCommands();
      expect(Array.isArray(arr)).toBe(true);
      if (arr.length > 0) {
        expect(arr[0]).toHaveProperty('cmd');
        expect(arr[0]).toHaveProperty('label');
        expect(arr[0]).toHaveProperty('desc');
      }
    });

    test('includes builtin /ulw-loop slash command', () => {
      const arr = registry.toSlashCommands();
      const hit = arr.find(item => item.cmd === '/ulw-loop');
      expect(hit).toBeDefined();
      expect(hit.route).toBe('ulw-loop');
    });
  });

  describe('getByCategory()', () => {
    test('returns an object with category keys', () => {
      const grouped = registry.getByCategory();
      expect(typeof grouped).toBe('object');
      // Should have at least some categories from builtin seeding
      const keys = Object.keys(grouped);
      expect(keys.length).toBeGreaterThan(0);
    });
  });
});
