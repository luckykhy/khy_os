'use strict';

const parseListToSet = require('../../src/utils/parseListToSet');

describe('parseListToSet', () => {
  test('returns empty set for non-string', () => {
    expect(parseListToSet(null).size).toBe(0);
    expect(parseListToSet(undefined).size).toBe(0);
    expect(parseListToSet(123).size).toBe(0);
  });

  test('parses comma-separated list', () => {
    const result = parseListToSet('a,b,c');
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(true);
    expect(result.has('c')).toBe(true);
  });

  test('parses space-separated list', () => {
    const result = parseListToSet('a b c');
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(true);
    expect(result.has('c')).toBe(true);
  });

  test('converts to lowercase', () => {
    const result = parseListToSet('A,B,C');
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(true);
    expect(result.has('c')).toBe(true);
  });

  test('removes duplicates', () => {
    const result = parseListToSet('a,a,b');
    expect(result.size).toBe(2);
  });

  test('trims whitespace', () => {
    const result = parseListToSet('  a  ,  b  ');
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(true);
  });

  test('handles empty string', () => {
    expect(parseListToSet('').size).toBe(0);
  });
});
