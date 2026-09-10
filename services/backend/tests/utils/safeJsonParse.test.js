'use strict';

const { safeJsonParse, strictJsonParse, safeJsonStringify } = require('../../src/utils/safeJsonParse');

describe('safeJsonParse', () => {
  test('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  test('returns fallback for invalid JSON', () => {
    expect(safeJsonParse('invalid')).toBeNull();
    expect(safeJsonParse('invalid', 'default')).toBe('default');
  });

  test('returns fallback for non-string input', () => {
    expect(safeJsonParse(null)).toBeNull();
    expect(safeJsonParse(123)).toBeNull();
  });
});

describe('strictJsonParse', () => {
  test('parses valid JSON', () => {
    expect(strictJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  test('throws for invalid JSON', () => {
    expect(() => strictJsonParse('invalid')).toThrow('JSON parse error');
  });

  test('throws for non-string input', () => {
    expect(() => strictJsonParse(null)).toThrow('Input must be a string');
  });
});

describe('safeJsonStringify', () => {
  test('stringifies objects', () => {
    expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}');
  });

  test('returns fallback for circular references', () => {
    const obj = {};
    obj.self = obj;
    expect(safeJsonStringify(obj)).toBe('{}');
  });

  test('pretty prints when requested', () => {
    const result = safeJsonStringify({ a: 1 }, '{}', true);
    expect(result).toContain('\n');
  });
});
