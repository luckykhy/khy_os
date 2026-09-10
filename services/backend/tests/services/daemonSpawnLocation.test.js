'use strict';

const { resolveDaemonSpawnLocation } = require('../../src/services/daemonSpawnLocation');

describe('daemonSpawnLocation', () => {
  describe('resolveDaemonSpawnLocation', () => {
    test('returns no change on non-windows platforms', () => {
      const result = resolveDaemonSpawnLocation({
        platform: 'linux',
        resolvedRoot: '/opt/khy',
        dataHome: '/home/user/.khy',
        gateEnabled: true,
      });
      expect(result.cwd).toBe('/opt/khy');
      expect(result.envPatch).toEqual({});
    });

    test('returns no change when gate is disabled', () => {
      const result = resolveDaemonSpawnLocation({
        platform: 'win32',
        resolvedRoot: 'C:\\khy',
        dataHome: 'C:\\Users\\user\\.khy',
        gateEnabled: false,
      });
      expect(result.cwd).toBe('C:\\khy');
      expect(result.envPatch).toEqual({});
    });

    test('relocates cwd on Windows when gate enabled', () => {
      const result = resolveDaemonSpawnLocation({
        platform: 'win32',
        resolvedRoot: 'C:\\khy\\site-packages',
        dataHome: 'C:\\Users\\user\\.khy',
        gateEnabled: true,
      });
      expect(result.cwd).toBe('C:\\Users\\user\\.khy');
      expect(result.envPatch.KHYQUANT_ROOT).toBe('C:\\khy\\site-packages');
    });

    test('returns no change when data home is empty', () => {
      const result = resolveDaemonSpawnLocation({
        platform: 'win32',
        resolvedRoot: 'C:\\khy',
        dataHome: '',
        gateEnabled: true,
      });
      expect(result.cwd).toBe('C:\\khy');
      expect(result.envPatch).toEqual({});
    });

    test('returns no change when data home equals resolved root', () => {
      const result = resolveDaemonSpawnLocation({
        platform: 'win32',
        resolvedRoot: 'C:\\Users\\user\\.khy',
        dataHome: 'C:\\Users\\user\\.khy',
        gateEnabled: true,
      });
      expect(result.cwd).toBe('C:\\Users\\user\\.khy');
      expect(result.envPatch).toEqual({});
    });

    test('handles null/undefined inputs gracefully', () => {
      const result = resolveDaemonSpawnLocation(null);
      expect(result.cwd).toBe('');
      expect(result.envPatch).toEqual({});
    });

    test('trims dataHome whitespace', () => {
      const result = resolveDaemonSpawnLocation({
        platform: 'win32',
        resolvedRoot: 'C:\\khy',
        dataHome: '  C:\\Users\\user\\.khy  ',
        gateEnabled: true,
      });
      expect(result.cwd).toBe('C:\\Users\\user\\.khy');
    });
  });
});

