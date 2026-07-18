'use strict';

const path = require('path');

const {
  _safeJoin,
  _sanitizeName,
} = require('../../src/services/skillPackageService');

describe('skillPackageService — path safety (A3)', () => {
  const base = path.resolve('/tmp/khy-skills-sandbox');

  describe('_safeJoin', () => {
    test('joins a clean relative entry inside the sandbox', () => {
      const out = _safeJoin(base, 'my-skill/SKILL.md');
      expect(out).toBe(path.join(base, 'my-skill', 'SKILL.md'));
    });

    test('rejects absolute paths', () => {
      expect(() => _safeJoin(base, '/etc/passwd')).toThrow(/absolute/i);
    });

    test('rejects parent-traversal (zip-slip)', () => {
      expect(() => _safeJoin(base, '../../etc/passwd')).toThrow(/escapes sandbox/i);
      expect(() => _safeJoin(base, 'a/../../b')).toThrow(/escapes sandbox/i);
    });

    test('normalizes backslashes before the traversal check', () => {
      expect(() => _safeJoin(base, '..\\..\\windows')).toThrow(/escapes sandbox/i);
    });

    test('rejects empty entries', () => {
      expect(() => _safeJoin(base, '')).toThrow();
    });

    test('a prefix-collision sibling does not pass as "inside"', () => {
      // base + "-evil" shares the base string prefix but is NOT a child dir.
      expect(() => _safeJoin(base, '../khy-skills-sandbox-evil')).toThrow(/escapes sandbox/i);
    });
  });

  describe('_sanitizeName', () => {
    test('accepts safe single-segment names', () => {
      expect(_sanitizeName('my-skill_1.2')).toBe('my-skill_1.2');
    });

    test('rejects separators and traversal', () => {
      expect(() => _sanitizeName('a/b')).toThrow();
      expect(() => _sanitizeName('a\\b')).toThrow();
      expect(() => _sanitizeName('..')).toThrow();
      expect(() => _sanitizeName('foo..bar')).toThrow();
    });

    test('rejects names with disallowed characters', () => {
      expect(() => _sanitizeName('foo bar')).toThrow();
      expect(() => _sanitizeName('foo$bar')).toThrow();
      expect(() => _sanitizeName('')).toThrow();
    });
  });
});
