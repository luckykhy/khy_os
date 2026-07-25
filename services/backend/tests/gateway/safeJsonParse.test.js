'use strict';

/**
 * Tests for gateway/safeJsonParse.js — 3-layer JSON repair utility.
 */

const { safeJsonParse } = require('../../src/services/gateway/safeJsonParse');

describe('safeJsonParse — Layer 1: standard JSON', () => {
  test('parses valid JSON object', () => {
    const result = safeJsonParse('{"key":"value","num":42}');
    expect(result).toEqual({ key: 'value', num: 42 });
  });

  test('parses valid JSON array', () => {
    const result = safeJsonParse('[1,2,3]');
    expect(result).toEqual([1, 2, 3]);
  });

  test('parses JSON string primitives', () => {
    expect(safeJsonParse('"hello"')).toBe('hello');
    expect(safeJsonParse('true')).toBe(true);
    expect(safeJsonParse('null')).toBeNull();
    expect(safeJsonParse('123')).toBe(123);
  });
});

describe('safeJsonParse — Layer 2: repair strategies', () => {
  test('repairs trailing commas in objects', () => {
    const result = safeJsonParse('{"a":1,"b":2,}');
    expect(result).toEqual({ a: 1, b: 2 });
  });

  test('repairs trailing commas in arrays', () => {
    const result = safeJsonParse('[1,2,3,]');
    expect(result).toEqual([1, 2, 3]);
  });

  test('closes unclosed brackets', () => {
    const result = safeJsonParse('{"a":1');
    expect(result).toEqual({ a: 1 });
  });

  test('handles unquoted keys', () => {
    const result = safeJsonParse('{key:"value"}');
    expect(result).toEqual({ key: 'value' });
  });
});

describe('safeJsonParse — Layer 3: fallback', () => {
  test('returns default empty object for empty string', () => {
    const result = safeJsonParse('');
    expect(result).toEqual({});
  });

  test('returns default for null input', () => {
    expect(safeJsonParse(null)).toEqual({});
  });

  test('returns default for undefined input', () => {
    expect(safeJsonParse(undefined)).toEqual({});
  });

  test('returns default for non-string input', () => {
    expect(safeJsonParse(42)).toEqual({});
    expect(safeJsonParse(true)).toEqual({});
  });

  test('returns custom fallback for unparseable garbage', () => {
    const fallback = { error: true };
    const result = safeJsonParse('not json at all {{{{', fallback);
    expect(result).toEqual(fallback);
  });

  test('returns null as custom fallback', () => {
    const result = safeJsonParse('totally broken', null);
    expect(result).toBeNull();
  });
});

describe('safeJsonParse — whitespace handling', () => {
  test('trims leading/trailing whitespace', () => {
    const result = safeJsonParse('  {"a": 1}  ');
    expect(result).toEqual({ a: 1 });
  });

  test('returns fallback for whitespace-only string', () => {
    expect(safeJsonParse('   ')).toEqual({});
  });
});
