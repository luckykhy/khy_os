'use strict';

const { resolveAlias, getAliasesForCommand, getAllAliasKeys, ALIAS_MAP } = require('../../src/cli/aliases');

describe('aliases', () => {
  describe('ALIAS_MAP', () => {
    test('is a non-empty object', () => {
      expect(typeof ALIAS_MAP).toBe('object');
      expect(Object.keys(ALIAS_MAP).length).toBeGreaterThan(0);
    });

    test('every entry has a command field', () => {
      for (const [key, value] of Object.entries(ALIAS_MAP)) {
        expect(value).toHaveProperty('command');
        expect(typeof value.command).toBe('string');
      }
    });

    test('contains expected pinyin aliases', () => {
      expect(ALIAS_MAP.hq).toEqual({ command: 'quote' });
      expect(ALIAS_MAP.bt).toEqual({ command: 'backtest' });
      expect(ALIAS_MAP.bz).toEqual({ command: 'help' });
      expect(ALIAS_MAP.ulw).toEqual({ command: 'ulw-loop' });
    });

    test('contains expected Chinese aliases', () => {
      expect(ALIAS_MAP['\u884c\u60c5']).toEqual({ command: 'quote' }); // 行情
      expect(ALIAS_MAP['\u56de\u6d4b']).toEqual({ command: 'backtest' }); // 回测
      expect(ALIAS_MAP['\u9000\u51fa']).toEqual({ command: 'exit' }); // 退出
    });

    test('some aliases include subCommand', () => {
      expect(ALIAS_MAP.cl).toEqual({ command: 'strategy', subCommand: 'list' });
      expect(ALIAS_MAP.xz).toEqual({ command: 'data', subCommand: 'fetch' });
      expect(ALIAS_MAP['pip打包']).toEqual({ command: 'publish', subCommand: 'pip-dir-bundle' });
      expect(ALIAS_MAP['npm打包']).toEqual({ command: 'publish', subCommand: 'npm-dir-bundle' });
      expect(ALIAS_MAP['源码还原']).toEqual({ command: 'publish', subCommand: 'origin-code' });
      expect(ALIAS_MAP['git推送']).toEqual({ command: 'publish', subCommand: 'git-push' });
    });

    test('some aliases include defaultArgs', () => {
      expect(ALIAS_MAP.buy).toEqual({ command: 'order', defaultArgs: { side: 'buy' } });
      expect(ALIAS_MAP.sell).toEqual({ command: 'order', defaultArgs: { side: 'sell' } });
    });
  });

  describe('resolveAlias()', () => {
    test('resolves a known alias to its canonical command', () => {
      const result = resolveAlias('hq');
      expect(result).toEqual({ command: 'quote' });
    });

    test('resolves case-insensitively', () => {
      const result = resolveAlias('HQ');
      expect(result).toEqual({ command: 'quote' });
    });

    test('returns null for unknown alias', () => {
      expect(resolveAlias('nonexistent_alias_xyz')).toBeNull();
    });

    test('returns null for empty or null input', () => {
      expect(resolveAlias('')).toBeNull();
      expect(resolveAlias(null)).toBeNull();
      expect(resolveAlias(undefined)).toBeNull();
    });

    test('resolves alias with subCommand', () => {
      const result = resolveAlias('dl');
      expect(result).toEqual({ command: 'data', subCommand: 'fetch' });
    });
  });

  describe('getAliasesForCommand()', () => {
    test('returns all aliases for "quote"', () => {
      const aliases = getAliasesForCommand('quote');
      expect(aliases).toContain('hq');
      expect(aliases).toContain('hangqing');
      expect(aliases).toContain('p');
    });

    test('returns empty array for unknown command', () => {
      const aliases = getAliasesForCommand('nonexistent_command_xyz');
      expect(aliases).toEqual([]);
    });
  });

  describe('getAllAliasKeys()', () => {
    test('returns an array of all alias keys', () => {
      const keys = getAllAliasKeys();
      expect(Array.isArray(keys)).toBe(true);
      expect(keys.length).toBeGreaterThan(50); // many aliases defined
      expect(keys).toContain('hq');
      expect(keys).toContain('bt');
    });
  });
});
