'use strict';

const { resolveTextObject } = require('../../src/vim/textObjects');

// Mock vim/motions.js
jest.mock('../../src/vim/motions', () => ({
  isWordChar: (ch) => /[A-Za-z0-9_]/.test(ch),
  isWhitespace: (ch) => ch === ' ' || ch === '\t',
}));

describe('vim textObjects', () => {
  describe('resolveTextObject', () => {
    test('returns null for empty line', () => {
      expect(resolveTextObject('w', 'i', '', 0)).toBeNull();
    });

    test('returns null for unknown type', () => {
      expect(resolveTextObject('x', 'i', 'hello world', 0)).toBeNull();
    });

    describe('word text object (w)', () => {
      test('selects inner word', () => {
        const result = resolveTextObject('w', 'i', 'hello world', 0);
        expect(result).toEqual({ start: 0, end: 4 });
      });

      test('selects word in middle', () => {
        const result = resolveTextObject('w', 'i', 'hello world', 6);
        expect(result).toEqual({ start: 6, end: 10 });
      });

      test('selects around word with trailing space', () => {
        const result = resolveTextObject('w', 'a', 'hello world', 0);
        expect(result).toEqual({ start: 0, end: 5 });
      });

      test('selects whitespace', () => {
        const result = resolveTextObject('w', 'i', 'hello world', 5);
        expect(result).toEqual({ start: 5, end: 5 });
      });
    });

    describe('WORD text object (W)', () => {
      test('selects inner WORD', () => {
        const result = resolveTextObject('W', 'i', 'hello world', 0);
        expect(result).toEqual({ start: 0, end: 4 });
      });

      test('selects around WORD', () => {
        const result = resolveTextObject('W', 'a', 'hello world', 0);
        expect(result).toEqual({ start: 0, end: 5 });
      });

      test('handles punctuation', () => {
        const result = resolveTextObject('W', 'i', 'hello, world', 0);
        expect(result).toEqual({ start: 0, end: 5 });
      });
    });

    describe('quote text objects', () => {
      test('selects inside double quotes', () => {
        const result = resolveTextObject('"', 'i', 'say "hello" world', 5);
        expect(result).toEqual({ start: 5, end: 9 });
      });

      test('selects around double quotes', () => {
        const result = resolveTextObject('"', 'a', 'say "hello" world', 5);
        expect(result).toEqual({ start: 4, end: 10 });
      });

      test('selects inside single quotes', () => {
        const result = resolveTextObject("'", 'i', "say 'hello' world", 5);
        expect(result).toEqual({ start: 5, end: 9 });
      });

      test('selects inside backticks', () => {
        const result = resolveTextObject('`', 'i', 'say `code` here', 5);
        expect(result).toEqual({ start: 5, end: 8 });
      });

      test('returns null when not in quotes', () => {
        expect(resolveTextObject('"', 'i', 'no quotes here', 0)).toBeNull();
      });
    });

    describe('bracket text objects', () => {
      test('selects inside parentheses', () => {
        const result = resolveTextObject('(', 'i', 'func(arg1, arg2)', 5);
        expect(result).toEqual({ start: 5, end: 14 });
      });

      test('selects around parentheses', () => {
        const result = resolveTextObject('(', 'a', 'func(arg1, arg2)', 5);
        expect(result).toEqual({ start: 4, end: 15 });
      });

      test('selects inside square brackets', () => {
        const result = resolveTextObject('[', 'i', 'arr[0]', 4);
        expect(result).toEqual({ start: 4, end: 4 });
      });

      test('selects inside curly braces', () => {
        const result = resolveTextObject('{', 'i', 'obj{key}', 4);
        expect(result).toEqual({ start: 4, end: 6 });
      });

      test('selects inside angle brackets', () => {
        const result = resolveTextObject('<', 'i', 'List<T>', 5);
        expect(result).toEqual({ start: 5, end: 5 });
      });

      test('handles nested brackets', () => {
        const result = resolveTextObject('(', 'i', 'outer(inner)', 6);
        expect(result).toEqual({ start: 6, end: 10 });
      });

      test('returns null when no matching bracket', () => {
        expect(resolveTextObject('(', 'i', 'no brackets', 0)).toBeNull();
      });

      test('handles cursor on closing bracket', () => {
        const result = resolveTextObject('(', 'i', 'func(arg)', 8);
        expect(result).toEqual({ start: 5, end: 7 });
      });
    });
  });
});
