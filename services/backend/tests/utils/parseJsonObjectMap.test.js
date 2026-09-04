'use strict';

const parseJsonObjectMap = require('../../src/utils/parseJsonObjectMap');

describe('parseJsonObjectMap', () => {
  test('returns empty object for empty string', () => {
    expect(parseJsonObjectMap('')).toEqual({});
    expect(parseJsonObjectMap(null)).toEqual({});
    expect(parseJsonObjectMap(undefined)).toEqual({});
  });

  test('parses valid JSON object', () => {
    expect(parseJsonObjectMap('{"a":1,"b":2}')).toEqual({ a: 1, b: 2 });
  });

  test('returns empty object for invalid JSON', () => {
    expect(parseJsonObjectMap('invalid')).toEqual({});
  });

  test('returns empty object for array', () => {
    expect(parseJsonObjectMap('[1,2,3]')).toEqual({});
  });

  test('returns empty object for null JSON', () => {
    expect(parseJsonObjectMap('null')).toEqual({});
  });

  test('returns empty object for string JSON', () => {
    expect(parseJsonObjectMap('"hello"')).toEqual({});
  });

  test('trims whitespace', () => {
    expect(parseJsonObjectMap('  {"a":1}  ')).toEqual({ a: 1 });
  });
});
