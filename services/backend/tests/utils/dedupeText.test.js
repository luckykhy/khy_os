'use strict';

const dedupeText = require('../../src/utils/dedupeText');

describe('dedupeText', () => {
  test('removes duplicate strings', () => {
    expect(dedupeText(['a', 'b', 'a'])).toEqual(['a', 'b']);
  });

  test('trims whitespace from items', () => {
    expect(dedupeText(['  hello  ', 'world'])).toEqual(['hello', 'world']);
  });

  test('removes empty strings', () => {
    expect(dedupeText(['a', '', 'b'])).toEqual(['a', 'b']);
  });

  test('removes whitespace-only strings', () => {
    expect(dedupeText(['a', '   ', 'b'])).toEqual(['a', 'b']);
  });

  test('preserves first occurrence order', () => {
    expect(dedupeText(['c', 'a', 'b', 'a', 'c'])).toEqual(['c', 'a', 'b']);
  });

  test('handles empty array', () => {
    expect(dedupeText([])).toEqual([]);
  });

  test('handles undefined input (uses default)', () => {
    expect(dedupeText()).toEqual([]);
  });

  test('coerces non-string items', () => {
    expect(dedupeText([1, 2, '1'])).toEqual(['1', '2']);
  });

  test('handles all duplicates', () => {
    expect(dedupeText(['a', 'a', 'a'])).toEqual(['a']);
  });

  test('handles mixed types - false becomes empty string after trim', () => {
    const result = dedupeText([true, false, 'true']);
    expect(result).toEqual(['true']);
  });

  test('does not mutate input array', () => {
    const input = ['a', 'b', 'a'];
    dedupeText(input);
    expect(input).toEqual(['a', 'b', 'a']);
  });
});
