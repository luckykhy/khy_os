'use strict';

const {
  isSearchOrReadCommand,
  isBlockedDevicePath,
  getBaseCommand,
  getCommandTokens,
  splitCommandWithOperators,
  SEARCH_COMMANDS,
  READ_COMMANDS,
  LIST_COMMANDS,
  BLOCKED_DEVICE_PATHS,
} = require('../../src/tools/shellClassifier');

describe('shellClassifier', () => {
  describe('isBlockedDevicePath', () => {
    test('returns false for empty/null', () => {
      expect(isBlockedDevicePath('')).toBe(false);
      expect(isBlockedDevicePath(null)).toBe(false);
      expect(isBlockedDevicePath(undefined)).toBe(false);
    });

    test('returns false for non-string', () => {
      expect(isBlockedDevicePath(123)).toBe(false);
    });

    test('blocks /dev/zero', () => {
      expect(isBlockedDevicePath('/dev/zero')).toBe(true);
    });

    test('blocks /dev/random', () => {
      expect(isBlockedDevicePath('/dev/random')).toBe(true);
    });

    test('blocks /dev/urandom', () => {
      expect(isBlockedDevicePath('/dev/urandom')).toBe(true);
    });

    test('blocks /dev/stdin', () => {
      expect(isBlockedDevicePath('/dev/stdin')).toBe(true);
    });

    test('normalizes trailing slashes', () => {
      expect(isBlockedDevicePath('/dev/zero/')).toBe(true);
      expect(isBlockedDevicePath('/dev/zero///')).toBe(true);
    });

    test('returns false for regular paths', () => {
      expect(isBlockedDevicePath('/tmp/test.txt')).toBe(false);
      expect(isBlockedDevicePath('/home/user/file')).toBe(false);
    });

    test('all BLOCKED_DEVICE_PATHS are blocked', () => {
      for (const p of BLOCKED_DEVICE_PATHS) {
        expect(isBlockedDevicePath(p)).toBe(true);
      }
    });
  });

  describe('getBaseCommand', () => {
    test('returns empty for empty string', () => {
      expect(getBaseCommand('')).toBe('');
    });

    test('extracts simple command', () => {
      expect(getBaseCommand('grep foo file.txt')).toBe('grep');
    });

    test('extracts from path', () => {
      expect(getBaseCommand('/usr/bin/grep foo')).toBe('grep');
    });

    test('handles env prefix', () => {
      expect(getBaseCommand('FOO=bar grep foo')).toBe('grep');
      expect(getBaseCommand('FOO=bar BAZ=qux ls')).toBe('ls');
    });

    test('handles sudo prefix', () => {
      expect(getBaseCommand('sudo grep foo')).toBe('grep');
      expect(getBaseCommand('sudo /usr/bin/grep foo')).toBe('grep');
    });

    test('handles env prefix', () => {
      expect(getBaseCommand('env grep foo')).toBe('grep');
    });
  });

  describe('getCommandTokens', () => {
    test('returns empty for empty string', () => {
      expect(getCommandTokens('')).toEqual([]);
    });

    test('returns lowercase tokens', () => {
      const result = getCommandTokens('GREP foo FILE.TXT');
      expect(result[0]).toBe('grep');
      expect(result[1]).toBe('foo');
    });

    test('handles path prefix', () => {
      const result = getCommandTokens('/usr/bin/grep foo');
      expect(result[0]).toBe('grep');
    });

    test('handles env prefix', () => {
      const result = getCommandTokens('FOO=bar grep foo');
      expect(result[0]).toBe('grep');
    });

    test('handles sudo prefix', () => {
      const result = getCommandTokens('sudo grep foo');
      expect(result[0]).toBe('grep');
    });
  });

  describe('splitCommandWithOperators', () => {
    test('returns empty for empty string', () => {
      expect(splitCommandWithOperators('')).toEqual([]);
    });

    test('returns empty for non-string', () => {
      expect(splitCommandWithOperators(null)).toEqual([]);
    });

    test('splits on pipe', () => {
      const result = splitCommandWithOperators('cat file | grep foo');
      expect(result).toContain('cat file');
      expect(result).toContain('|');
      expect(result).toContain('grep foo');
    });

    test('splits on double pipe', () => {
      const result = splitCommandWithOperators('cmd1 || cmd2');
      expect(result).toContain('||');
    });

    test('splits on ampersand', () => {
      const result = splitCommandWithOperators('cmd1 & cmd2');
      expect(result).toContain('&');
    });

    test('splits on double ampersand', () => {
      const result = splitCommandWithOperators('cmd1 && cmd2');
      expect(result).toContain('&&');
    });

    test('handles redirects', () => {
      const result = splitCommandWithOperators('echo hello > file.txt');
      expect(result).toContain('>');
    });

    test('handles append redirect', () => {
      const result = splitCommandWithOperators('echo hello >> file.txt');
      expect(result).toContain('>>');
    });

    test('handles quoted strings with operators', () => {
      const result = splitCommandWithOperators('echo "hello | world"');
      expect(result).toContain('echo "hello | world"');
    });
  });

  describe('isSearchOrReadCommand', () => {
    test('returns false for empty/null', () => {
      expect(isSearchOrReadCommand('')).toEqual({ isSearch: false, isRead: false, isList: false });
      expect(isSearchOrReadCommand(null)).toEqual({ isSearch: false, isRead: false, isList: false });
    });

    test('returns false for non-string', () => {
      expect(isSearchOrReadCommand(123)).toEqual({ isSearch: false, isRead: false, isList: false });
    });

    test('detects search command', () => {
      expect(isSearchOrReadCommand('grep foo file').isSearch).toBe(true);
      expect(isSearchOrReadCommand('find . -name "*.js"').isSearch).toBe(true);
      expect(isSearchOrReadCommand('rg pattern').isSearch).toBe(true);
    });

    test('detects read command', () => {
      expect(isSearchOrReadCommand('cat file.txt').isRead).toBe(true);
      expect(isSearchOrReadCommand('head file.txt').isRead).toBe(true);
      expect(isSearchOrReadCommand('tail file.txt').isRead).toBe(true);
      expect(isSearchOrReadCommand('less file.txt').isRead).toBe(true);
    });

    test('detects list command', () => {
      expect(isSearchOrReadCommand('ls').isList).toBe(true);
      expect(isSearchOrReadCommand('dir').isList).toBe(true);
      expect(isSearchOrReadCommand('tree').isList).toBe(true);
    });

    test('detects redirect as non-read', () => {
      const result = isSearchOrReadCommand('echo hello > file');
      expect(result.isRead).toBe(false);
      expect(result.isSearch).toBe(false);
    });

    test('detects write command as non-read', () => {
      const result = isSearchOrReadCommand('rm file');
      expect(result.isRead).toBe(false);
      expect(result.isSearch).toBe(false);
    });

    test('handles pipeline with all read commands', () => {
      const result = isSearchOrReadCommand('cat file | grep foo | wc -l');
      expect(result.isRead).toBe(true);
      expect(result.isSearch).toBe(true);
    });

    test('handles pipeline with write command', () => {
      const result = isSearchOrReadCommand('cat file | grep foo > out');
      expect(result.isRead).toBe(false);
    });

    test('handles verb-gated wmic query', () => {
      expect(isSearchOrReadCommand('wmic cpu get name').isRead).toBe(true);
    });

    test('handles verb-gated wmic mutation', () => {
      expect(isSearchOrReadCommand('wmic process call create').isRead).toBe(false);
    });

    test('handles verb-gated reg query', () => {
      expect(isSearchOrReadCommand('reg query HKLM').isRead).toBe(true);
    });

    test('handles verb-gated reg add', () => {
      expect(isSearchOrReadCommand('reg add HKLM').isRead).toBe(false);
    });

    test('handles verb-gated sc query', () => {
      expect(isSearchOrReadCommand('sc query').isRead).toBe(true);
    });

    test('handles verb-gated sc create', () => {
      expect(isSearchOrReadCommand('sc create').isRead).toBe(false);
    });

    test('handles verb-gated systemctl status', () => {
      expect(isSearchOrReadCommand('systemctl status').isRead).toBe(true);
    });

    test('handles verb-gated systemctl start', () => {
      expect(isSearchOrReadCommand('systemctl start').isRead).toBe(false);
    });

    test('neutral commands do not affect classification', () => {
      const result = isSearchOrReadCommand('cat file | echo done');
      expect(result.isRead).toBe(true);
    });
  });

  describe('SEARCH_COMMANDS', () => {
    test('contains grep', () => {
      expect(SEARCH_COMMANDS.has('grep')).toBe(true);
    });

    test('contains find', () => {
      expect(SEARCH_COMMANDS.has('find')).toBe(true);
    });
  });

  describe('READ_COMMANDS', () => {
    test('contains cat', () => {
      expect(READ_COMMANDS.has('cat')).toBe(true);
    });

    test('contains head', () => {
      expect(READ_COMMANDS.has('head')).toBe(true);
    });
  });

  describe('LIST_COMMANDS', () => {
    test('contains ls', () => {
      expect(LIST_COMMANDS.has('ls')).toBe(true);
    });

    test('contains dir', () => {
      expect(LIST_COMMANDS.has('dir')).toBe(true);
    });
  });
});
