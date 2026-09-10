'use strict';

const { humanBytes } = require('../../src/utils/humanBytes');

describe('humanBytes', () => {
  test('returns 0 B for zero', () => {
    expect(humanBytes(0)).toBe('0 B');
  });

  test('returns 0 B for negative', () => {
    expect(humanBytes(-100)).toBe('0 B');
  });

  test('returns 0 B for NaN', () => {
    expect(humanBytes(NaN)).toBe('0 B');
  });

  test('formats bytes', () => {
    expect(humanBytes(512)).toBe('512 B');
  });

  test('formats KB', () => {
    expect(humanBytes(1536)).toBe('1.5 KB');
  });

  test('formats MB', () => {
    expect(humanBytes(340 * 1024 * 1024)).toBe('340 MB');
  });

  test('formats GB', () => {
    expect(humanBytes(2 * 1024 * 1024 * 1024)).toBe('2 GB');
  });
});
