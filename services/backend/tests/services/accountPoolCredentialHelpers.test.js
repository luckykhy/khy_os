'use strict';

/**
 * accountPoolCredentialHelpers.test.js — pure credential/token value helpers.
 *
 * Extracted verbatim from src/services/accountPool.js as part of the
 * behavior-preserving god-file split. These value transforms had NO direct
 * test coverage while buried in the pool service; this pins their contracts.
 */

const crypto = require('crypto');
const {
  PROVIDER_ALIASES,
  normalizePoolType,
  safeJsonParse,
  maskToken,
  tokenHash,
  formatIso,
  normalizeTokenValue,
  _isPlaceholderEmail,
  _isPlaceholderValue,
  isValidEmail,
  hasTokenShape,
  hasLooseTokenShape,
  coerceObject,
  decodeMaybeURIComponent,
  parseCallbackPayload,
  firstNonEmpty,
  parseBoolean,
  dedupePaths,
} = require('../../src/services/accountPool/credentialHelpers');

describe('normalizePoolType', () => {
  test('lowercases, trims, and collapses known aliases onto canonical names', () => {
    expect(normalizePoolType('  Trae ')).toBe('trae');
    expect(normalizePoolType('antigravity')).toBe('trae');
    expect(normalizePoolType('anti-gravity')).toBe('trae');
    expect(normalizePoolType('nirvana')).toBe('trae');
    expect(normalizePoolType('CURSOR')).toBe('cursor'); // unknown alias passes through
  });

  test('nullish input becomes empty string', () => {
    expect(normalizePoolType(null)).toBe('');
    expect(normalizePoolType(undefined)).toBe('');
  });

  test('PROVIDER_ALIASES is frozen', () => {
    expect(Object.isFrozen(PROVIDER_ALIASES)).toBe(true);
  });
});

describe('safeJsonParse', () => {
  test('parses valid JSON and returns fallback otherwise', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse('not json', 'FB')).toBe('FB');
    expect(safeJsonParse('', 'FB')).toBe('FB');
    expect(safeJsonParse(null)).toBeNull();
    expect(safeJsonParse(42, 'FB')).toBe('FB'); // non-string
  });
});

describe('maskToken', () => {
  test('masks per length tier', () => {
    expect(maskToken('')).toBe('***');
    expect(maskToken('short')).toBe('sho***'); // <= 10 chars
    expect(maskToken('abcdefghij')).toBe('abc***'); // exactly 10
    expect(maskToken('abcdefghijklmnop')).toBe('abcdef...mnop'); // > 10: head6...tail4
  });
});

describe('tokenHash', () => {
  test('produces a stable sha256 hex digest of the trimmed value', () => {
    const expected = crypto.createHash('sha256').update('secret').digest('hex');
    expect(tokenHash('  secret  ')).toBe(expected);
  });

  test('returns null for empty input', () => {
    expect(tokenHash('')).toBeNull();
    expect(tokenHash(null)).toBeNull();
  });
});

describe('formatIso', () => {
  test('normalizes valid dates to ISO and rejects invalid ones', () => {
    expect(formatIso('2026-01-02T03:04:05.000Z')).toBe('2026-01-02T03:04:05.000Z');
    expect(formatIso(0)).toBeNull(); // falsy
    expect(formatIso('not a date')).toBeNull();
    expect(formatIso(null)).toBeNull();
  });
});

describe('normalizeTokenValue', () => {
  test('coerces to a trimmed string', () => {
    expect(normalizeTokenValue('  tok ')).toBe('tok');
    expect(normalizeTokenValue(null)).toBe('');
    expect(normalizeTokenValue(123)).toBe('123');
  });
});

describe('_isPlaceholderEmail', () => {
  test('rejects placeholder domains, patterns, short/empty', () => {
    expect(_isPlaceholderEmail('user@example.com')).toBe(true);
    expect(_isPlaceholderEmail('admin')).toBe(true); // pattern
    expect(_isPlaceholderEmail('')).toBe(true);
    expect(_isPlaceholderEmail(null)).toBe(true);
    expect(_isPlaceholderEmail('a@b')).toBe(false); // 3 chars, real-ish
  });

  test('accepts a real-looking email', () => {
    expect(_isPlaceholderEmail('real.person@company.io')).toBe(false);
  });
});

