'use strict';

const _firstGroup = require('../../src/utils/firstGroup');

describe('firstGroup', () => {
  test('returns captured group', () => {
    expect(_firstGroup(/name: (\w+)/, 'name: hello')).toBe('hello');
  });

  test('trims whitespace from captured group', () => {
    expect(_firstGroup(/name:\s*(\w+)/, 'name:  hello  ')).toBe('hello');
  });

  test('returns empty string for no match', () => {
    expect(_firstGroup(/name: (\w+)/, 'no match here')).toBe('');
  });

  test('returns empty string for null/undefined text', () => {
    expect(_firstGroup(/name: (\w+)/, null)).toBe('');
    expect(_firstGroup(/name: (\w+)/, undefined)).toBe('');
  });

  test('handles capture group with spaces', () => {
    expect(_firstGroup(/name: (.+)/, 'name: John Doe')).toBe('John Doe');
  });

  test('handles multiple capture groups (returns first)', () => {
    expect(_firstGroup(/(\w+) (\w+)/, 'hello world')).toBe('hello');
  });
});
