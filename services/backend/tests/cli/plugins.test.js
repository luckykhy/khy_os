'use strict';

jest.mock('chalk', () => {
  const fn = (...args) => args.join(' ');
  fn.yellow = fn; fn.dim = fn; fn.bold = fn;
  fn.default = fn;
  return fn;
});

const path = require('path');
const os = require('os');

const plugins = require('../../src/cli/plugins');

describe('plugins', () => {
  describe('module exports', () => {
    test('exports loadPlugins function', () => {
      expect(typeof plugins.loadPlugins).toBe('function');
    });

    test('exports tryPlugin function', () => {
      expect(typeof plugins.tryPlugin).toBe('function');
    });

    test('exports getPluginList function', () => {
      expect(typeof plugins.getPluginList).toBe('function');
    });

    test('exports reloadPlugins function', () => {
      expect(typeof plugins.reloadPlugins).toBe('function');
    });

    test('exports PLUGINS_DIR constant', () => {
      expect(typeof plugins.PLUGINS_DIR).toBe('string');
      expect(plugins.PLUGINS_DIR).toContain('.khyquant');
      expect(plugins.PLUGINS_DIR).toContain('commands');
    });
  });

  describe('PLUGINS_DIR', () => {
    test('is under user home directory', () => {
      expect(plugins.PLUGINS_DIR.startsWith(os.homedir())).toBe(true);
    });

    test('path contains expected segments', () => {
      const expected = path.join(os.homedir(), '.khyquant', 'commands');
      expect(plugins.PLUGINS_DIR).toBe(expected);
    });
  });

  describe('loadPlugins()', () => {
    test('returns a Map', () => {
      const result = plugins.loadPlugins();
      expect(result instanceof Map).toBe(true);
    });

    test('calling loadPlugins twice returns same instance (cached)', () => {
      const first = plugins.loadPlugins();
      const second = plugins.loadPlugins();
      expect(first).toBe(second);
    });
  });

  describe('getPluginList()', () => {
    test('returns an array', () => {
      const list = plugins.getPluginList();
      expect(Array.isArray(list)).toBe(true);
    });
  });

  describe('tryPlugin()', () => {
    test('returns false for unknown command', async () => {
      const result = await plugins.tryPlugin('nonexistent_command_xyz', [], {});
      expect(result).toBe(false);
    });
  });
});
