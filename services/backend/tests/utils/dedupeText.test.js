'use strict';

const dedupeText = require('../../src/utils/dedupeText');

describe('dedupeText', () => {
  test('removes duplicate items', () => {
    expect(dedupeText(['a', 'b', 'a'])).toEqual(['a', 'b']);
  });

  test('trims items', () => {
    expect(dedupeText(['  a  ', 'b'])).toEqual(['a', 'b']);
  });

  test('removes empty items', () => {
    expect(dedupeText(['a', '', 'b'])).toEqual(['a', 'b']);
  });

  test('preserves order', () => {
    expect(dedupeText(['c', 'a', 'b', 'a'])).toEqual(['c', 'a', 'b']);
  });

  test('handles empty array', () => {
    expect(dedupeText([])).toEqual([]);
  });

  test('handles non-string items', () => {
    expect(dedupeText([1, 2, 1])).toEqual(['1', '2']);
  });
});
