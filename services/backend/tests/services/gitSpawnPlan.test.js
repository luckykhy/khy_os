'use strict';

const { isShellFreeGitEnabled, toGitArgv, _FALSY, _SHELL_META_RE } = require('../../src/services/gitSpawnPlan');

jest.mock('../../src/services/flagRegistry', () => ({
  isRegistryEnabled: jest.fn(),
  isFlagEnabled: jest.fn()
}));

describe('gitSpawnPlan', () => {
  const { isRegistryEnabled, isFlagEnabled } = require('../../src/services/flagRegistry');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isShellFreeGitEnabled', () => {
    test('returns true by default', () => {
      isRegistryEnabled.mockReturnValue(false);
      expect(isShellFreeGitEnabled({})).toBe(true);
    });

    test('returns false for off values', () => {
      isRegistryEnabled.mockReturnValue(false);
      expect(isShellFreeGitEnabled({ KHY_GIT_SHELL_FREE: '0' })).toBe(false);
      expect(isShellFreeGitEnabled({ KHY_GIT_SHELL_FREE: 'false' })).toBe(false);
      expect(isShellFreeGitEnabled({ KHY_GIT_SHELL_FREE: 'off' })).toBe(false);
      expect(isShellFreeGitEnabled({ KHY_GIT_SHELL_FREE: 'no' })).toBe(false);
    });

    test('delegates to flagRegistry when available', () => {
      isRegistryEnabled.mockReturnValue(true);
      isFlagEnabled.mockReturnValue(true);
      expect(isShellFreeGitEnabled({})).toBe(true);
      expect(isFlagEnabled).toHaveBeenCalledWith('KHY_GIT_SHELL_FREE', {});
    });

    test('returns true for empty string', () => {
      isRegistryEnabled.mockReturnValue(false);
      expect(isShellFreeGitEnabled({ KHY_GIT_SHELL_FREE: '' })).toBe(true);
    });
  });

  describe('toGitArgv', () => {
    test('splits simple command', () => {
      expect(toGitArgv('rev-parse --show-toplevel')).toEqual(['rev-parse', '--show-toplevel']);
    });

    test('handles single command', () => {
      expect(toGitArgv('status')).toEqual(['status']);
    });

    test('returns null for empty string', () => {
      expect(toGitArgv('')).toBeNull();
      expect(toGitArgv('   ')).toBeNull();
    });

    test('returns null for non-string', () => {
      expect(toGitArgv(null)).toBeNull();
      expect(toGitArgv(undefined)).toBeNull();
      expect(toGitArgv(123)).toBeNull();
    });

    test('returns null for shell metacharacters', () => {
      expect(toGitArgv('status | grep foo')).toBeNull();
      expect(toGitArgv('status; rm -rf /')).toBeNull();
      expect(toGitArgv('status && echo foo')).toBeNull();
      expect(toGitArgv('status$HOME')).toBeNull();
      expect(toGitArgv('status`echo foo`')).toBeNull();
    });

    test('handles multiple spaces', () => {
      expect(toGitArgv('log  --oneline   -15')).toEqual(['log', '--oneline', '-15']);
    });
  });

  describe('_FALSY', () => {
    test('contains expected values', () => {
      expect(_FALSY.has('0')).toBe(true);
      expect(_FALSY.has('false')).toBe(true);
      expect(_FALSY.has('off')).toBe(true);
      expect(_FALSY.has('no')).toBe(true);
    });
  });

  describe('_SHELL_META_RE', () => {
    test('matches shell metacharacters', () => {
      expect(_SHELL_META_RE.test('|')).toBe(true);
      expect(_SHELL_META_RE.test('&')).toBe(true);
      expect(_SHELL_META_RE.test(';')).toBe(true);
      expect(_SHELL_META_RE.test('>')).toBe(true);
      expect(_SHELL_META_RE.test('<')).toBe(true);
      expect(_SHELL_META_RE.test('$')).toBe(true);
    });

    test('does not match normal text', () => {
      expect(_SHELL_META_RE.test('status')).toBe(false);
      expect(_SHELL_META_RE.test('rev-parse')).toBe(false);
      expect(_SHELL_META_RE.test('--show-toplevel')).toBe(false);
    });
  });
});
