'use strict';

/**
 * Tests for permissions/patternMatcher.js — pure-leaf pattern matching.
 *
 * Covers:
 *   - extractCommandPrefix: env-assignment skipping, compound-command
 *     rejection (fail-closed → null), whitespace normalization
 *   - matchPatternRule: three forms (exact tool / command-prefix glob /
 *     param glob), serialization priority alignment
 *   - compiled-RegExp cache capacity bound (KHY_PERMISSION_PATTERN_CACHE_CAP)
 *
 * Hermetic: pure functions only — no filesystem or data-home access.
 */

const ORIG_ENV = { ...process.env };

function loadMatcher() {
  return require('../../src/permissions/patternMatcher');
}

beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIG_ENV };
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe('extractCommandPrefix', () => {
  test('returns simple command unchanged', () => {
    const m = loadMatcher();
    expect(m.extractCommandPrefix('npm run build')).toBe('npm run build');
    expect(m.extractCommandPrefix('git status')).toBe('git status');
  });

  test('normalizes repeated whitespace', () => {
    const m = loadMatcher();
    expect(m.extractCommandPrefix('npm   run    build')).toBe('npm run build');
    expect(m.extractCommandPrefix('  git status  ')).toBe('git status');
  });

  test('skips leading env assignments', () => {
    const m = loadMatcher();
    expect(m.extractCommandPrefix('FOO=1 npm test')).toBe('npm test');
    expect(m.extractCommandPrefix('FOO=1 BAR=x npm run dev')).toBe('npm run dev');
  });

  test('only env assignments (no command) → null', () => {
    const m = loadMatcher();
    expect(m.extractCommandPrefix('FOO=1')).toBeNull();
    expect(m.extractCommandPrefix('FOO=1 BAR=2')).toBeNull();
  });

  test.each([
    ['npm test && rm -rf /', '&&'],
    ['a || b', '||'],
    ['a | b', 'pipe'],
    ['a; b', 'semicolon'],
    ['a > file', 'redirect out'],
    ['a < file', 'redirect in'],
    ['echo `whoami`', 'backtick'],
    ['echo $(whoami)', 'command substitution'],
    ['a & b', 'background &'],
    ['a\nb', 'newline'],
  ])('compound command %#(%s: %s) → null (fail-closed)', (cmd) => {
    const m = loadMatcher();
    expect(m.extractCommandPrefix(cmd)).toBeNull();
  });

  test('empty / non-string input → null', () => {
    const m = loadMatcher();
    expect(m.extractCommandPrefix('')).toBeNull();
    expect(m.extractCommandPrefix('   ')).toBeNull();
    expect(m.extractCommandPrefix(null)).toBeNull();
    expect(m.extractCommandPrefix(undefined)).toBeNull();
    expect(m.extractCommandPrefix(42)).toBeNull();
  });
});

describe('matchPatternRule — form (a): exact tool name', () => {
  test('rule without pattern matches any params for the same tool', () => {
    const m = loadMatcher();
    const rule = { toolName: 'Bash', pattern: null, decision: 'allow' };
    expect(m.matchPatternRule(rule, 'Bash', { command: 'anything' })).toBe(true);
    expect(m.matchPatternRule(rule, 'Bash', {})).toBe(true);
  });

  test('tool name mismatch never matches', () => {
    const m = loadMatcher();
    const rule = { toolName: 'Bash', pattern: null };
    expect(m.matchPatternRule(rule, 'Read', {})).toBe(false);
  });

  test('malformed rules never match', () => {
    const m = loadMatcher();
    expect(m.matchPatternRule(null, 'Bash', {})).toBe(false);
    expect(m.matchPatternRule({}, 'Bash', {})).toBe(false);
    expect(m.matchPatternRule({ toolName: '' }, '', {})).toBe(false);
  });
});

