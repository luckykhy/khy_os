'use strict';

const { safeJsonParse, strictJsonParse, safeJsonStringify } = require('../../src/utils/safeJsonParse');

describe('safeJsonParse', () => {
  test('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  test('returns fallback for invalid JSON', () => {
    expect(safeJsonParse('invalid')).toBe(null);
    expect(safeJsonParse('invalid', 'default')).toBe('default');
  });

  test('returns fallback for non-string', () => {
    expect(safeJsonParse(123)).toBe(null);
    expect(safeJsonParse(null)).toBe(null);
  });
});

describe('strictJsonParse', () => {
  test('parses valid JSON', () => {
    expect(strictJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  test('throws for invalid JSON', () => {
    expect(() => strictJsonParse('invalid')).toThrow();
  });

  test('throws for non-string', () => {
    expect(() => strictJsonParse(123)).toThrow();
  });
});

describe('safeJsonStringify', () => {
  test('stringifies value', () => {
    expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}');
  });

  test('returns fallback for circular reference', () => {
    const obj = {};
    obj.self = obj;
    expect(safeJsonStringify(obj)).toBe('{}');
  });

  test('supports pretty print', () => {
    expect(safeJsonStringify({ a: 1 }, '{}', true)).toBe('{\n  "a": 1\n}');
  });
});
