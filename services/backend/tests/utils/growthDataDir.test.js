'use strict';

const growthDataDir = require('../../src/utils/growthDataDir');

describe('growthDataDir', () => {
  test('returns a string', () => {
    const result = growthDataDir();
    expect(typeof result).toBe('string');
  });

  test('returns a path', () => {
    const result = growthDataDir();
    expect(result.length).toBeGreaterThan(0);
  });

  test('returns consistent result on multiple calls', () => {
    const result1 = growthDataDir();
    const result2 = growthDataDir();
    expect(result1).toBe(result2);
  });

  test('returns absolute path', () => {
    const result = growthDataDir();
    expect(result.startsWith('/') || /^[A-Za-z]:/.test(result)).toBe(true);
  });
});