describe('matchPatternRule — form (b): command-prefix glob', () => {
  test('wildcard prefix matches simple commands', () => {
    const m = loadMatcher();
    const rule = { toolName: 'Bash', pattern: 'npm run *' };
    expect(m.matchPatternRule(rule, 'Bash', { command: 'npm run build' })).toBe(true);
    expect(m.matchPatternRule(rule, 'Bash', { command: 'npm run dev' })).toBe(true);
    expect(m.matchPatternRule(rule, 'Bash', { command: 'npm install' })).toBe(false);
  });

  test('exact command pattern (no wildcard) matches exactly', () => {
    const m = loadMatcher();
    const rule = { toolName: 'Bash', pattern: 'git status' };
    expect(m.matchPatternRule(rule, 'Bash', { command: 'git status' })).toBe(true);
    expect(m.matchPatternRule(rule, 'Bash', { command: 'git status --short' })).toBe(false);
  });

  test('compound command never matches a prefix pattern (fail-closed)', () => {
    const m = loadMatcher();
    const rule = { toolName: 'Bash', pattern: 'npm run *' };
    expect(m.matchPatternRule(rule, 'Bash', { command: 'npm run build && rm -rf /' })).toBe(false);
    expect(m.matchPatternRule(rule, 'Bash', { command: 'npm run x; evil' })).toBe(false);
  });

  test('env assignments are skipped before prefix matching', () => {
    const m = loadMatcher();
    const rule = { toolName: 'Bash', pattern: 'npm run *' };
    expect(m.matchPatternRule(rule, 'Bash', { command: 'CI=1 npm run test' })).toBe(true);
  });

  test('cmd param is treated like command', () => {
    const m = loadMatcher();
    const rule = { toolName: 'shellCommand', pattern: 'git *' };
    expect(m.matchPatternRule(rule, 'shellCommand', { cmd: 'git log' })).toBe(true);
  });
});

describe('matchPatternRule — form (c): param glob', () => {
  test('file_path glob matching', () => {
    const m = loadMatcher();
    const rule = { toolName: 'Read', pattern: '/tmp/**' };
    expect(m.matchPatternRule(rule, 'Read', { file_path: '/tmp/a/b.txt' })).toBe(true);
    expect(m.matchPatternRule(rule, 'Read', { file_path: '/etc/passwd' })).toBe(false);
  });

  test('path param used when file_path absent', () => {
    const m = loadMatcher();
    const rule = { toolName: 'listDir', pattern: '/home/*' };
    expect(m.matchPatternRule(rule, 'listDir', { path: '/home/user' })).toBe(true);
  });

  test('empty params with a pattern → no match', () => {
    const m = loadMatcher();
    const rule = { toolName: 'Read', pattern: '/tmp/**' };
    expect(m.matchPatternRule(rule, 'Read', {})).toBe(false);
    expect(m.matchPatternRule(rule, 'Read', undefined)).toBe(false);
  });
});

describe('_serializeParams — priority aligned with legacy rules.js', () => {
  test('command > cmd > file_path > path > JSON', () => {
    const m = loadMatcher();
    expect(m._serializeParams({ command: 'a', cmd: 'b', file_path: 'c', path: 'd' })).toBe('a');
    expect(m._serializeParams({ cmd: 'b', file_path: 'c', path: 'd' })).toBe('b');
    expect(m._serializeParams({ file_path: 'c', path: 'd' })).toBe('c');
    expect(m._serializeParams({ path: 'd' })).toBe('d');
    expect(m._serializeParams({ other: 1 })).toBe('{"other":1}');
    expect(m._serializeParams(null)).toBe('');
  });
});

describe('compiled-RegExp cache capacity', () => {
  test('cache never exceeds KHY_PERMISSION_PATTERN_CACHE_CAP; oldest evicted', () => {
    process.env.KHY_PERMISSION_PATTERN_CACHE_CAP = '2';
    jest.resetModules();
    const m = loadMatcher();

    m._compilePattern('a*');
    m._compilePattern('b*');
    expect(m._regexCache.size).toBe(2);

    m._compilePattern('c*');
    expect(m._regexCache.size).toBe(2);
    expect(m._regexCache.has('a*')).toBe(false); // oldest evicted
    expect(m._regexCache.has('b*')).toBe(true);
    expect(m._regexCache.has('c*')).toBe(true);
  });

  test('cache hit returns the same RegExp instance without eviction', () => {
    process.env.KHY_PERMISSION_PATTERN_CACHE_CAP = '2';
    jest.resetModules();
    const m = loadMatcher();

    const first = m._compilePattern('npm run *');
    const second = m._compilePattern('npm run *');
    expect(first).toBe(second);
    expect(m._regexCache.size).toBe(1);
  });

  test('default capacity applies when env is unset', () => {
    delete process.env.KHY_PERMISSION_PATTERN_CACHE_CAP;
    jest.resetModules();
    const m = loadMatcher();
    // Fill beyond a small number — all retained under the default cap (256).
    for (let i = 0; i < 10; i++) m._compilePattern(`p${i}*`);
    expect(m._regexCache.size).toBe(10);
  });
});
