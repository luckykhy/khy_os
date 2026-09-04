'use strict';

const truncateEllipsis = require('../../src/utils/truncateEllipsis');

describe('truncateEllipsis', () => {
  test('returns string as-is when within limit', () => {
    expect(truncateEllipsis('hello', 10)).toBe('hello');
  });

  test('truncates with ellipsis when over limit', () => {
    expect(truncateEllipsis('hello world', 5)).toBe('hell…');
  });

  test('handles exact length', () => {
    expect(truncateEllipsis('hello', 5)).toBe('hello');
  });

  test('handles null', () => {
    expect(truncateEllipsis(null, 5)).toBe('');
  });

  test('handles undefined', () => {
    expect(truncateEllipsis(undefined, 5)).toBe('');
  });

  test('handles empty string', () => {
    expect(truncateEllipsis('', 5)).toBe('');
  });

  test('handles n=0', () => {
    expect(truncateEllipsis('hello', 0)).toBe('…');
  });

  test('handles non-string', () => {
    expect(truncateEllipsis(12345, 3)).toBe('12…');
  });
});
