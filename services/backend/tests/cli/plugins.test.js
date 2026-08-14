'use strict';

jest.mock('chalk', () => {
  const fn = (...args) => args.join(' ');
  fn.yellow = fn; fn.dim = fn; fn.bold = fn;
  fn.default = fn;
  return fn;
});

const path = require('path');
const { getAppHome } = require('../../src/utils/dataHome');

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
      expect(plugins.PLUGINS_DIR).toContain('commands');
    });
  });

  describe('PLUGINS_DIR', () => {
    test('resolves under the application data home (getAppHome source of truth)', () => {
      // plugins._appHome() delegates to dataHome.getAppHome() (legacy
      // ~/.khyquant established-wins, else the unified data home). Asserting
      // against the same resolver keeps the test correct under jest's data-home
      // isolation (KHY_DATA_HOME → tmp dir) and on any platform.
      expect(plugins.PLUGINS_DIR).toBe(path.join(getAppHome(), 'commands'));
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