describe('isValidEmail', () => {
  test('accepts a structurally valid, non-placeholder email', () => {
    expect(isValidEmail('real.person@company.io')).toBe(true);
    expect(isValidEmail('2578974124@qq.com')).toBe(true);
    expect(isValidEmail('  user.name+tag@sub.domain.co  ')).toBe(true); // trimmed
  });

  test('rejects anything that is not an @-email', () => {
    expect(isValidEmail('john')).toBe(false);        // bare username, no '@'
    expect(isValidEmail('john@local')).toBe(false);  // no dotted domain
    expect(isValidEmail('a@b@c.com')).toBe(false);   // two '@'
    expect(isValidEmail('has space@x.com')).toBe(false); // whitespace
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(123)).toBe(false);           // non-string
  });

  test('rejects placeholder / example emails even when well-formed', () => {
    expect(isValidEmail('user@example.com')).toBe(false); // placeholder domain
    expect(isValidEmail('your_email@test.com')).toBe(false);
  });
});

describe('_isPlaceholderValue', () => {
  test('rejects field-description placeholders and too-short values', () => {
    expect(_isPlaceholderValue('Token')).toBe(true);
    expect(_isPlaceholderValue('your_token')).toBe(true);
    expect(_isPlaceholderValue('x')).toBe(true);
    expect(_isPlaceholderValue('https://example')).toBe(true);
    expect(_isPlaceholderValue('a-real-credential-value')).toBe(false);
  });
});

describe('hasTokenShape / hasLooseTokenShape', () => {
  test('strict shape requires length, no whitespace, safe charset', () => {
    expect(hasTokenShape('abcdef0123456789')).toBe(true); // 16 safe chars
    expect(hasTokenShape('short')).toBe(false);
    expect(hasTokenShape('has space in here xx')).toBe(false);
    expect(hasTokenShape('contains!illegal#chars!!')).toBe(false);
  });

  test('loose shape only requires length and no whitespace', () => {
    expect(hasLooseTokenShape('contains!illegal#chars!!')).toBe(true);
    expect(hasLooseTokenShape('short')).toBe(false);
    expect(hasLooseTokenShape('has space in here xx')).toBe(false);
  });
});

describe('coerceObject', () => {
  test('passes objects through, parses JSON object/array strings, else null', () => {
    const o = { a: 1 };
    expect(coerceObject(o)).toBe(o);
    expect(coerceObject('{"a":1}')).toEqual({ a: 1 });
    expect(coerceObject('[1,2]')).toEqual([1, 2]);
    expect(coerceObject('plain')).toBeNull();
    expect(coerceObject('')).toBeNull();
    expect(coerceObject(42)).toBeNull();
  });
});

describe('decodeMaybeURIComponent', () => {
  test('decodes percent-encoded values, leaves others untouched', () => {
    expect(decodeMaybeURIComponent('a%20b')).toBe('a b');
    expect(decodeMaybeURIComponent('plain')).toBe('plain');
    expect(decodeMaybeURIComponent('%')).toBe('%'); // no valid escape → unchanged
    expect(decodeMaybeURIComponent('bad%ZZ')).toBe('bad%ZZ'); // no %HH match → unchanged
  });
});

describe('parseCallbackPayload', () => {
  test('parses objects, JSON strings, and query strings', () => {
    expect(parseCallbackPayload({ a: 1 })).toEqual({ a: 1 });
    expect(parseCallbackPayload('{"a":1}')).toEqual({ a: 1 });
    expect(parseCallbackPayload('https://cb?token=x&id=7')).toEqual({ token: 'x', id: '7' });
    expect(parseCallbackPayload('token=x')).toEqual({ token: 'x' });
  });

  test('returns empty object for empty / non-parseable input', () => {
    expect(parseCallbackPayload('')).toEqual({});
    expect(parseCallbackPayload(null)).toEqual({});
    expect(parseCallbackPayload('noequalshere')).toEqual({});
  });
});

describe('firstNonEmpty', () => {
  test('returns the first non-empty value (strings trimmed)', () => {
    expect(firstNonEmpty(['', '  ', 'hit', 'next'])).toBe('hit');
    expect(firstNonEmpty([null, undefined, 0])).toBe(0); // 0 stringifies to non-empty
    expect(firstNonEmpty([])).toBeNull();
    expect(firstNonEmpty(['', '   '])).toBeNull();
  });
});

describe('parseBoolean', () => {
  test('parses truthy/falsy tokens and falls back otherwise', () => {
    expect(parseBoolean('yes')).toBe(true);
    expect(parseBoolean('off')).toBe(false);
    expect(parseBoolean('1')).toBe(true);
    expect(parseBoolean('0')).toBe(false);
    expect(parseBoolean('', true)).toBe(true); // empty → fallback
    expect(parseBoolean('maybe', false)).toBe(false); // unrecognized → fallback
  });
});

describe('dedupePaths', () => {
  test('dedupes trimmed paths preserving first-seen order, dropping empties', () => {
    expect(dedupePaths([' /a ', '/a', '/b', '', null, '/b']))
      .toEqual(['/a', '/b']);
    expect(dedupePaths([])).toEqual([]);
  });
});
