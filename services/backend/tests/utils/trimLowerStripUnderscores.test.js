'use strict';

const trimLowerStripUnderscores = require('../../src/utils/trimLowerStripUnderscores');

describe('trimLowerStripUnderscores', () => {
  test('trims whitespace', () => {
    expect(trimLowerStripUnderscores('  hello  ')).toBe('hello');
  });

  test('converts to lowercase', () => {
    expect(trimLowerStripUnderscores('HELLO')).toBe('hello');
    expect(trimLowerStripUnderscores('Hello World')).toBe('hello world');
  });

  test('removes underscores', () => {
    expect(trimLowerStripUnderscores('hello_world')).toBe('helloworld');
    expect(trimLowerStripUnderscores('___')).toBe('');
  });

  test('preserves hyphens', () => {
    expect(trimLowerStripUnderscores('hello-world')).toBe('hello-world');
  });

  test('preserves internal spaces', () => {
    expect(trimLowerStripUnderscores('hello world')).toBe('hello world');
  });

  test('handles empty string', () => {
    expect(trimLowerStripUnderscores('')).toBe('');
  });

  test('handles null', () => {
    expect(trimLowerStripUnderscores(null)).toBe('');
  });

  test('handles undefined', () => {
    expect(trimLowerStripUnderscores(undefined)).toBe('');
  });

  test('handles number input', () => {
    expect(trimLowerStripUnderscores(123)).toBe('123');
  });

  test('handles mixed case with underscores', () => {
    expect(trimLowerStripUnderscores('My_Function_Name')).toBe('myfunctionname');
  });

  test('handles leading/trailing underscores', () => {
    expect(trimLowerStripUnderscores('_hello_')).toBe('hello');
  });

  test('handles only underscores', () => {
    expect(trimLowerStripUnderscores('_ _ _')).toBe(' ');
  });

  test('handles consecutive underscores', () => {
    expect(trimLowerStripUnderscores('a__b')).toBe('ab');
  });
});
