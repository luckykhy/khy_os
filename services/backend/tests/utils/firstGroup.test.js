'use strict';

const firstGroup = require('../../src/utils/firstGroup');

describe('firstGroup', () => {
  test('extracts first capture group', () => {
    expect(firstGroup(/name: (\w+)/, 'name: hello')).toBe('hello');
  });

  test('trims the captured group', () => {
    expect(firstGroup(/name: (\w+)/, 'name:  hello  ')).toBe('hello');
  });

  test('returns empty string for no match', () => {
    expect(firstGroup(/name: (\w+)/, 'no match here')).toBe('');
  });

  test('returns empty string for no capture group', () => {
    expect(firstGroup(/\w+/, 'hello')).toBe('');
  });

  test('returns empty string for non-string input', () => {
    expect(firstGroup(/name: (\w+)/, null)).toBe('');
    expect(firstGroup(/name: (\w+)/, 123)).toBe('');
  });
});
