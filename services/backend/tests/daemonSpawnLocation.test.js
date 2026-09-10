'use strict';
const { resolveDaemonSpawnLocation } = require('../src/services/daemonSpawnLocation');
const BUNDLE_ROOT = '/opt/py/site-packages/khy_os/bundled/services/backend/src';
const DATA_HOME = '/home/u/.khy';

describe('Daemon Spawn Location', () => {
  test('win32 + gate on + valid dataHome â‰?root â†?cwd moves out of bundle, KHYQUANT_ROOT pinned', () => {
      const out = resolveDaemonSpawnLocation({
        platform: 'win32', resolvedRoot: BUNDLE_ROOT, dataHome: DATA_HOME, gateEnabled: true,
      });
      expect(out.cwd).toBe(DATA_HOME);
      expect(out.envPatch).toEqual({ KHYQUANT_ROOT: BUNDLE_ROOT });
  });

  test('non-win32 (linux) â†?unchanged: cwd stays root, empty envPatch', () => {
      const out = resolveDaemonSpawnLocation({
        platform: 'linux', resolvedRoot: BUNDLE_ROOT, dataHome: DATA_HOME, gateEnabled: true,
      });
      expect(out.cwd).toBe(BUNDLE_ROOT);
      expect(out.envPatch).toEqual({});
  });

  test('non-win32 (darwin) â†?unchanged', () => {
      const out = resolveDaemonSpawnLocation({
        platform: 'darwin', resolvedRoot: BUNDLE_ROOT, dataHome: DATA_HOME, gateEnabled: true,
      });
      expect(out.cwd).toBe(BUNDLE_ROOT);
      expect(out.envPatch).toEqual({});
  });

  test('win32 + gate OFF â†?unchanged (escape hatch)', () => {
      const out = resolveDaemonSpawnLocation({
        platform: 'win32', resolvedRoot: BUNDLE_ROOT, dataHome: DATA_HOME, gateEnabled: false,
      });
      expect(out.cwd).toBe(BUNDLE_ROOT);
      expect(out.envPatch).toEqual({});
  });

  test('win32 + no dataHome (null / empty) â†?unchanged', () => {
      for (const dataHome of [null, '', '   ', undefined]) {
        const out = resolveDaemonSpawnLocation({
          platform: 'win32', resolvedRoot: BUNDLE_ROOT, dataHome, gateEnabled: true,
        });
        expect(out.cwd).toBe(BUNDLE_ROOT);
        expect(out.envPatch).toEqual({});
      }
  });

  test('win32 + dataHome === resolvedRoot â†?unchanged (nothing to gain)', () => {
      const out = resolveDaemonSpawnLocation({
        platform: 'win32', resolvedRoot: DATA_HOME, dataHome: DATA_HOME, gateEnabled: true,
      });
      expect(out.cwd).toBe(DATA_HOME);
      expect(out.envPatch).toEqual({});
  });

  test('junk / undefined input â†?does not throw, falls back to empty-root unchanged shape', () => {
      for (const bad of [undefined, null, 42, 'str', {}, { platform: 123 }]) {
        let out;
        expect(() => { out = resolveDaemonSpawnLocation(bad); }).not.toThrow();
        expect(typeof out.cwd).toBe('string');
        expect(out.envPatch).toEqual({});
      }
  });

  test('win32 relocation with no resolvedRoot â†?moves cwd but pins nothing', () => {
      const out = resolveDaemonSpawnLocation({
        platform: 'win32', resolvedRoot: '', dataHome: DATA_HOME, gateEnabled: true,
      });
      expect(out.cwd).toBe(DATA_HOME);
      expect(out.envPatch).toEqual({});
  });

});

