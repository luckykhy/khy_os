'use strict';

const { deepClone } = require('../../src/utils/deepClone');

describe('deepClone', () => {
  test('clones primitive values', () => {
    expect(deepClone(42)).toBe(42);
    expect(deepClone('hello')).toBe('hello');
    expect(deepClone(null)).toBe(null);
  });

  test('clones arrays', () => {
    const arr = [1, 2, [3, 4]];
    const cloned = deepClone(arr);
    expect(cloned).toEqual(arr);
    expect(cloned).not.toBe(arr);
    expect(cloned[2]).not.toBe(arr[2]);
  });

  test('clones objects', () => {
    const obj = { a: 1, b: { c: 2 } };
    const cloned = deepClone(obj);
    expect(cloned).toEqual(obj);
    expect(cloned).not.toBe(obj);
    expect(cloned.b).not.toBe(obj.b);
  });

  test('clones Date objects', () => {
    const date = new Date('2024-01-01');
    const cloned = deepClone(date);
    expect(cloned).toEqual(date);
    expect(cloned).not.toBe(date);
  });

  test('clones RegExp objects', () => {
    const regex = /test/gi;
    const cloned = deepClone(regex);
    expect(cloned).toEqual(regex);
    expect(cloned).not.toBe(regex);
  });

  test('clones Map objects', () => {
    const map = new Map([['key', { value: 1 }]]);
    const cloned = deepClone(map);
    expect(cloned).not.toBe(map);
    expect(cloned.get('key')).toEqual({ value: 1 });
    expect(cloned.get('key')).not.toBe(map.get('key'));
  });

  test('clones Set objects', () => {
    const set = new Set([1, 2, 3]);
    const cloned = deepClone(set);
    expect(cloned).not.toBe(set);
    expect([...cloned]).toEqual([1, 2, 3]);
  });
});
